import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { MEMORY_RECALL_CUSTOM_TYPE } from "./constants.js";

/**
 * Pure, branch-aware visible-fingerprint collection for automatic Memory
 * Recall (#11).
 *
 * Every recall run reconstructs the set of already model-visible record
 * fingerprints from the CURRENT active branch's structured receipt details —
 * never from display text, never from process memory. Corrupt or foreign
 * entries are ignored fail-soft: a broken receipt can only cause a re-inject
 * (safe direction), never a crash or a wrongly suppressed recall.
 */

/** Full SHA-256 hex shape every stable record fingerprint has. */
export const RECALL_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u;

/**
 * Structural predicate for a v1 Automatic Recall Receipt stored in custom
 * message details. Requires the exact `memory:recall-receipt` kind, version 1,
 * a non-empty Directory identity, a string query, and an array of selections.
 * Inner selection/fingerprint validation is deliberately lenient: a receipt
 * with some corrupt selections still contributes its valid fingerprints.
 */
interface StructuredRecallFingerprintEnvelope {
	readonly selections: readonly unknown[];
}

export function isStructuredRecallReceipt(value: unknown): value is StructuredRecallFingerprintEnvelope {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const details = value as Record<string, unknown>;
	if (details.kind !== MEMORY_RECALL_CUSTOM_TYPE) return false;
	if (details.version !== 1) return false;
	if (typeof details.directory !== "string" || details.directory.length === 0) return false;
	if (typeof details.query !== "string") return false;
	if (!Array.isArray(details.selections)) return false;
	return true;
}

/**
 * Extract the valid stable fingerprints of one structured receipt. Returns
 * `undefined` for anything that is not a structured v1 receipt (fail-soft:
 * the caller ignores it). Within a valid receipt, selection entries with a
 * non-hex fingerprint are skipped individually.
 */
export function extractReceiptFingerprints(value: unknown): readonly string[] | undefined {
	if (!isStructuredRecallReceipt(value)) return undefined;
	const fingerprints: string[] = [];
	for (const selection of value.selections) {
		if (typeof selection !== "object" || selection === null || Array.isArray(selection)) continue;
		const fingerprint = (selection as { readonly fingerprint?: unknown }).fingerprint;
		if (typeof fingerprint === "string" && RECALL_FINGERPRINT_PATTERN.test(fingerprint)) {
			fingerprints.push(fingerprint);
		}
	}
	return fingerprints;
}

/**
 * Collect every visible unchanged-record fingerprint from the model-visible
 * active branch (the exact `buildContextEntries()` projection). Only
 * `custom_message` entries with the exact Memory Recall custom type and
 * structured v1 receipt details contribute; rendered display text is never
 * parsed, and plain custom entries or other extensions' messages never count.
 */
export function collectVisibleRecallFingerprints(
	entries: readonly SessionEntry[],
	customType: string = MEMORY_RECALL_CUSTOM_TYPE,
): ReadonlySet<string> {
	const visible = new Set<string>();
	for (const entry of entries) {
		if (entry.type !== "custom_message" || entry.customType !== customType) continue;
		const fingerprints = extractReceiptFingerprints(entry.details);
		if (fingerprints === undefined) continue;
		for (const fingerprint of fingerprints) visible.add(fingerprint);
	}
	return visible;
}
