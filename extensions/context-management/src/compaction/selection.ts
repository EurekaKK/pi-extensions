import type { ContextEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { entryMessageSpans, type ProtectedTailSelection, selectProtectedTail } from "../runtime/branch.js";

type AgentMessage = ContextEvent["messages"][number];

export interface CompactableSelection {
	readonly newlyEligibleMessages: readonly AgentMessage[];
	readonly previousCheckpoint?: string;
	readonly firstKeptEntryId: string;
	readonly coveredThroughEntryId: string;
	readonly tail: ProtectedTailSelection;
	readonly firstEligibleEntryId: string;
}

function checkpointOffset(messages: readonly AgentMessage[]): number {
	return messages[0]?.role === "compactionSummary" ? 1 : 0;
}

function earliestUnfinalizedIndex(messages: readonly AgentMessage[], start: number, end: number): number | null {
	const calls = new Map<string, { readonly index: number; readonly toolName: string; finalized: boolean }>();
	let earliest: number | null = null;
	for (let index = start; index < end; index += 1) {
		const message = messages[index];
		if (message?.role === "assistant") {
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				const prior = calls.get(block.id);
				if (prior !== undefined) earliest = Math.min(earliest ?? prior.index, prior.index, index);
				else calls.set(block.id, { index, toolName: block.name, finalized: false });
			}
			continue;
		}
		if (message?.role !== "toolResult") continue;
		const call = calls.get(message.toolCallId);
		if (call === undefined || call.finalized || call.toolName !== message.toolName) {
			earliest = Math.min(earliest ?? index, index);
			continue;
		}
		call.finalized = true;
	}
	for (const call of calls.values()) {
		if (!call.finalized) earliest = Math.min(earliest ?? call.index, call.index);
	}
	return earliest;
}

function expandTailToUnsafeUnit(
	messages: readonly AgentMessage[],
	tail: ProtectedTailSelection,
	unsafeIndex: number,
): ProtectedTailSelection {
	const unit = tail.units.find((candidate) => candidate.start <= unsafeIndex && unsafeIndex < candidate.end);
	const startIndex = unit?.start ?? unsafeIndex;
	let estimatedTokens = 0;
	for (const candidate of tail.units) {
		if (candidate.start >= startIndex) estimatedTokens += candidate.estimatedTokens;
	}
	return Object.freeze({
		startIndex,
		messages: Object.freeze(messages.slice(startIndex).map((message) => structuredClone(message))),
		estimatedTokens,
		units: tail.units,
	});
}

export function messageIndexForEntry(entries: readonly SessionEntry[], entryId: string | null): number | null {
	if (entryId === null) return null;
	return entryMessageSpans(entries).find((span) => span.entry.id === entryId)?.start ?? null;
}

export function selectCompactable(input: {
	readonly messages: readonly AgentMessage[];
	readonly contextEntries: readonly SessionEntry[];
	readonly tailTarget: number;
	readonly currentRunEntryId: string | null;
}): CompactableSelection | null {
	const offset = checkpointOffset(input.messages);
	const currentRunIndex = messageIndexForEntry(input.contextEntries, input.currentRunEntryId) ?? input.messages.length;
	let tail = selectProtectedTail(input.messages, input.tailTarget, currentRunIndex);
	const unsafeIndex = earliestUnfinalizedIndex(input.messages, offset, tail.startIndex);
	if (unsafeIndex !== null) tail = expandTailToUnsafeUnit(input.messages, tail, unsafeIndex);
	if (tail.startIndex <= offset || tail.startIndex >= input.messages.length) return null;
	const spans = entryMessageSpans(input.contextEntries);
	const kept = spans.find((span) => span.start <= tail.startIndex && tail.startIndex < span.end);
	if (kept === undefined) return null;
	const firstEligible = spans.find((span) => span.start >= offset && span.start < tail.startIndex);
	if (firstEligible === undefined) return null;
	const covered = [...spans].reverse().find((span) => span.end <= tail.startIndex);
	if (covered === undefined) return null;
	const first = input.messages[0];
	return Object.freeze({
		newlyEligibleMessages: Object.freeze(
			input.messages.slice(offset, tail.startIndex).map((message) => structuredClone(message)),
		),
		...(offset === 1 && first?.role === "compactionSummary" ? { previousCheckpoint: first.summary } : {}),
		firstKeptEntryId: kept.entry.id,
		coveredThroughEntryId: covered.entry.id,
		tail,
		firstEligibleEntryId: firstEligible.entry.id,
	});
}
