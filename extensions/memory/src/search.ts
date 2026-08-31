import { defineTool, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MEMORY_ABORTED, MEMORY_LIST_COMMAND, MEMORY_SEARCH_COMMAND, MEMORY_SEARCH_TOOL } from "./constants.js";
import { MemoryError } from "./errors.js";
import { characterLength } from "./normalize.js";
import { compactLines, renderMemoryFailure, renderMemoryToolResult } from "./receipt.js";
import type { MemoryListOutcome, MemorySearchOutcome, MemoryService } from "./service.js";
import type { MemoryProvenanceV1, MemoryRecordV1 } from "./store.js";

/**
 * Compact, count-bounded projection of one Memory Record used by search and
 * listing results. It carries enough identity, revision, state, summary,
 * provenance, and timestamps to select the record for an exact `memory_read`
 * without flooding the transcript with every full record content.
 */
export interface MemoryRecordSummaryV1 {
	readonly id: string;
	readonly revision: number;
	readonly state: "active";
	readonly summary: string;
	readonly provenance: MemoryProvenanceV1;
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface MemorySearchHitV1 extends MemoryRecordSummaryV1 {
	/** Integer lexical relevance (see `ranking.ts`); 0 never appears in results. */
	readonly score: number;
}

/** Stable structured result for every successful `memory_search` call. */
export interface MemorySearchResultV1 {
	readonly kind: "memory:search-result";
	readonly version: 1;
	readonly query: string;
	readonly requestedLimit?: number;
	/** The applied record budget: `min(requestedLimit, recall.maxRecords)`. */
	readonly appliedLimit: number;
	/** All active records with a non-zero lexical score. */
	readonly matchedCount: number;
	/** Hits actually returned (`min(matchedCount, appliedLimit)`). */
	readonly returnedCount: number;
	/** Matches beyond the applied record budget, never returned. */
	readonly omittedCount: number;
	/** True when the rendered text hit the character budget. */
	readonly truncated: boolean;
	/** Returned hits dropped from the rendered text by the character budget. */
	readonly truncatedCount: number;
	readonly hits: readonly MemorySearchHitV1[];
}

/** Stable structured result for every successful `memory-list` run. */
export interface MemoryListResultV1 {
	readonly kind: "memory:list-result";
	readonly version: 1;
	readonly requestedLimit?: number;
	readonly appliedLimit: number;
	/** All active records in the Store (recency-ordered before the cap). */
	readonly totalActive: number;
	readonly returnedCount: number;
	readonly omittedCount: number;
	readonly truncated: boolean;
	readonly truncatedCount: number;
	readonly records: readonly MemoryRecordSummaryV1[];
}

export function makeSearchResult(outcome: MemorySearchOutcome): MemorySearchResultV1 {
	return {
		kind: "memory:search-result",
		version: 1,
		query: outcome.query,
		...(outcome.requestedLimit === undefined ? {} : { requestedLimit: outcome.requestedLimit }),
		appliedLimit: outcome.appliedLimit,
		matchedCount: outcome.matchedCount,
		returnedCount: outcome.hits.length,
		omittedCount: Math.max(0, outcome.matchedCount - outcome.hits.length),
		truncated: false,
		truncatedCount: 0,
		hits: outcome.hits.map(({ record, score }) => compactSearchHit(record, score)),
	};
}

export function makeListResult(outcome: MemoryListOutcome): MemoryListResultV1 {
	return {
		kind: "memory:list-result",
		version: 1,
		...(outcome.requestedLimit === undefined ? {} : { requestedLimit: outcome.requestedLimit }),
		appliedLimit: outcome.appliedLimit,
		totalActive: outcome.totalActive,
		returnedCount: outcome.records.length,
		omittedCount: Math.max(0, outcome.totalActive - outcome.records.length),
		truncated: false,
		truncatedCount: 0,
		records: outcome.records.map((record) => compactSummary(record)),
	};
}

function compactSearchHit(record: MemoryRecordV1, score: number): MemorySearchHitV1 {
	return { ...compactSummary(record), score };
}

function compactSummary(record: MemoryRecordV1): MemoryRecordSummaryV1 {
	return {
		id: record.id,
		revision: record.revision,
		state: "active",
		summary: record.summary,
		provenance: record.provenance,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
	};
}

/** Fold any whitespace run (including newlines and tabs) to one space for stable single-line rendering. */
export function singleLine(value: string): string {
	return value.replace(/\s+/gu, " ").trim();
}

function provenanceLine(provenance: MemoryProvenanceV1): string {
	const entry = provenance.entryId === undefined ? "" : ` · entry ${provenance.entryId}`;
	return `Provenance: ${provenance.author} · session ${provenance.sessionId} · ${provenance.directoryId}${entry}`;
}

function searchHitLines(index: number, hit: MemorySearchHitV1): string[] {
	return [
		`${index}. ${hit.id} (revision ${hit.revision} · score ${hit.score} · updated ${hit.updatedAt})`,
		`Summary: ${singleLine(hit.summary)}`,
		provenanceLine(hit.provenance),
	];
}

function listEntryLines(index: number, record: MemoryRecordSummaryV1): string[] {
	return [
		`${index}. ${record.id} (revision ${record.revision} · updated ${record.updatedAt})`,
		`Summary: ${singleLine(record.summary)}`,
		provenanceLine(record.provenance),
	];
}

export interface BoundedTextRender {
	readonly text: string;
	/** Hits in the structured result that the character budget kept out of the text. */
	readonly truncatedCount: number;
}

/**
 * Render the compact search text under an explicit character budget. Returns
 * how many returned hits the budget excluded so the structured result can
 * report the truncation explicitly. Deterministic: hits are consumed in their
 * ranked order and the first hit that does not fit (plus every following one)
 * is counted as truncated.
 */
export function renderSearchResultText(result: MemorySearchResultV1, maxChars: number): BoundedTextRender {
	const omitted = result.omittedCount > 0 ? ` · ${result.omittedCount} omitted` : "";
	const header = `memory_search · ${result.matchedCount} matches for "${singleLine(result.query)}" (limit ${result.appliedLimit}${omitted})`;
	return renderBoundedEntries(header, result.hits, searchHitLines, "match", "matches", maxChars);
}

/** Render the compact active-listing text under the same explicit character budget. */
export function renderListResultText(result: MemoryListResultV1, maxChars: number): BoundedTextRender {
	const omitted = result.omittedCount > 0 ? ` · ${result.omittedCount} omitted` : "";
	const header = `memory-list · ${result.totalActive} active records (limit ${result.appliedLimit}${omitted})`;
	return renderBoundedEntries(header, result.records, listEntryLines, "record", "records", maxChars);
}

function truncateCharacters(value: string, maxChars: number): string {
	const chars = Array.from(value);
	if (chars.length <= maxChars) return value;
	if (maxChars <= 0) return "";
	if (maxChars === 1) return "…";
	return `${chars.slice(0, maxChars - 1).join("")}…`;
}

function renderBoundedEntries<T>(
	header: string,
	entries: readonly T[],
	linesFor: (index: number, entry: T) => string[],
	singularNoun: string,
	pluralNoun: string,
	maxChars: number,
): BoundedTextRender {
	const boundedHeader = truncateCharacters(header, maxChars);
	const parts: string[] = [boundedHeader];
	let total = characterLength(boundedHeader);
	if (boundedHeader !== header) return { text: boundedHeader, truncatedCount: entries.length };
	let truncatedCount = 0;
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		if (entry === undefined) break;
		const text = linesFor(index + 1, entry).join("\n");
		const extra = 1 + characterLength(text);
		if (total + extra > maxChars) {
			truncatedCount = entries.length - index;
			break;
		}
		parts.push(text);
		total += extra;
	}
	if (truncatedCount > 0) {
		const noun = truncatedCount === 1 ? singularNoun : pluralNoun;
		const marker = `… ${truncatedCount} more ${noun} not shown (character budget ${maxChars})`;
		if (total + 1 + characterLength(marker) <= maxChars) parts.push(marker);
	}
	return { text: parts.join("\n"), truncatedCount };
}

