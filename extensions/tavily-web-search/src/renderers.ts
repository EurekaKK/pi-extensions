import type { AgentToolResult, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { MAX_SNIPPET_CODE_POINTS, MAX_TITLE_CODE_POINTS, MAX_URL_CHARACTERS } from "./constants.js";
import { codePointLength, normalizeToolText, sanitizeExternalText, truncateCodePoints } from "./output.js";
import type { Coverage, OpenMode, RetrievalMode, TitleSource } from "./types.js";

const MAX_CALL_SUMMARY_CODE_POINTS = 120;
const MAX_RENDER_TITLE_CODE_POINTS = 160;
const MAX_RENDER_URL_CODE_POINTS = 240;
const MAX_RENDER_SNIPPET_CODE_POINTS = 500;
const MAX_RENDERED_CONTENT_CODE_POINTS = 12_000;
const MAX_CANDIDATES = 10;
const MAX_IDENTIFIER_CODE_POINTS = 256;
const MAX_TIMESTAMP_CODE_POINTS = 64;
const MAX_DIAGNOSTIC_COUNT = 1_000_000;
const MAX_NUMERIC_VALUE = 1_000_000_000_000;

type RenderColor = "accent" | "dim" | "error" | "muted" | "success" | "toolOutput" | "toolTitle" | "warning";

export interface RendererTheme {
	fg(color: RenderColor, text: string): string;
	bold(text: string): string;
}

export interface CallRenderContext {
	readonly argsComplete: boolean;
}

export interface ResultRenderContext {
	readonly isError: boolean;
}

interface SearchCallView {
	readonly query: string;
}

interface OpenCallView {
	readonly label?: string;
	readonly mode: OpenMode | "next_page";
}

interface CandidateView {
	readonly refId: string;
	readonly rank: number;
	readonly title: string;
	readonly url: string;
	readonly snippet: string;
	readonly contentTruncated: boolean;
}

interface SearchDetailsView {
	readonly query: string;
	readonly retrievalMode: "live" | "cache";
	readonly cacheAgeSeconds?: number;
	readonly durationMs: number;
	readonly usageCredits: number;
	readonly usageEstimated: boolean;
	readonly creditContractOverrun: boolean;
	readonly candidateCount: number;
	readonly candidates: readonly CandidateView[];
}

interface OpenDetailsView {
	readonly refId: string;
	readonly title: string;
	readonly url: string;
	readonly mode: OpenMode;
	readonly coverage: Coverage;
	readonly page: number;
	readonly hasMore: boolean;
	readonly characterCount: number;
	readonly retrievalMode: RetrievalMode;
	readonly cacheAgeSeconds?: number;
	readonly durationMs: number;
	readonly usageCredits: number;
	readonly usageEstimated: boolean;
	readonly creditContractOverrun: boolean;
	readonly documentTruncated: boolean;
	readonly renderedContent: string;
}

const SEARCH_DETAIL_KEYS = [
	"tavily_details_version",
	"tavily_operation_id",
	"tavily_query",
	"tavily_retrieval_mode",
	"tavily_retrieved_at",
	"tavily_duration_ms",
	"tavily_usage_credits",
	"tavily_usage_estimated",
	"tavily_credit_contract_overrun",
	"tavily_candidate_count",
	"tavily_candidates",
	"tavily_refs",
	"tavily_input_result_count",
	"tavily_malformed_result_count",
	"tavily_rejected_url_count",
	"tavily_policy_rejected_count",
	"tavily_duplicate_count",
] as const;

const OPEN_DETAIL_KEYS = [
	"tavily_details_version",
	"tavily_operation_id",
	"tavily_ref_id",
	"tavily_title",
	"tavily_title_truncated",
	"tavily_url",
	"tavily_title_source",
	"tavily_mode",
	"tavily_coverage",
	"tavily_page",
	"tavily_has_more",
	"tavily_character_count",
	"tavily_retrieval_mode",
	"tavily_retrieved_at",
	"tavily_duration_ms",
	"tavily_usage_credits",
	"tavily_usage_estimated",
	"tavily_credit_contract_overrun",
	"tavily_url_changed",
	"tavily_document_truncated",
	"tavily_rendered_content",
] as const;

const CANDIDATE_KEYS = [
	"tavily_ref_id",
	"tavily_rank",
	"tavily_title",
	"tavily_title_truncated",
	"tavily_url",
	"tavily_hostname",
	"tavily_snippet",
	"tavily_snippet_truncated",
	"tavily_content_truncated",
] as const;
const REF_KEYS = [
	"tavily_details_version",
	...CANDIDATE_KEYS,
	"tavily_originating_query",
	"tavily_retrieved_at",
	"tavily_freshness",
	"tavily_policy_allow",
	"tavily_policy_deny",
] as const;

export function renderSearchCall(args: unknown, theme: RendererTheme, context: CallRenderContext): Text {
	if (!context.argsComplete) {
		return textComponent(theme.fg("toolTitle", theme.bold("Tavily Search …")));
	}

	const view = parseSearchCall(args);
	if (!view) return invalidCall("Tavily Search", theme);

	return textComponent(
		`${theme.fg("toolTitle", theme.bold("Tavily Search "))}${theme.fg("accent", JSON.stringify(view.query))}`,
	);
}

export function renderOpenCall(args: unknown, theme: RendererTheme, context: CallRenderContext): Text {
	if (!context.argsComplete) {
		return textComponent(theme.fg("toolTitle", theme.bold("Tavily Open …")));
	}

	const view = parseOpenCall(args);
	if (!view) return invalidCall("Tavily Open", theme);
	const mode = view.mode === "next_page" ? "next page" : view.mode;
	const label = view.label === undefined ? "" : ` ${theme.fg("accent", view.label)}`;
	return textComponent(`${theme.fg("toolTitle", theme.bold("Tavily Open"))}${label}${theme.fg("dim", ` · ${mode}`)}`);
}

export function renderSearchResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: RendererTheme,
	context: ResultRenderContext,
): Text {
	if (context.isError) return failedResult("Tavily Search", theme);
	if (options.isPartial) return textComponent(theme.fg("warning", "Tavily Search is running…"));

	const details = safelyParseDetails(result, parseSearchDetails);
	if (!details) return genericResult("Tavily Search", theme);

	let rendered = theme.fg("success", theme.bold("Tavily Search"));
	rendered += ` ${theme.fg("accent", JSON.stringify(details.query))}`;
	rendered += theme.fg(
		"dim",
		` · ${details.candidateCount} ${details.candidateCount === 1 ? "candidate" : "candidates"}` +
			` · ${formatRetrieval(details.retrievalMode, details.cacheAgeSeconds)}` +
			` · ${formatDuration(details.durationMs)}` +
			` · ${formatCredits(details.usageCredits)}` +
			formatUsageFlags(details.usageEstimated, details.creditContractOverrun),
	);

	if (options.expanded) {
		rendered += `\n${theme.fg("warning", "untrusted web content — candidates only; inspect before relying or citing")}`;
		if (details.candidates.length === 0) {
			rendered += `\n${theme.fg("muted", "No candidates returned.")}`;
		}
		for (const candidate of details.candidates) {
			const truncation = candidate.contentTruncated ? " · truncated" : "";
			rendered += `\n${theme.fg("toolOutput", `[${candidate.rank}] ${candidate.refId} — ${candidate.title}`)}`;
			rendered += `\n${theme.fg("dim", `    ${candidate.url}`)}`;
			if (candidate.snippet.length > 0) {
				rendered += `\n${theme.fg("toolOutput", `    ${candidate.snippet}`)}`;
			}
			if (truncation.length > 0) rendered += theme.fg("warning", truncation);
		}
	}

	return textComponent(rendered);
}

