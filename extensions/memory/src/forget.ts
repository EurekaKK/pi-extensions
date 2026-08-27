import { defineTool, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { hasSubagentDescriptor, type MemoryWriteAuthority } from "./authority.js";
import { MEMORY_ABORTED, MEMORY_FORGET_COMMAND, MEMORY_FORGET_DENIED, MEMORY_FORGET_TOOL } from "./constants.js";
import { MemoryError } from "./errors.js";
import {
	compactLines,
	makeForgetReceipt,
	renderForgetReceiptText,
	renderMemoryFailure,
	renderMemoryToolResult,
} from "./receipt.js";
import type { MemoryForgetInput, MemoryService } from "./service.js";

export interface MemoryForgetToolRuntime {
	readonly service: MemoryService;
	readonly authority: MemoryWriteAuthority;
}

const MEMORY_FORGET_PARAMETERS = Type.Object(
	{
		id: Type.String({ minLength: 1 }),
		revision: Type.Optional(Type.Integer({ minimum: 1 })),
	},
	{ additionalProperties: false },
);

function forgetInput(input: { readonly id: string; readonly revision?: number }): MemoryForgetInput {
	return input.revision === undefined ? { id: input.id } : { id: input.id, revision: input.revision };
}

export function forgetDenyMessage(reason: "no-direct-human-turn" | "subagent-context"): string {
	switch (reason) {
		case "no-direct-human-turn":
			return "memory_forget requires a direct foreground human turn; extension follow-up, Goal rounds, and unattended turns cannot forget memory.";
		case "subagent-context":
			return "memory_forget is not available to subagents; only the primary foreground Agent can forget directory memory.";
	}
}

/**
 * LLM tool that physically forgets one complete logical supersession chain.
 *
 * Authority mirrors the write path's direct interactive/rpc foreground human
 * turn gate (subagent descriptors and non-direct turns deny), but ignores the
 * `proactiveWrites` config switch: forget is never proactive, so the direct
 * human turn itself is the explicit destructive request.
 */
export function registerMemoryForgetTool(
	pi: { registerTool(tool: unknown): void },
	runtime: MemoryForgetToolRuntime,
): void {
	const { service, authority } = runtime;
	const guidelines = [
		'Use memory_forget only when the user explicitly asks to physically delete a memory (for example "forget that memory", naming the fact, or citing its exact record identity). Never use memory_forget proactively for cleanup, retention, decay, housekeeping, or to reduce Store size.',
		"memory_forget takes the exact record id and optionally its exact revision. It removes the complete connected supersession chain from the Directory Memory Store — every older and newer revision of that one logical fact, active or historical — leaving no tombstone.",
		"memory_forget never edits Pi session history, backups, provider logs, documentation, Git, or Global User Instructions. Its receipt identifies only the removed identities and states the deletion caveat; it never reproduces the deleted content.",
	];
	pi.registerTool(
		defineTool({
			name: MEMORY_FORGET_TOOL,
			label: "Forget memory",
			description:
				"Physically remove one complete Memory Record supersession chain from the Directory Memory Store during a direct foreground human turn. The exact id (optionally with the exact revision) addresses any member of the chain; the entire connected chain — every older and newer connected revision, active or superseded — is removed in one transaction without a content-bearing tombstone. The receipt identifies only the removed identities and honestly warns that copies outside the Store (Pi sessions, backups, provider logs, filesystem snapshots, published documentation, Git history) are not erased. Use only for explicit human forget requests, never as proactive cleanup.",
			parameters: MEMORY_FORGET_PARAMETERS,
			promptGuidelines: guidelines,
			async execute(_toolCallId, parameters, signal, _onUpdate, context) {
				if (signal?.aborted) throw new MemoryError(MEMORY_ABORTED, "memory forget was aborted");
				const status = authority.checkForget(context);
				if (status.kind === "denied") {
					throw new MemoryError(MEMORY_FORGET_DENIED, forgetDenyMessage(status.reason));
				}
				const outcome = await service.forget(context, forgetInput(parameters), signal);
				const receipt = makeForgetReceipt(outcome);
				return {
					content: [{ type: "text", text: renderForgetReceiptText(receipt) }],
					details: receipt,
				};
			},
			renderCall(args: { readonly id: string; readonly revision?: number }, theme: Theme) {
				const revision = args.revision === undefined ? "" : `${theme.fg("muted", ` · revision ${args.revision}`)}`;
				return compactLines([
					`${theme.fg("toolTitle", theme.bold(MEMORY_FORGET_TOOL))} ${theme.fg("muted", `· ${args.id}`)}${revision}`,
				]);
			},
			renderResult(result, { expanded }, theme, context) {
				return renderMemoryToolResult(result, expanded, theme, context.isError);
			},
		}),
	);
}

const FORGET_USAGE = `Usage: /${MEMORY_FORGET_COMMAND} <record-id> [<revision>]`;

function notify(context: ExtensionContext, text: string, type: "info" | "error" = "info"): void {
	if (!context.hasUI) return;
	try {
		context.ui.notify(text, type);
	} catch {
		// Advisory UI projection must never change Memory semantics.
	}
}

function parseRevision(token: string): number | undefined {
	if (!/^[0-9]+$/u.test(token)) return undefined;
	const value = Number.parseInt(token, 10);
	return Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}

/**
 * Convenience command adapter over the exact same Store forget transaction the
 * `memory_forget` tool uses. It defines no alternate deletion semantics.
 *
 * Invoking a user slash command is itself the direct explicit human request:
 * the handler carries the user's authority and never needs the model-turn
 * gate. The command can therefore forget outside a direct `interactive`/`rpc`
 * model turn, exactly like the user asking the Agent to call `memory_forget`
 * in such a turn.
 */
export function registerMemoryForgetCommand(pi: ExtensionAPI, runtime: { readonly service: MemoryService }): void {
	const { service } = runtime;
	pi.registerCommand(MEMORY_FORGET_COMMAND, {
		description: `Physically forget one complete Memory Record supersession chain for this Working Directory by exact record id and optional revision — ${FORGET_USAGE}`,
		async handler(argumentsText, context) {
			if (hasSubagentDescriptor(context)) {
				notify(context, forgetDenyMessage("subagent-context"), "error");
				return;
			}
			const tokens = argumentsText
				.trim()
				.split(/\s+/u)
				.filter((token) => token.length > 0);
			try {
				if (tokens.length === 0 || tokens.length > 2) {
					notify(context, FORGET_USAGE, "error");
					return;
				}
				const id = tokens[0] ?? "";
				let revision: number | undefined;
				if (tokens.length === 2) {
					const parsed = parseRevision(tokens[1] ?? "");
					if (parsed === undefined) {
						notify(context, FORGET_USAGE, "error");
						return;
					}
					revision = parsed;
				}
				const outcome = await service.forget(
					context,
					forgetInput({ id, ...(revision === undefined ? {} : { revision }) }),
					context.signal,
				);
				notify(context, renderForgetReceiptText(makeForgetReceipt(outcome)), "info");
			} catch (error) {
				notify(context, renderMemoryFailure(error), "error");
			}
		},
	});
}
