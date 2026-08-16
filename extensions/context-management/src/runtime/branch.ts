import {
	type ContextEvent,
	estimateTokens,
	type SessionEntry,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";

type AgentMessage = ContextEvent["messages"][number];

export interface ConversationUnit {
	readonly start: number;
	readonly end: number;
	readonly estimatedTokens: number;
}

export interface ProtectedTailSelection {
	readonly startIndex: number;
	readonly messages: readonly AgentMessage[];
	readonly estimatedTokens: number;
	readonly units: readonly ConversationUnit[];
}

function startsUnit(message: AgentMessage): boolean {
	return (
		message.role === "user" ||
		message.role === "custom" ||
		message.role === "bashExecution" ||
		message.role === "branchSummary"
	);
}

export function conversationUnits(messages: readonly AgentMessage[]): readonly ConversationUnit[] {
	if (messages.length === 0) return Object.freeze([]);
	const starts = [0];
	for (let index = 1; index < messages.length; index += 1) {
		const message = messages[index];
		if (message !== undefined && startsUnit(message)) starts.push(index);
	}
	const units: ConversationUnit[] = [];
	for (const [position, start] of starts.entries()) {
		const end = starts[position + 1] ?? messages.length;
		let estimatedTokens = 0;
		for (let index = start; index < end; index += 1) {
			const message = messages[index];
			if (message !== undefined) estimatedTokens += estimateTokens(message) + 4;
		}
		units.push(Object.freeze({ start, end, estimatedTokens }));
	}
	return Object.freeze(units);
}

export function selectProtectedTail(
	messages: readonly AgentMessage[],
	targetTokens: number,
	currentRunStartIndex = messages.length,
): ProtectedTailSelection {
	if (!Number.isFinite(targetTokens) || targetTokens < 0) throw new RangeError("Tail target must be non-negative.");
	const units = conversationUnits(messages);
	if (units.length === 0) {
		return Object.freeze({ startIndex: 0, messages: Object.freeze([]), estimatedTokens: 0, units });
	}
	let startIndex = messages.length;
	let estimatedTokens = 0;
	for (let index = units.length - 1; index >= 0; index -= 1) {
		const unit = units[index];
		if (unit === undefined) continue;
		startIndex = unit.start;
		estimatedTokens += unit.estimatedTokens;
		if (estimatedTokens >= targetTokens && startIndex <= currentRunStartIndex) break;
	}
	if (currentRunStartIndex < startIndex) {
		const containing = units.find((unit) => unit.start <= currentRunStartIndex && currentRunStartIndex < unit.end);
		startIndex = containing?.start ?? Math.max(0, currentRunStartIndex);
		estimatedTokens = 0;
		for (let index = startIndex; index < messages.length; index += 1) {
			const message = messages[index];
			if (message !== undefined) estimatedTokens += estimateTokens(message) + 4;
		}
	}
	return Object.freeze({
		startIndex,
		messages: Object.freeze(messages.slice(startIndex).map((message) => structuredClone(message))),
		estimatedTokens,
		units,
	});
}

export interface EntryMessageSpan {
	readonly entry: SessionEntry;
	readonly start: number;
	readonly end: number;
}

export function entryMessageSpans(entries: readonly SessionEntry[]): readonly EntryMessageSpan[] {
	const spans: EntryMessageSpan[] = [];
	let cursor = 0;
	for (const entry of entries) {
		const count = sessionEntryToContextMessages(entry).length;
		if (count === 0) continue;
		spans.push(Object.freeze({ entry, start: cursor, end: cursor + count }));
		cursor += count;
	}
	return Object.freeze(spans);
}

export function firstKeptEntryId(entries: readonly SessionEntry[], messageIndex: number): string | null {
	const span = entryMessageSpans(entries).find(
		(candidate) => candidate.start <= messageIndex && messageIndex < candidate.end,
	);
	return span?.entry.id ?? null;
}

export function countContextMessages(entries: readonly SessionEntry[]): number {
	return entryMessageSpans(entries).reduce((total, span) => total + (span.end - span.start), 0);
}

export function protectedToolCallIds(messages: readonly AgentMessage[], tailStartIndex: number): ReadonlySet<string> {
	const ids = new Set<string>();
	for (let index = tailStartIndex; index < messages.length; index += 1) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		for (const block of message.content) if (block.type === "toolCall") ids.add(block.id);
	}
	return ids;
}
