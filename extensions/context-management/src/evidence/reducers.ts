import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { ContextManagementError, throwIfAborted } from "../errors.js";
import { stableJson } from "../stable-json.js";
import type { FinalizedToolPair } from "./references.js";

const BUILT_IN_REDUCERS = new Set(["read", "grep", "find", "ls"]);

export type EvidenceReduction =
	| {
			readonly kind: "duplicate";
			readonly old: FinalizedToolPair;
	  }
	| {
			readonly kind: "superseded";
			readonly old: FinalizedToolPair;
			readonly replacement: FinalizedToolPair;
	  };

async function canonicalPath(cwd: string, value: unknown): Promise<string | null> {
	if (value !== undefined && typeof value !== "string") return null;
	const absolute = resolve(cwd, value ?? ".");
	try {
		return await realpath(absolute);
	} catch {
		return absolute;
	}
}

function exactKeys(input: Readonly<Record<string, unknown>>, allowed: readonly string[]): boolean {
	return Object.keys(input).every((key) => allowed.includes(key));
}

export async function normalizeBuiltInInput(
	pair: FinalizedToolPair,
	cwd: string,
	signal?: AbortSignal,
): Promise<string | null> {
	throwIfAborted(signal);
	if (!BUILT_IN_REDUCERS.has(pair.toolName)) return null;
	const input = pair.input;
	try {
		if (pair.toolName === "read") {
			if (!exactKeys(input, ["path", "offset", "limit"]) || typeof input.path !== "string") return null;
			if (input.offset !== undefined && (!Number.isSafeInteger(input.offset) || (input.offset as number) < 1))
				return null;
			if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || (input.limit as number) < 1)) return null;
			const path = await canonicalPath(cwd, input.path);
			if (path === null) return null;
			throwIfAborted(signal);
			return stableJson({
				limit: input.limit ?? "__absent__",
				offset: input.offset ?? 1,
				path,
			});
		}
		if (pair.toolName === "grep") {
			if (!exactKeys(input, ["pattern", "path", "glob", "ignoreCase", "literal", "context", "limit"])) return null;
			if (typeof input.pattern !== "string") return null;
			if (input.glob !== undefined && typeof input.glob !== "string") return null;
			if (input.ignoreCase !== undefined && typeof input.ignoreCase !== "boolean") return null;
			if (input.literal !== undefined && typeof input.literal !== "boolean") return null;
			if (input.context !== undefined && (!Number.isSafeInteger(input.context) || (input.context as number) < 0))
				return null;
			if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || (input.limit as number) < 1)) return null;
			const path = await canonicalPath(cwd, input.path);
			if (path === null) return null;
			throwIfAborted(signal);
			return stableJson({
				context: input.context ?? 0,
				glob: input.glob ?? "__absent__",
				ignoreCase: input.ignoreCase ?? false,
				limit: input.limit ?? 100,
				literal: input.literal ?? false,
				path,
				pattern: input.pattern,
			});
		}
		if (pair.toolName === "find") {
			if (!exactKeys(input, ["pattern", "path", "limit"]) || typeof input.pattern !== "string") return null;
			if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || (input.limit as number) < 1)) return null;
			const path = await canonicalPath(cwd, input.path);
			if (path === null) return null;
			throwIfAborted(signal);
			return stableJson({
				limit: input.limit ?? 1_000,
				path,
				pattern: input.pattern,
			});
		}
		if (!exactKeys(input, ["path", "limit"])) return null;
		if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || (input.limit as number) < 1)) return null;
		const path = await canonicalPath(cwd, input.path);
		if (path === null) return null;
		throwIfAborted(signal);
		return stableJson({ limit: input.limit ?? 500, path });
	} catch (error) {
		if (error instanceof ContextManagementError && error.code === "context_management.operation_aborted") throw error;
		return null;
	}
}

function isSuccessfulText(pair: FinalizedToolPair): boolean {
	return !pair.isError && pair.content.every((block) => block.type === "text");
}

function hasDifferentContent(left: FinalizedToolPair, right: FinalizedToolPair): boolean {
	return stableJson(left.content) !== stableJson(right.content);
}

export async function planEvidenceReductions(
	pairs: readonly FinalizedToolPair[],
	protectedToolCallIds: ReadonlySet<string>,
	cwd: string,
	signal?: AbortSignal,
): Promise<readonly EvidenceReduction[]> {
	throwIfAborted(signal);
	const reductions = new Map<string, EvidenceReduction>();
	const newestByFingerprint = new Map<string, FinalizedToolPair>();
	for (let index = pairs.length - 1; index >= 0; index -= 1) {
		throwIfAborted(signal);
		const pair = pairs[index];
		if (pair === undefined || pair.fingerprint === null) continue;
		const newer = newestByFingerprint.get(pair.fingerprint);
		if (newer !== undefined && !protectedToolCallIds.has(pair.toolCallId)) {
			reductions.set(pair.toolCallId, { kind: "duplicate", old: pair });
		} else {
			newestByFingerprint.set(pair.fingerprint, pair);
		}
	}

	const newestByBuiltInInput = new Map<string, FinalizedToolPair>();
	for (let index = pairs.length - 1; index >= 0; index -= 1) {
		throwIfAborted(signal);
		const pair = pairs[index];
		if (pair === undefined || !isSuccessfulText(pair)) continue;
		const normalized = await normalizeBuiltInInput(pair, cwd, signal);
		if (normalized === null) continue;
		const key = `${pair.toolName}\u0000${normalized}`;
		const newer = newestByBuiltInInput.get(key);
		if (
			newer !== undefined &&
			hasDifferentContent(pair, newer) &&
			!protectedToolCallIds.has(pair.toolCallId) &&
			!reductions.has(pair.toolCallId)
		) {
			reductions.set(pair.toolCallId, { kind: "superseded", old: pair, replacement: newer });
		} else if (newer === undefined) {
			newestByBuiltInInput.set(key, pair);
		}
	}
	return Object.freeze([...reductions.values()].sort((left, right) => left.old.branchIndex - right.old.branchIndex));
}

export function evidenceStubText(reduction: EvidenceReduction): string {
	return reduction.kind === "duplicate"
		? `[context-management: duplicate evidence ${reduction.old.reference}]`
		: `[context-management: evidence ${reduction.old.reference} superseded by ${reduction.replacement.reference}]`;
}