export function renderOpenResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: RendererTheme,
	context: ResultRenderContext,
): Text {
	if (context.isError) return failedResult("Tavily Open", theme);
	if (options.isPartial) return textComponent(theme.fg("warning", "Tavily Open is running…"));

	const details = safelyParseDetails(result, parseOpenDetails);
	if (!details) return genericResult("Tavily Open", theme);

	let rendered = theme.fg("success", theme.bold("Tavily Open"));
	rendered += ` ${theme.fg("accent", details.refId)}`;
	rendered += theme.fg(
		"dim",
		` · ${details.title}` +
			` · ${details.mode}` +
			` · ${details.coverage}` +
			` · page ${details.page}` +
			` · ${details.characterCount} chars` +
			` · ${formatRetrieval(details.retrievalMode, details.cacheAgeSeconds)}` +
			` · ${formatDuration(details.durationMs)}` +
			` · ${formatCredits(details.usageCredits)}` +
			formatUsageFlags(details.usageEstimated, details.creditContractOverrun) +
			(details.hasMore ? " · more pages" : "") +
			(details.documentTruncated ? " · document truncated" : ""),
	);

	if (options.expanded) {
		rendered += `\n${theme.fg("dim", details.url)}`;
		rendered += `\n${theme.fg("warning", "untrusted web content")}`;
		rendered += `\n${theme.fg("toolOutput", details.renderedContent)}`;
	}

	return textComponent(rendered);
}

