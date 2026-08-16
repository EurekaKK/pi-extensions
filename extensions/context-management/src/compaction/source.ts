import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { EVIDENCE_REFERENCE_PREFIX } from "../constants.js";
import type { FinalizedToolPair } from "../evidence/references.js";
import { estimateTextTokens } from "../runtime/budget.js";
import { sha256Hex, stableJson } from "../stable-json.js";

type AgentMessage = ContextEvent["messages"][number];

export interface NormalizedCompactorSource {
	readonly content: readonly (TextContent | ImageContent)[];
	readonly allowedEvidenceReferences: ReadonlySet<string>;
	readonly estimatedTokens: number;
	readonly fingerprintInput: string;
}

function textBlock(text: string): TextContent {
	return { type: "text", text };
}

function data(label: string, value: string): string {
	return `<context-management-data role="${label}">\n${value.replace(/\r\n?/g, "\n")}\n</context-management-data>`;
}

export function buildNormalizedCompactorSource(input: {
	readonly messages: readonly AgentMessage[];
	readonly previousCheckpoint?: string;
	readonly evidencePairs: readonly FinalizedToolPair[];
	readonly supportsImages: boolean;
}): NormalizedCompactorSource {
	const pairByToolCall = new Map(input.evidencePairs.map((pair) => [pair.toolCallId, pair]));
	const reachable = new Set(input.evidencePairs.map((pair) => pair.reference));
	const allowed = new Set<string>();
	const blocks: (TextContent | ImageContent)[] = [];
	const fingerprintParts: string[] = [];

	if (input.previousCheckpoint !== undefined) {
		const serialized = data("previous-checkpoint", input.previousCheckpoint);
		blocks.push(textBlock(`${serialized}\n`));
		fingerprintParts.push(serialized);
		for (const reference of extractCanonicalEvidenceReferences(input.previousCheckpoint)) {
			if (reachable.has(reference)) allowed.add(reference);
		}
	}

	for (const message of input.messages) {
		if (message.role === "assistant") {
			const visible: unknown[] = [];
			for (const block of message.content) {
				if (block.type === "thinking") continue;
				if (block.type === "text") visible.push({ type: "text", text: block.text });
				else visible.push({ type: "toolCall", id: block.id, name: block.name, arguments: block.arguments });
			}
			const serialized = data("assistant", stableJson(visible));
			blocks.push(textBlock(`${serialized}\n`));
			fingerprintParts.push(serialized);
			continue;
		}
		if (message.role === "toolResult") {
			const pair = pairByToolCall.get(message.toolCallId);
			const reference = pair?.reference;
			if (reference !== undefined) allowed.add(reference);
			const header = data(
				"tool-result-metadata",
				stableJson({
					isError: message.isError,
					reference: reference ?? null,
					toolCallId: message.toolCallId,
					toolName: message.toolName,
				}),
			);
			blocks.push(textBlock(`${header}\n`));
			fingerprintParts.push(header);
			for (const block of message.content) {
				if (block.type === "text") {
					const serialized = data("tool-result-content", block.text);
					blocks.push(textBlock(`${serialized}\n`));
					fingerprintParts.push(serialized);
				} else {
					const annotation = `[image content; MIME=${block.mimeType}; evidence=${reference ?? "unreferenced"}]`;
					if (input.supportsImages) {
						blocks.push(textBlock(`${annotation}\n`), structuredClone(block));
					} else {
						blocks.push(textBlock(`${annotation.replace("image content", "image omitted from compactor input")}\n`));
					}
					fingerprintParts.push(
						`[image:${block.mimeType}:${reference ?? "unreferenced"}:sha256:${sha256Hex(block.data)}]`,
					);
				}
			}
			continue;
		}
		if (message.role === "user" || message.role === "custom") {
			if (typeof message.content === "string") {
				const serialized = data(message.role, message.content);
				blocks.push(textBlock(`${serialized}\n`));
				fingerprintParts.push(serialized);
				continue;
			}
			for (const block of message.content) {
				if (block.type === "text") {
					const serialized = data(message.role, block.text);
					blocks.push(textBlock(`${serialized}\n`));
					fingerprintParts.push(serialized);
					continue;
				}
				const annotation = `[image content; role=${message.role}; MIME=${block.mimeType}; evidence=unreferenced]`;
				if (input.supportsImages) blocks.push(textBlock(`${annotation}\n`), structuredClone(block));
				else blocks.push(textBlock(`${annotation.replace("image content", "image omitted from compactor input")}\n`));
				fingerprintParts.push(`[image:${block.mimeType}:unreferenced:sha256:${sha256Hex(block.data)}]`);
			}
			continue;
		}
		if (message.role === "bashExecution") {
			const serialized = data(
				"bash-execution",
				stableJson({
					cancelled: message.cancelled,
					command: message.command,
					exitCode: message.exitCode ?? null,
					output: message.output,
					truncated: message.truncated,
				}),
			);
			blocks.push(textBlock(`${serialized}\n`));
			fingerprintParts.push(serialized);
			continue;
		}
		if (message.role === "branchSummary" || message.role === "compactionSummary") {
			const serialized = data(message.role, message.summary);
			blocks.push(textBlock(`${serialized}\n`));
			fingerprintParts.push(serialized);
		}
	}
	for (const part of fingerprintParts) {
		for (const reference of extractCanonicalEvidenceReferences(part)) {
			if (reachable.has(reference)) allowed.add(reference);
		}
	}

	let estimatedTokens = 0;
	for (const block of blocks) estimatedTokens += block.type === "text" ? estimateTextTokens(block.text) : 1_200;
	return Object.freeze({
		content: Object.freeze(blocks),
		allowedEvidenceReferences: allowed,
		estimatedTokens,
		fingerprintInput: fingerprintParts.join("\n"),
	});
}

export function extractCanonicalEvidenceReferences(text: string): readonly string[] {
	const expression = new RegExp(
		`${EVIDENCE_REFERENCE_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\s<>()[\\]{}]+`,
		"g",
	);
	return Object.freeze(text.match(expression) ?? []);
}