export interface MemorySearchToolRuntime {
	readonly service: MemoryService;
	/** Configured `recall.maxChars` budget for the model-visible text. */
	readonly charBudget: number;
}

const MEMORY_SEARCH_PARAMETERS = Type.Object(
	{
		query: Type.String({
			minLength: 1,
			description:
				"Distinctive keywords likely to appear in the record summary or content; matching is lexical, not semantic.",
		}),
		limit: Type.Optional(
			Type.Integer({
				minimum: 1,
				description: "Maximum matches to return; deployment configuration may apply a lower cap.",
			}),
		),
	},
	{ additionalProperties: false },
);

export function registerMemorySearchTool(
	pi: { registerTool(tool: unknown): void },
	runtime: MemorySearchToolRuntime,
): void {
	const { service, charBudget } = runtime;
	pi.registerTool(
		defineTool({
			name: MEMORY_SEARCH_TOOL,
			label: "Search memory",
			description:
				"Search active records in the current Working Directory's Memory Store using deterministic lexical ranking. Returns compact metadata; superseded records are retrievable only through exact `memory_read`.",
			parameters: MEMORY_SEARCH_PARAMETERS,
			promptGuidelines: [
				"Use memory_search when prior directory knowledge may affect the task but is not already in context; call memory_read on each hit you intend to rely on.",
			],
			async execute(_toolCallId, parameters, signal, _onUpdate, context) {
				if (signal?.aborted) throw new MemoryError(MEMORY_ABORTED, "memory search was aborted");
				const outcome = await service.search(
					context,
					{ query: parameters.query, ...(parameters.limit === undefined ? {} : { limit: parameters.limit }) },
					signal,
				);
				const result = makeSearchResult(outcome);
				const rendered = renderSearchResultText(result, charBudget);
				return {
					content: [{ type: "text", text: rendered.text }],
					details: {
						...result,
						truncated: rendered.truncatedCount > 0,
						truncatedCount: rendered.truncatedCount,
					},
				};
			},
			renderCall(args: { readonly query: string; readonly limit?: number }, theme: Theme) {
				const query = args.query.trim();
				const limit = args.limit === undefined ? "" : `${theme.fg("muted", " · ")}limit ${args.limit}`;
				return compactLines([
					`${theme.fg("toolTitle", theme.bold(MEMORY_SEARCH_TOOL))}${query.length === 0 ? "" : ` ${theme.fg("muted", `· ${query}`)}`}${limit}`,
				]);
			},
			renderResult(result, { expanded }, theme, context) {
				return renderMemoryToolResult(result, expanded, theme, context.isError);
			},
		}),
	);
}

