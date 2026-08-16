import type { ImageContent, TextContent, Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { EVIDENCE_REFERENCE_PREFIX } from "../constants.js";
import { ContextManagementError } from "../errors.js";
import { stableFingerprint, stableJson } from "../stable-json.js";

export interface FinalizedToolPair {
	readonly entryId: string;
	readonly reference: string;
	readonly branchIndex: number;
	readonly toolCallId: string;
	readonly toolName: string;
	readonly input: Readonly<Record<string, unknown>>;
	readonly content: readonly (TextContent | ImageContent)[];
	readonly isError: boolean;
	readonly details: unknown;
	readonly usage: Usage | undefined;
	readonly addedToolNames: readonly string[] | undefined;
	readonly timestamp: number;
	readonly fingerprint: string | null;
}

interface ToolCallSource {
	readonly branchIndex: number;
	readonly toolCallId: string;
	readonly toolName: string;
	readonly input: Readonly<Record<string, unknown>>;
}

export function evidenceReference(entryId: string): string {
	if (entryId.length === 0 || entryId.includes(":")) {
		throw new ContextManagementError(
			"context_management.evidence_reference_invalid",
			`Invalid evidence entry ID ${JSON.stringify(entryId)}.`,
		);
	}
	return `${EVIDENCE_REFERENCE_PREFIX}${entryId}`;
}

export function parseEvidenceReference(reference: string): string {
	if (!reference.startsWith(EVIDENCE_REFERENCE_PREFIX)) {
		throw new ContextManagementError(
			"context_management.evidence_reference_invalid",
			`Evidence reference must start with ${EVIDENCE_REFERENCE_PREFIX}.`,
		);
	}
	const entryId = reference.slice(EVIDENCE_REFERENCE_PREFIX.length);
	if (entryId.length === 0 || entryId.includes(":")) {
		throw new ContextManagementError(
			"context_management.evidence_reference_invalid",
			`Invalid evidence reference ${JSON.stringify(reference)}.`,
		);
	}
	return entryId;
}

function finalizedFingerprint(
	call: ToolCallSource,
	result: {
		readonly content: readonly (TextContent | ImageContent)[];
		readonly isError: boolean;
		readonly details?: unknown;
		readonly usage?: Usage;
		readonly addedToolNames?: readonly string[];
	},
): string | null {
	try {
		return stableFingerprint({
			addedToolNames: result.addedToolNames === undefined ? null : result.addedToolNames,
			content: result.content,
			details: result.details === undefined ? null : result.details,
			input: call.input,
			isError: result.isError,
			toolName: call.toolName,
			usage: result.usage === undefined ? null : result.usage,
		});
	} catch {
		return null;
	}
}

export function indexFinalizedToolPairs(entries: readonly SessionEntry[]): readonly FinalizedToolPair[] {
	const calls = new Map<string, ToolCallSource>();
	const seenCallIds = new Set<string>();
	const invalidCallIds = new Set<string>();
	const results: FinalizedToolPair[] = [];
	for (const [branchIndex, entry] of entries.entries()) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type !== "toolCall") continue;
				if (seenCallIds.has(block.id)) {
					invalidCallIds.add(block.id);
					calls.delete(block.id);
					for (let index = results.length - 1; index >= 0; index -= 1) {
						if (results[index]?.toolCallId === block.id) results.splice(index, 1);
					}
					continue;
				}
				seenCallIds.add(block.id);
				calls.set(block.id, {
					branchIndex,
					toolCallId: block.id,
					toolName: block.name,
					input: block.arguments,
				});
			}
			continue;
		}
		if (message.role !== "toolResult") continue;
		if (invalidCallIds.has(message.toolCallId)) continue;
		const call = calls.get(message.toolCallId);
		if (call === undefined || call.toolName !== message.toolName) continue;
		calls.delete(message.toolCallId);
		const fingerprint = finalizedFingerprint(call, message);
		if (fingerprint === null) continue;
		results.push(
			Object.freeze({
				entryId: entry.id,
				reference: evidenceReference(entry.id),
				branchIndex,
				toolCallId: message.toolCallId,
				toolName: message.toolName,
				input: call.input,
				content: Object.freeze(structuredClone(message.content)),
				isError: message.isError,
				details: structuredClone(message.details),
				usage: message.usage === undefined ? undefined : structuredClone(message.usage),
				addedToolNames: message.addedToolNames === undefined ? undefined : Object.freeze([...message.addedToolNames]),
				timestamp: message.timestamp,
				fingerprint,
			}),
		);
	}
	return Object.freeze(results);
}

export function findEvidence(entries: readonly SessionEntry[], reference: string): FinalizedToolPair {
	const entryId = parseEvidenceReference(reference);
	const match = indexFinalizedToolPairs(entries).find((pair) => pair.entryId === entryId);
	if (match === undefined) {
		throw new ContextManagementError(
			"context_management.evidence_not_reachable",
			`Evidence ${reference} is not a finalized tool result on the current branch.`,
		);
	}
	return match;
}

export function renderReadableInput(input: Readonly<Record<string, unknown>>): string {
	return stableJson(input);
}

export function renderEvidenceBlocks(pair: FinalizedToolPair): readonly (TextContent | ImageContent)[] {
	const header: TextContent = {
		type: "text",
		text: `## Evidence ${pair.reference}\n\n- Tool: ${pair.toolName}\n- Original call: ${renderReadableInput(pair.input)}\n- Error: ${pair.isError ? "yes" : "no"}\n\n`,
	};
	return Object.freeze([header, ...structuredClone(pair.content)]);
}
