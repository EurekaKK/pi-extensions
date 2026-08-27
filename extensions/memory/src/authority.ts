import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MemoryConfigV1 } from "./config.js";
import { MEMORY_RECALL_CUSTOM_TYPE, SUBAGENT_DESCRIPTOR_TYPE } from "./constants.js";

export type MemoryWriteDenialReason = "no-direct-human-turn" | "subagent-context" | "proactive-writes-disabled";

export type MemoryWriteAuthorityResult =
	| { readonly kind: "granted" }
	| { readonly kind: "denied"; readonly reason: MemoryWriteDenialReason };

/**
 * `subagent:descriptor` durable check at write time.
 *
 * The `sub-agent` extension persists a `subagent:descriptor` custom entry on
 * the child session branch. Reading the branch at every write makes the denial
 * durable across extension turns and lifecycle resets, and a branch read
 * failure fails closed (deny) rather than risking an unauthorized write.
 * Reads never consult this check, so subagents keep read/search access.
 */
export function hasSubagentDescriptor(context: ExtensionContext): boolean {
	try {
		for (const entry of context.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === SUBAGENT_DESCRIPTOR_TYPE) return true;
		}
		return false;
	} catch {
		return true;
	}
}

/**
 * Foreground write authority.
 *
 * A direct human `interactive` or `rpc` input grants write authority for the
 * turn; authority resets fail-closed at `agent_settled`, `session_start`,
 * `session_tree`, and `session_shutdown`, so extension-originated follow-up
 * turns and later lifecycle phases start denied. Config denial
 * (`proactiveWrites: false`) and a durable `subagent:descriptor` on the branch
 * deny writes independently of turn state.
 */
export class MemoryWriteAuthority {
	readonly #pi: ExtensionAPI;
	readonly #config: MemoryConfigV1;
	#directHumanTurn = false;
	#expectedRecallContent: string | undefined;

	constructor(pi: ExtensionAPI, config: MemoryConfigV1) {
		this.#pi = pi;
		this.#config = config;
		this.#subscribe();
	}

	/** Admit exactly one Recall message prepared by this extension for the current human run. */
	expectRecallMessage(content: string): void {
		this.#expectedRecallContent = content;
	}

	check(context: ExtensionContext): MemoryWriteAuthorityResult {
		if (!this.#config.proactiveWrites) return { kind: "denied", reason: "proactive-writes-disabled" };
		if (hasSubagentDescriptor(context)) return { kind: "denied", reason: "subagent-context" };
		if (!this.#directHumanTurn) return { kind: "denied", reason: "no-direct-human-turn" };
		return { kind: "granted" };
	}

	#reset(): void {
		this.#directHumanTurn = false;
		this.#expectedRecallContent = undefined;
	}

	#subscribe(): void {
		this.#pi.on("input", (event) => {
			this.#directHumanTurn = event.source === "interactive" || event.source === "rpc";
			this.#expectedRecallContent = undefined;
		});
		this.#pi.on("message_start", (event) => {
			if (event.message.role !== "custom") return;
			const expected = this.#expectedRecallContent;
			this.#expectedRecallContent = undefined;
			// Automatic Recall injects one custom message inside the direct human run
			// that granted authority. Preserve authority only for the exact content
			// this extension just prepared; lookalike or replayed custom messages reset.
			if (
				event.message.customType === MEMORY_RECALL_CUSTOM_TYPE &&
				typeof event.message.content === "string" &&
				event.message.content === expected
			) {
				return;
			}
			this.#reset();
		});
		this.#pi.on("agent_settled", () => this.#reset());
		this.#pi.on("session_start", () => this.#reset());
		this.#pi.on("session_tree", () => this.#reset());
		this.#pi.on("session_shutdown", () => this.#reset());
	}
}
