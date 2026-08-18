import { CHECKPOINT_PREAMBLE, COMPACTION_INSTRUCTION, SUMMARY_CLOSE_TAG, SUMMARY_OPEN_TAG } from "../constants.js";
import { estimateTextTokens } from "../runtime/budget.js";

export function frameCheckpoint(summary: string): string {
	const body = stripFraming(summary);
	return `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN_TAG}\n${body}\n${SUMMARY_CLOSE_TAG}`;
}

export function stripFraming(summary: string): string {
	const trimmed = summary.trim();
	const open = trimmed.indexOf(SUMMARY_OPEN_TAG);
	const close = trimmed.lastIndexOf(SUMMARY_CLOSE_TAG);
	if (open >= 0 && close > open) {
		return trimmed.slice(open + SUMMARY_OPEN_TAG.length, close).trim();
	}
	return trimmed;
}

export function estimateInstructionTokens(): number {
	return estimateTextTokens(COMPACTION_INSTRUCTION);
}
