import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import type { PruneConfigV1 } from "./config.js";
import { PRUNE_MARKER } from "./constants.js";

type AgentMessage = ContextEvent["messages"][number];
type ToolResultContent = TextContent | ImageContent;

export function codePointLength(text: string): number {
	return Array.from(text).length;
}

export function measureContent(blocks: readonly ToolResultContent[]): number {
	let chars = 0;
	for (const block of blocks) {
		if (block.type === "text") chars += codePointLength(block.text);
	}
	return chars;
}

export function pruneContent(blocks: readonly ToolResultContent[], config: PruneConfigV1): ToolResultContent[] | null {
	const totalChars = measureContent(blocks);
	if (totalChars <= config.thresholdChars) return null;

	const removedStart = config.headChars;
	const removedEnd = totalChars - config.tailChars;
	const pruned: ToolResultContent[] = [];
	let consumed = 0;
	let markerInserted = false;

	for (const block of blocks) {
		if (block.type !== "text") {
			pruned.push(structuredClone(block));
			continue;
		}
		const points = Array.from(block.text);
		const blockStart = consumed;
		const blockEnd = blockStart + points.length;
		const headEnd = Math.min(points.length, Math.max(0, removedStart - blockStart));
		const tailStart = Math.min(points.length, Math.max(0, removedEnd - blockStart));
		const intersectsRemoved = blockStart < removedEnd && blockEnd > removedStart;
		const marker = intersectsRemoved && !markerInserted ? PRUNE_MARKER : "";
		if (marker.length > 0) markerInserted = true;
		const text = points.slice(0, headEnd).join("") + marker + points.slice(tailStart).join("");
		if (text.length > 0) pruned.push({ type: "text", text });
		consumed = blockEnd;
	}

	if (!markerInserted) return null;
	const charsAfter = measureContent(pruned);
	if (charsAfter > config.thresholdChars || charsAfter >= totalChars) return null;
	return pruned;
}

export function applyPruneToMessages(
	messages: readonly AgentMessage[],
	config: PruneConfigV1,
	knownToolCallIds: ReadonlySet<string>,
	pruneOversized: boolean,
): { readonly messages: AgentMessage[]; readonly newlyPrunedIds: readonly string[] } {
	const newlyPrunedIds: string[] = [];
	const next = messages.map((message) => {
		if (message.role !== "toolResult") return structuredClone(message);
		const known = knownToolCallIds.has(message.toolCallId);
		if (!known && !pruneOversized) return structuredClone(message);
		const pruned = pruneContent(message.content, config);
		if (pruned === null) return structuredClone(message);
		if (!known) newlyPrunedIds.push(message.toolCallId);
		return {
			role: "toolResult" as const,
			toolCallId: message.toolCallId,
			toolName: message.toolName,
			content: pruned,
			...(message.addedToolNames === undefined ? {} : { addedToolNames: [...message.addedToolNames] }),
			isError: message.isError,
			timestamp: message.timestamp,
		};
	});
	return Object.freeze({
		messages: next,
		newlyPrunedIds: Object.freeze(newlyPrunedIds),
	});
}
