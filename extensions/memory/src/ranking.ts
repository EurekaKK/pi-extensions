/**
 * Deterministic, model-independent lexical ranking for Memory Record search.
 *
 * Design contract (pinned by regression tests):
 *
 * - Text is folded with NFKC compatibility normalization and lowercase case folding before any
 *   tokenization, so case and punctuation variants converge.
 * - Unicode Latin, combining-mark, and number runs are single tokens; every
 *   other code point is a separator, so punctuation variants such as
 *   `npm-workspaces`, `npm, workspaces`, and `npm workspaces` are identical.
 * - Han (CJK Unified Ideograph) runs emit one token per character plus one
 *   overlapping bigram per adjacent pair; a one-character run emits only the
 *   character token. Mixed CJK/Latin text (`TDD的测试`) and isolated Han
 *   characters are therefore deterministic on both the query and document
 *   side, and a single-Han query can match inside any Han run.
 * - A repeated term amplifies: the score sums, per unique query token, the
 *   query occurrence count times the document occurrence counts
 *   (summary matches weighed `SUMMARY_WEIGHT` times heavier than content
 *   matches). All quantities are integers, so ordering is exact and stable.
 * - Ordering is relevance first (score descending); recency
 *   (`updatedAt`, then `createdAt`, both descending) is only a deterministic
 *   tie-breaker and can never promote an irrelevant record; the final
 *   tie-breakers are `id` ascending and `revision` ascending.
 *
 * No embeddings, vectors, providers, network, or runtime dependencies.
 */

/** How many summary matches one summary occurrence contributes versus content. */
export const SUMMARY_WEIGHT = 2;

/**
 * Han code point ranges covered by the bigram tokenizer. Basic, Extension A,
 * Compatibility, and the supplementary-plane Unified Ideograph extensions B–I
 * (each a strict ascending range; unassigned gaps inside the ranges simply
 * never occur in real text).
 */
const HAN_RANGES: readonly (readonly [number, number])[] = [
	[0x3400, 0x4dbf],
	[0x4e00, 0x9fff],
	[0xf900, 0xfaff],
	[0x20000, 0x2ebef],
	[0x2ebf0, 0x2ee5f],
	[0x30000, 0x3134f],
	[0x31350, 0x323af],
];

/** True when the code point is a Han (CJK Unified Ideograph) character. */
export function isHanCodePoint(codePoint: number): boolean {
	return HAN_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end);
}

/** Unicode Latin letters or numbers start a token; following combining marks stay attached. */
const LATIN_NUMBER_START = /[\p{Script=Latin}\p{Number}]/u;
const LATIN_NUMBER_CONTINUE = /[\p{Script=Latin}\p{Mark}\p{Number}]/u;

/** NFKC compatibility normalization + lowercase case folding shared by queries and records. */
export function foldSearchText(value: string): string {
	return value.normalize("NFKC").toLowerCase();
}

/**
 * Extract the full token sequence (with repetitions) from normalized search
 * text. Latin/number runs become single tokens; Han runs become one token per
 * character plus one overlapping bigram per adjacent pair (a one-character
 * run emits only its character token); every other code point is a separator.
 */
export function extractSearchTokens(value: string): string[] {
	const chars = Array.from(foldSearchText(value));
	const tokens: string[] = [];
	let index = 0;
	while (index < chars.length) {
		const char = chars[index] ?? "";
		if (isHanCodePoint(char.codePointAt(0) ?? 0)) {
			let end = index + 1;
			while (end < chars.length && isHanCodePoint(chars[end]?.codePointAt(0) ?? 0)) end += 1;
			const run = chars.slice(index, end);
			for (let offset = 0; offset < run.length; offset += 1) {
				const current = run[offset] ?? "";
				tokens.push(current);
				const next = run[offset + 1];
				if (next !== undefined) tokens.push(`${current}${next}`);
			}
			index = end;
		} else if (LATIN_NUMBER_START.test(char)) {
			let end = index + 1;
			while (end < chars.length && LATIN_NUMBER_CONTINUE.test(chars[end] ?? "")) end += 1;
			tokens.push(chars.slice(index, end).join(""));
			index = end;
		} else {
			index += 1;
		}
	}
	return tokens;
}

/** Count occurrences per token; the Map preserves insertion order (document order). */
export function countTokenOccurrences(tokens: readonly string[]): ReadonlyMap<string, number> {
	const counts = new Map<string, number>();
	for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
	return counts;
}

/**
 * Integer lexical relevance of one record against one query. The same query
 * token repeated `n` times contributes `n` times; a token found `k` times in
 * a field contributes `k` occurrences (summary occurrences weighed
 * `SUMMARY_WEIGHT`). Zero means no lexical overlap at all.
 */
export function scoreSearchTokens(
	queryCounts: ReadonlyMap<string, number>,
	summaryCounts: ReadonlyMap<string, number>,
	contentCounts: ReadonlyMap<string, number>,
): number {
	let score = 0;
	for (const [token, queryCount] of queryCounts) {
		const summaryHits = summaryCounts.get(token) ?? 0;
		const contentHits = contentCounts.get(token) ?? 0;
		score += queryCount * (SUMMARY_WEIGHT * summaryHits + contentHits);
	}
	return score;
}

interface RecencyIdentity {
	readonly updatedAt: string;
	readonly createdAt: string;
	readonly id: string;
	readonly revision: number;
}

function compareDescending(a: string, b: string): number {
	if (a === b) return 0;
	return a < b ? 1 : -1;
}

/**
 * Stable recency/id/revision order: most recently updated first, then most
 * recently created, then `id` ascending, then `revision` ascending. Used as
 * the primary ordering for the active listing and as the tie-breaker after
 * relevance for search. ISO-8601 UTC timestamps compare lexicographically.
 */
export function compareRecency(a: RecencyIdentity, b: RecencyIdentity): number {
	const updated = compareDescending(a.updatedAt, b.updatedAt);
	if (updated !== 0) return updated;
	const created = compareDescending(a.createdAt, b.createdAt);
	if (created !== 0) return created;
	if (a.id !== b.id) return a.id < b.id ? -1 : 1;
	return a.revision - b.revision;
}