function parseSearchCall(value: unknown): SearchCallView | undefined {
	try {
		if (
			!isRecord(value) ||
			!hasExactKeys(value, ["query"], ["include_domains", "exclude_domains", "recency", "freshness"])
		) {
			return undefined;
		}
		if (!isOptionalDomainArray(value.include_domains) || !isOptionalDomainArray(value.exclude_domains))
			return undefined;
		if (!isOptionalEnum(value.recency, ["day", "week", "month", "year"])) return undefined;
		if (!isOptionalEnum(value.freshness, ["cache_ok", "live"])) return undefined;
		if (typeof value.query !== "string") return undefined;
		const query = normalizeToolText(value.query, "query");
		return { query: summarizeInline(query, MAX_CALL_SUMMARY_CODE_POINTS) };
	} catch {
		return undefined;
	}
}

function parseOpenCall(value: unknown): OpenCallView | undefined {
	try {
		if (!isRecord(value) || !hasExactKeys(value, [], ["ref_id", "mode", "focus", "cursor"])) return undefined;
		if (value.cursor !== undefined) {
			if (Object.keys(value).length !== 1 || !isCursor(value.cursor)) return undefined;
			return { mode: "next_page" };
		}
		if (!isRefId(value.ref_id) || !isOptionalEnum(value.mode, ["focused", "full"])) return undefined;
		const mode = value.mode ?? "focused";
		if (value.focus !== undefined) {
			if (mode !== "focused" || typeof value.focus !== "string") return undefined;
			normalizeToolText(value.focus, "focus");
		}
		return { label: value.ref_id, mode };
	} catch {
		return undefined;
	}
}

function parseSearchDetails(value: unknown): SearchDetailsView | undefined {
	try {
		if (!isRecord(value) || !hasExactKeys(value, SEARCH_DETAIL_KEYS, ["tavily_cache_age_seconds"])) return undefined;
		if (
			value.tavily_details_version !== 1 ||
			!isOperationId(value.tavily_operation_id) ||
			typeof value.tavily_query !== "string" ||
			(value.tavily_retrieval_mode !== "live" && value.tavily_retrieval_mode !== "cache") ||
			!isTimestamp(value.tavily_retrieved_at) ||
			!isBoundedNumber(value.tavily_duration_ms) ||
			!isBoundedNumber(value.tavily_usage_credits) ||
			typeof value.tavily_usage_estimated !== "boolean" ||
			typeof value.tavily_credit_contract_overrun !== "boolean" ||
			!isBoundedInteger(value.tavily_candidate_count, MAX_CANDIDATES) ||
			!Array.isArray(value.tavily_candidates) ||
			!Array.isArray(value.tavily_refs) ||
			!isBoundedInteger(value.tavily_input_result_count, MAX_DIAGNOSTIC_COUNT) ||
			!isBoundedInteger(value.tavily_malformed_result_count, MAX_DIAGNOSTIC_COUNT) ||
			!isBoundedInteger(value.tavily_rejected_url_count, MAX_DIAGNOSTIC_COUNT) ||
			!isBoundedInteger(value.tavily_policy_rejected_count, MAX_DIAGNOSTIC_COUNT) ||
			!isBoundedInteger(value.tavily_duplicate_count, MAX_DIAGNOSTIC_COUNT)
		) {
			return undefined;
		}
		const cacheAge = parseCacheAge(value.tavily_retrieval_mode, value.tavily_cache_age_seconds);
		if (cacheAge === null) return undefined;
		const normalizedQuery = normalizeToolText(value.tavily_query, "query");
		if (value.tavily_candidates.length > MAX_CANDIDATES || value.tavily_refs.length > MAX_CANDIDATES) return undefined;

		const candidates: CandidateView[] = [];
		const candidateRefs = new Set<string>();
		for (const rawCandidate of value.tavily_candidates) {
			const candidate = parseCandidate(rawCandidate);
			if (!candidate || candidateRefs.has(candidate.refId)) return undefined;
			candidateRefs.add(candidate.refId);
			candidates.push(candidate);
		}
		if (value.tavily_candidate_count !== candidates.length) return undefined;

		const persistedRefs = new Set<string>();
		for (const rawRef of value.tavily_refs) {
			const refId = parseRef(rawRef);
			if (!refId || persistedRefs.has(refId)) return undefined;
			persistedRefs.add(refId);
		}

		return {
			query: summarizeInline(normalizedQuery, MAX_CALL_SUMMARY_CODE_POINTS),
			retrievalMode: value.tavily_retrieval_mode,
			...(cacheAge === undefined ? {} : { cacheAgeSeconds: cacheAge }),
			durationMs: value.tavily_duration_ms,
			usageCredits: value.tavily_usage_credits,
			usageEstimated: value.tavily_usage_estimated,
			creditContractOverrun: value.tavily_credit_contract_overrun,
			candidateCount: candidates.length,
			candidates,
		};
	} catch {
		return undefined;
	}
}

