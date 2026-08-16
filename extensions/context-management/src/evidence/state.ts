import type { ContextEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { EVIDENCE_RECALL_CUSTOM_TYPE } from "../constants.js";
import { throwIfAborted } from "../errors.js";
import { estimateProjection } from "../runtime/budget.js";
import { type FinalizedToolPair, findEvidence, renderEvidenceBlocks } from "./references.js";

type AgentMessage = ContextEvent["messages"][number];

export interface EvidenceAdmissionCandidate {
	readonly requestToolCallId: string;
	readonly requestOrder: number;
	readonly pair: FinalizedToolPair;
	readonly estimatedTokens: number;
}

export interface EvidenceAdmissionFailure {
	readonly reference: string;
	readonly requiredTokens: number;
	readonly safeInput: number;
}

export class EvidenceState {
	readonly #admitted: EvidenceAdmissionCandidate[] = [];
	readonly #pending: EvidenceAdmissionCandidate[] = [];
	readonly #failures = new Map<string, EvidenceAdmissionFailure>();
	#timestamp = Date.now();
	#nextRequestOrder = 0;

	get admitted(): readonly EvidenceAdmissionCandidate[] {
		return Object.freeze([...this.#admitted]);
	}

	get pending(): readonly EvidenceAdmissionCandidate[] {
		return Object.freeze([...this.#pending].sort((left, right) => left.requestOrder - right.requestOrder));
	}

	get failures(): ReadonlyMap<string, EvidenceAdmissionFailure> {
		return this.#failures;
	}

	hasReference(reference: string): boolean {
		return this.#admitted.some((item) => item.pair.reference === reference);
	}

	request(
		requestToolCallId: string,
		entries: readonly SessionEntry[],
		reference: string,
		signal?: AbortSignal,
	): EvidenceAdmissionCandidate {
		throwIfAborted(signal);
		const pair = findEvidence(entries, reference);
		throwIfAborted(signal);
		const blocks = renderEvidenceBlocks(pair);
		throwIfAborted(signal);
		const message: AgentMessage = {
			role: "custom",
			customType: EVIDENCE_RECALL_CUSTOM_TYPE,
			content: [...blocks],
			display: false,
			timestamp: pair.timestamp,
		};
		const candidate = Object.freeze({
			requestToolCallId,
			requestOrder: this.#nextRequestOrder++,
			pair,
			estimatedTokens: estimateProjection([message]),
		});
		this.#pending.push(candidate);
		return candidate;
	}

	admit(candidate: EvidenceAdmissionCandidate): void {
		const index = this.#pending.indexOf(candidate);
		if (index >= 0) this.#pending.splice(index, 1);
		if (!this.#admitted.some((item) => item.pair.reference === candidate.pair.reference)) {
			this.#admitted.push(candidate);
		}
		this.#failures.delete(candidate.requestToolCallId);
	}

	reject(candidate: EvidenceAdmissionCandidate, safeInput: number): void {
		const index = this.#pending.indexOf(candidate);
		if (index >= 0) this.#pending.splice(index, 1);
		this.#failures.set(
			candidate.requestToolCallId,
			Object.freeze({
				reference: candidate.pair.reference,
				requiredTokens: candidate.estimatedTokens,
				safeInput,
			}),
		);
	}

	projectMessage(extra?: EvidenceAdmissionCandidate): AgentMessage | null {
		const items = extra === undefined ? this.#admitted : [...this.#admitted, extra];
		if (items.length === 0) return null;
		return {
			role: "custom",
			customType: EVIDENCE_RECALL_CUSTOM_TYPE,
			content: items.flatMap((item) => [...renderEvidenceBlocks(item.pair), { type: "text" as const, text: "\n\n" }]),
			display: false,
			timestamp: this.#timestamp,
		};
	}

	beginRun(timestamp = Date.now()): void {
		this.clear();
		this.#timestamp = timestamp;
	}

	applyFailures(messages: readonly AgentMessage[]): AgentMessage[] {
		return messages.map((message) => {
			if (message.role !== "toolResult") return structuredClone(message);
			const failure = this.#failures.get(message.toolCallId);
			if (failure === undefined) return structuredClone(message);
			return {
				...structuredClone(message),
				isError: true,
				content: [
					{
						type: "text",
						text: `[context-management: evidence admission failed for ${failure.reference}; required approximately ${failure.requiredTokens} tokens; safe input budget ${failure.safeInput}]`,
					},
				],
			};
		});
	}

	clear(): void {
		this.#admitted.length = 0;
		this.#pending.length = 0;
		this.#failures.clear();
		this.#nextRequestOrder = 0;
	}
}