const SEARCH_USAGE = `Usage: /${MEMORY_SEARCH_COMMAND} <query...> [--limit <n>]`;

function notify(context: ExtensionContext, text: string, type: "info" | "error" = "info"): void {
	if (!context.hasUI) return;
	try {
		context.ui.notify(text, type);
	} catch {
		// Advisory UI projection must never change Memory semantics.
	}
}

function parsePositiveInteger(token: string): number | undefined {
	if (!/^[0-9]+$/u.test(token)) return undefined;
	const value = Number.parseInt(token, 10);
	return Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}

interface ParsedSearchCommand {
	readonly query: string;
	readonly limit?: number;
}

/**
 * Parse `/memory-search` arguments: all tokens form the query except an
 * explicit `--limit <n>` flag pair, which may appear anywhere between tokens.
 * The flag form is unambiguous for queries that end in or start with numbers.
 */
export function parseSearchCommand(argumentsText: string): ParsedSearchCommand | undefined {
	const tokens = argumentsText
		.trim()
		.split(/\s+/u)
		.filter((token) => token.length > 0);
	const queryTokens: string[] = [];
	let limit: number | undefined;
	let index = 0;
	while (index < tokens.length) {
		const token = tokens[index] ?? "";
		if (token === "--limit") {
			if (limit !== undefined || index + 1 >= tokens.length) return undefined;
			const parsed = parsePositiveInteger(tokens[index + 1] ?? "");
			if (parsed === undefined) return undefined;
			limit = parsed;
			index += 2;
		} else {
			queryTokens.push(token);
			index += 1;
		}
	}
	if (queryTokens.length === 0) return undefined;
	return { query: queryTokens.join(" "), ...(limit === undefined ? {} : { limit }) };
}