function parseOpenDetails(value: unknown): OpenDetailsView | undefined {
	try {
		if (
			!isRecord(value) ||
			!hasExactKeys(value, OPEN_DETAIL_KEYS, ["tavily_cache_age_seconds", "tavily_next_cursor"])
		) {
			return undefined;
		}
		if (
			value.tavily_details_version !== 1 ||
			!isOperationId(value.tavily_operation_id) ||
			!isRefId(value.tavily_ref_id) ||
			typeof value.tavily_title !== "string" ||
			typeof value.tavily_title_truncated !== "boolean" ||
			!isTitleSource(value.tavily_title_source) ||
			(value.tavily_mode !== "focused" && value.tavily_mode !== "full") ||
			!isCoverage(value.tavily_coverage) ||
			!isPositiveInteger(value.tavily_page) ||
			typeof value.tavily_has_more !== "boolean" ||
			!isBoundedInteger(value.tavily_character_count, MAX_RENDERED_CONTENT_CODE_POINTS) ||
			!isRetrievalMode(value.tavily_retrieval_mode) ||
			!isTimestamp(value.tavily_retrieved_at) ||
			!isBoundedNumber(value.tavily_duration_ms) ||
			!isBoundedNumber(value.tavily_usage_credits) ||
			typeof value.tavily_usage_estimated !== "boolean" ||
			typeof value.tavily_credit_contract_overrun !== "boolean" ||
			typeof value.tavily_url_changed !== "boolean" ||
			typeof value.tavily_document_truncated !== "boolean" ||
			typeof value.tavily_rendered_content !== "string"
		) {
			return undefined;
		}
		const cacheAge = parseCacheAge(value.tavily_retrieval_mode, value.tavily_cache_age_seconds);
		if (cacheAge === null) return undefined;
		const title = boundedExternalInline(value.tavily_title, MAX_TITLE_CODE_POINTS, MAX_RENDER_TITLE_CODE_POINTS);
		const url = parseUrl(value.tavily_url);
		const renderedContent = boundedExternalBlock(value.tavily_rendered_content, MAX_RENDERED_CONTENT_CODE_POINTS);
		if (!title || !url || !renderedContent) return undefined;
		if (value.tavily_character_count !== codePointLength(value.tavily_rendered_content)) return undefined;
		if (value.tavily_has_more !== (value.tavily_next_cursor !== undefined)) return undefined;
		if (value.tavily_next_cursor !== undefined && !isCursor(value.tavily_next_cursor)) return undefined;
		if (value.tavily_mode === "focused") {
			if (
				value.tavily_coverage !== "focused_partial" ||
				value.tavily_page !== 1 ||
				value.tavily_has_more ||
				value.tavily_document_truncated
			) {
				return undefined;
			}
		} else {
			const expectedCoverage = value.tavily_document_truncated ? "snapshot_truncated" : "snapshot_complete";
			if (value.tavily_coverage !== expectedCoverage) return undefined;
		}
		if (value.tavily_retrieval_mode === "cursor" && value.tavily_page < 2) return undefined;
		if (value.tavily_url_changed && value.tavily_title_source !== "resolved_hostname") return undefined;

		return {
			refId: value.tavily_ref_id,
			title,
			url: summarizeInline(url, MAX_RENDER_URL_CODE_POINTS),
			mode: value.tavily_mode,
			coverage: value.tavily_coverage,
			page: value.tavily_page,
			hasMore: value.tavily_has_more,
			characterCount: value.tavily_character_count,
			retrievalMode: value.tavily_retrieval_mode,
			...(cacheAge === undefined ? {} : { cacheAgeSeconds: cacheAge }),
			durationMs: value.tavily_duration_ms,
			usageCredits: value.tavily_usage_credits,
			usageEstimated: value.tavily_usage_estimated,
			creditContractOverrun: value.tavily_credit_contract_overrun,
			documentTruncated: value.tavily_document_truncated,
			renderedContent,
		};
	} catch {
		return undefined;
	}
}

