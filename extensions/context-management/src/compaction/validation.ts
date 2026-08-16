import type { AssistantMessage } from "@earendil-works/pi-ai";
import { contentText } from "@earendil-works/pi-ai";
import { estimateTextTokens } from "../runtime/budget.js";
import { extractCanonicalEvidenceReferences } from "./source.js";

export type CheckpointValidation =
	| { readonly ok: true; readonly text: string }
	| { readonly ok: false; readonly reason: string };

export function validateCheckpointResponse(
	response: AssistantMessage,
	hardLimit: number,
	allowedEvidenceReferences: ReadonlySet<string>,
): CheckpointValidation {
	if (response.stopReason === "error" || response.stopReason === "aborted") {
		return { ok: false, reason: response.errorMessage ?? `Compactor stopped with ${response.stopReason}.` };
	}
	if (response.stopReason === "length") return { ok: false, reason: "Compactor output reached its length limit." };
	if (response.stopReason !== "stop") {
		return { ok: false, reason: `Compactor returned non-final stop reason ${response.stopReason}.` };
	}
	if (response.content.some((block) => block.type === "toolCall")) {
		return { ok: false, reason: "Compactor returned an unexpected tool call." };
	}
	const text = contentText(response.content).trim();
	if (text.length === 0) return { ok: false, reason: "Compactor returned no visible checkpoint text." };
	const estimate = estimateTextTokens(text);
	if (estimate > hardLimit) {
		return { ok: false, reason: `Checkpoint estimate ${estimate} exceeds hard limit ${hardLimit}.` };
	}
	for (const reference of extractCanonicalEvidenceReferences(text)) {
		if (!allowedEvidenceReferences.has(reference)) {
			return { ok: false, reason: `Checkpoint contains forged or unreachable evidence reference ${reference}.` };
		}
	}
	return { ok: true, text };
}
