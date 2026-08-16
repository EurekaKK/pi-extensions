import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import type { EvidenceReduction } from "./reducers.js";
import { evidenceStubText } from "./reducers.js";

type AgentMessage = ContextEvent["messages"][number];
type SupersessionReduction = Extract<EvidenceReduction, { readonly kind: "superseded" }>;

export function applyEvidenceReductions(
	messages: readonly AgentMessage[],
	reductions: readonly EvidenceReduction[],
): AgentMessage[] {
	const byToolCall = new Map(reductions.map((reduction) => [reduction.old.toolCallId, reduction]));
	return messages.map((message) => {
		if (message.role !== "toolResult") return structuredClone(message);
		const reduction = byToolCall.get(message.toolCallId);
		if (reduction === undefined) return structuredClone(message);
		return {
			role: "toolResult",
			toolCallId: message.toolCallId,
			toolName: message.toolName,
			content: [{ type: "text", text: evidenceStubText(reduction) }],
			...(message.addedToolNames === undefined ? {} : { addedToolNames: [...message.addedToolNames] }),
			isError: message.isError,
			timestamp: message.timestamp,
		};
	});
}

export function applySupersessionMarkers(
	messages: readonly AgentMessage[],
	reductions: readonly EvidenceReduction[],
): AgentMessage[] {
	const byReplacement = new Map<string, SupersessionReduction[]>();
	for (const reduction of reductions) {
		if (reduction.kind !== "superseded") continue;
		const current = byReplacement.get(reduction.replacement.toolCallId) ?? [];
		current.push(reduction);
		byReplacement.set(reduction.replacement.toolCallId, current);
	}
	return messages.map((message) => {
		if (message.role !== "toolResult") return structuredClone(message);
		const replacements = byReplacement.get(message.toolCallId);
		if (replacements === undefined) return structuredClone(message);
		return {
			...structuredClone(message),
			content: [
				...structuredClone(message.content),
				...replacements.map(
					(reduction) =>
						({
							type: "text",
							text: `\n\n[context-management: ${reduction.old.reference} is superseded by ${reduction.replacement.reference}]`,
						}) as const,
				),
			],
		};
	});
}