function parseCandidate(value: unknown): CandidateView | undefined {
	if (!isRecord(value) || !hasExactKeys(value, CANDIDATE_KEYS, [])) return undefined;
	if (
		!isRefId(value.tavily_ref_id) ||
		!isBoundedInteger(value.tavily_rank, MAX_CANDIDATES) ||
		value.tavily_rank < 1 ||
		typeof value.tavily_title !== "string" ||
		typeof value.tavily_title_truncated !== "boolean" ||
		typeof value.tavily_snippet !== "string" ||
		typeof value.tavily_snippet_truncated !== "boolean" ||
		typeof value.tavily_hostname !== "string" ||
		typeof value.tavily_content_truncated !== "boolean"
	) {
		return undefined;
	}
	const title = boundedExternalInline(value.tavily_title, MAX_TITLE_CODE_POINTS, MAX_RENDER_TITLE_CODE_POINTS);
	const snippet = boundedExternalInline(
		value.tavily_snippet,
		MAX_SNIPPET_CODE_POINTS,
		MAX_RENDER_SNIPPET_CODE_POINTS,
		true,
	);
	const url = parseUrl(value.tavily_url, value.tavily_hostname);
	if (!title || snippet === undefined || !url) return undefined;
	return {
		refId: value.tavily_ref_id,
		rank: value.tavily_rank,
		title,
		url: summarizeInline(url, MAX_RENDER_URL_CODE_POINTS),
		snippet,
		contentTruncated: value.tavily_content_truncated,
	};
}

function parseRef(value: unknown): string | undefined {
	if (!isRecord(value) || !hasExactKeys(value, REF_KEYS, ["tavily_freshness_not_before"])) return undefined;
	const candidateFields = {
		tavily_ref_id: value.tavily_ref_id,
		tavily_rank: value.tavily_rank,
		tavily_title: value.tavily_title,
		tavily_title_truncated: value.tavily_title_truncated,
		tavily_url: value.tavily_url,
		tavily_hostname: value.tavily_hostname,
		tavily_snippet: value.tavily_snippet,
		tavily_snippet_truncated: value.tavily_snippet_truncated,
		tavily_content_truncated: value.tavily_content_truncated,
	};
	if (
		value.tavily_details_version !== 1 ||
		!parseCandidate(candidateFields) ||
		typeof value.tavily_originating_query !== "string" ||
		!isTimestamp(value.tavily_retrieved_at) ||
		(value.tavily_freshness !== "cache_ok" && value.tavily_freshness !== "live") ||
		!isDomainArray(value.tavily_policy_allow) ||
		!isDomainArray(value.tavily_policy_deny) ||
		(value.tavily_freshness_not_before !== undefined && !isBoundedNumber(value.tavily_freshness_not_before))
	) {
		return undefined;
	}
	try {
		normalizeToolText(value.tavily_originating_query, "query");
	} catch {
		return undefined;
	}
	return typeof value.tavily_ref_id === "string" ? value.tavily_ref_id : undefined;
}

function parseCacheAge(mode: "live" | "cache" | "cursor", value: unknown): number | undefined | null {
	if (mode === "cache") return isBoundedNumber(value) ? value : null;
	return value === undefined ? undefined : null;
}

function parseUrl(value: unknown, expectedHostname?: string): string | undefined {
	if (typeof value !== "string" || codePointLength(value) > MAX_URL_CHARACTERS) return undefined;
	if (sanitizeExternalText(value) !== value) return undefined;
	try {
		const parsed = new URL(value);
		if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.username || parsed.password)
			return undefined;
		if (expectedHostname !== undefined && parsed.hostname !== expectedHostname) return undefined;
		return value;
	} catch {
		return undefined;
	}
}

function boundedExternalInline(
	value: string,
	rawMaximum: number,
	renderMaximum: number,
	allowEmpty = false,
): string | undefined {
	if (codePointLength(value) > rawMaximum) return undefined;
	const singleLine = sanitizeExternalText(value).replace(/\s+/gu, " ").trim();
	if (!allowEmpty && singleLine.length === 0) return undefined;
	return summarizeInline(singleLine, renderMaximum);
}