/**
 * Convenience command adapter over the exact same bounded Store search the
 * `memory_search` tool uses. It defines no alternate search semantics.
 */
export function registerMemorySearchCommand(pi: ExtensionAPI, runtime: MemorySearchToolRuntime): void {
	const { service, charBudget } = runtime;
	pi.registerCommand(MEMORY_SEARCH_COMMAND, {
		description: `Search the active Memory Records for this Working Directory with bounded lexical ranking and show compact matching records (${SEARCH_USAGE})`,
		async handler(argumentsText, context) {
			const parsed = parseSearchCommand(argumentsText);
			if (parsed === undefined) {
				notify(context, SEARCH_USAGE, "error");
				return;
			}
			try {
				const outcome = await service.search(
					context,
					{ query: parsed.query, ...(parsed.limit === undefined ? {} : { limit: parsed.limit }) },
					context.signal,
				);
				const result = makeSearchResult(outcome);
				const rendered = renderSearchResultText(result, charBudget);
				notify(context, rendered.text, "info");
			} catch (error) {
				notify(context, renderMemoryFailure(error), "error");
			}
		},
	});
}

const LIST_USAGE = `Usage: /${MEMORY_LIST_COMMAND} [<limit>]`;

export type ParsedListCommand = { readonly kind: "ok"; readonly limit?: number } | { readonly kind: "usage" };

/** Parse `/memory-list` arguments: at most one optional positive integer limit. */
export function parseListCommand(argumentsText: string): ParsedListCommand {
	const tokens = argumentsText
		.trim()
		.split(/\s+/u)
		.filter((token) => token.length > 0);
	if (tokens.length === 0) return { kind: "ok" };
	if (tokens.length > 1) return { kind: "usage" };
	const parsed = parsePositiveInteger(tokens[0] ?? "");
	return parsed === undefined ? { kind: "usage" } : { kind: "ok", limit: parsed };
}

/**
 * Active-record listing command: a thin adapter over the same read-only Store
 * path as search and read. Lists only `active` records, most recently updated
 * first, bounded by the same configured record and character budgets.
 */
export function registerMemoryListCommand(pi: ExtensionAPI, runtime: MemorySearchToolRuntime): void {
	const { service, charBudget } = runtime;
	pi.registerCommand(MEMORY_LIST_COMMAND, {
		description: `List the active Memory Records for this Working Directory (most recently updated first, compact, bounded) — ${LIST_USAGE}`,
		async handler(argumentsText, context) {
			const parsed = parseListCommand(argumentsText);
			if (parsed.kind === "usage") {
				notify(context, LIST_USAGE, "error");
				return;
			}
			try {
				const outcome = await service.listActive(
					context,
					{ ...(parsed.limit === undefined ? {} : { limit: parsed.limit }) },
					context.signal,
				);
				const result = makeListResult(outcome);
				const rendered = renderListResultText(result, charBudget);
				notify(context, rendered.text, "info");
			} catch (error) {
				notify(context, renderMemoryFailure(error), "error");
			}
		},
	});
}