function boundedExternalBlock(value: string, maximum: number): string | undefined {
	if (codePointLength(value) > maximum) return undefined;
	const sanitized = sanitizeExternalText(value).trim();
	if (sanitized.length === 0) return undefined;
	return truncateCodePoints(sanitized, maximum).value;
}

function summarizeInline(value: string, maximum: number): string {
	const singleLine = value.replace(/\s+/gu, " ").trim();
	const truncated = truncateCodePoints(singleLine, maximum);
	return truncated.truncated ? `${truncateCodePoints(singleLine, Math.max(0, maximum - 1)).value}…` : truncated.value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
	value: Record<string, unknown>,
	required: readonly string[],
	optional: readonly string[],
): boolean {
	const allowed = new Set([...required, ...optional]);
	const keys = Object.keys(value);
	return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key));
}

function isOptionalDomainArray(value: unknown): boolean {
	return value === undefined || isDomainArray(value);
}

function isDomainArray(value: unknown): value is readonly string[] {
	return (
		Array.isArray(value) &&
		value.length <= 20 &&
		value.every((item) => typeof item === "string" && item.length > 0 && codePointLength(item) <= 512)
	);
}

function isOptionalEnum<const T extends readonly string[]>(value: unknown, values: T): value is T[number] | undefined {
	return value === undefined || (typeof value === "string" && values.includes(value));
}

function isRefId(value: unknown): value is string {
	return typeof value === "string" && /^tavily_ref_[1-9][0-9]*$/u.test(value) && codePointLength(value) <= 64;
}

function isCursor(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^tavily_cursor_[A-Za-z0-9_-]+$/u.test(value) &&
		codePointLength(value) <= MAX_IDENTIFIER_CODE_POINTS
	);
}

function isOperationId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		/^tavily_operation_[A-Za-z0-9_-]+$/u.test(value) &&
		codePointLength(value) <= MAX_IDENTIFIER_CODE_POINTS
	);
}

function isTimestamp(value: unknown): value is string {
	return (
		typeof value === "string" &&
		codePointLength(value) <= MAX_TIMESTAMP_CODE_POINTS &&
		Number.isFinite(Date.parse(value))
	);
}

function isBoundedNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_NUMERIC_VALUE;
}

function isBoundedInteger(value: unknown, maximum: number): value is number {
	return Number.isSafeInteger(value) && typeof value === "number" && value >= 0 && value <= maximum;
}

function isPositiveInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && typeof value === "number" && value >= 1 && value <= MAX_DIAGNOSTIC_COUNT;
}

function isCoverage(value: unknown): value is Coverage {
	return value === "focused_partial" || value === "snapshot_complete" || value === "snapshot_truncated";
}

function isRetrievalMode(value: unknown): value is RetrievalMode {
	return value === "live" || value === "cache" || value === "cursor";
}

function isTitleSource(value: unknown): value is TitleSource {
	return value === "search_ref" || value === "resolved_hostname";
}

function safelyParseDetails<T>(
	result: AgentToolResult<unknown>,
	parser: (value: unknown) => T | undefined,
): T | undefined {
	try {
		return parser(result.details);
	} catch {
		return undefined;
	}
}

function formatRetrieval(mode: "live" | "cache" | "cursor", cacheAgeSeconds: number | undefined): string {
	if (mode !== "cache" || cacheAgeSeconds === undefined) return mode;
	return `cache (age ${Math.floor(cacheAgeSeconds)}s)`;
}

function formatDuration(durationMs: number): string {
	if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
	return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
}

function formatCredits(credits: number): string {
	const formatted = Number.isInteger(credits)
		? String(credits)
		: credits.toFixed(2).replace(/0+$/u, "").replace(/\.$/u, "");
	return `${formatted} ${credits === 1 ? "credit" : "credits"}`;
}

function formatUsageFlags(estimated: boolean, overrun: boolean): string {
	return `${estimated ? " · usage estimated" : ""}${overrun ? " · credit overrun" : ""}`;
}

function invalidCall(label: string, theme: RendererTheme): Text {
	return textComponent(`${theme.fg("toolTitle", theme.bold(label))}${theme.fg("warning", " · invalid arguments")}`);
}

function failedResult(label: string, theme: RendererTheme): Text {
	return textComponent(theme.fg("error", `${label} failed`));
}

function genericResult(label: string, theme: RendererTheme): Text {
	return textComponent(theme.fg("muted", `${label} completed`));
}

function textComponent(value: string): Text {
	return new Text(value, 0, 0);
}
