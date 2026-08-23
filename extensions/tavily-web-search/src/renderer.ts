import type { AgentToolResult, Theme, ThemeColor, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, Text, visibleWidth } from "@earendil-works/pi-tui";
import { EXTRACT_TOOL_NAME, SEARCH_TOOL_NAME } from "./constants.js";

/**
 * Compact TUI renderers for tavily_search / tavily_extract and the minimal
 * versioned structured details they read.
 *
 * Rendering rules:
 * - `renderResult` checks `isError` first; error results never read `details`.
 * - `details` is always treated as `unknown` and strictly validated before use.
 * - `isPartial` renders a fixed safe placeholder instead of possibly
 *   half-written content.
 * - Collapsed views never show Envelope XML, snippets or page bodies; they show
 *   truncated query + hit count (Search) or URL/page/failed counts (Extract).
 * - Expanded views show the full original content text, with terminal control characters removed.
 * - Compact lines are width-clamped; expanded text relies on the TUI Text component for lossless wrapping.
 */

export const TAVILY_DETAILS_VERSION = 1;

export interface TavilySearchDetailsV1 {
	readonly tavily_details_version: typeof TAVILY_DETAILS_VERSION;
	readonly tavily_hit_count: number;
}

export interface TavilyExtractDetailsV1 {
	readonly tavily_details_version: typeof TAVILY_DETAILS_VERSION;
	readonly tavily_url_count: number;
	readonly tavily_page_count: number;
	readonly tavily_failed_count: number;
}

/** Width cap for collapsed summary lines (visible columns). */
export const MAX_SUMMARY_COLUMNS = 120;
/** Width cap for the truncated query shown in Search summaries. */
export const MAX_QUERY_COLUMNS = 80;

/**
 * Structural subset of Pi's ToolRenderContext that the renderers read.
 * Pi's context is assignable to this shape; tests can build it directly.
 */
export interface RenderContext {
	readonly args: unknown;
	readonly argsComplete: boolean;
	readonly isError: boolean;
	readonly isPartial: boolean;
	readonly expanded: boolean;
}

/**
 * True for C0/C1 control characters except tab (0x09) and newline (0x0A).
 * Includes ESC (0x1B) and CR (0x0D), which would corrupt terminal display.
 */
function isTerminalControl(code: number): boolean {
	return (code >= 0x00 && code <= 0x08) || (code >= 0x0b && code <= 0x1f) || (code >= 0x7f && code <= 0x9f);
}

/** Strip control characters (including ESC) that could corrupt the terminal. */
export function sanitizeTerminalText(text: string): string {
	let sanitized = "";
	for (const char of text) {
		if (!isTerminalControl(char.charCodeAt(0))) sanitized += char;
	}
	return sanitized;
}

function clampLine(line: string, maxColumns: number): string {
	if (visibleWidth(line) <= maxColumns) return line;
	if (maxColumns < 4) return sliceByColumn(line, 0, maxColumns, true);
	return `${sliceByColumn(line, 0, maxColumns - 3, true)}...`;
}

/**
 * Sanitize control characters and clamp every logical line to `maxColumns`
 * visible columns. Runs on plain text before theme colors are applied, so no
 * rendered line can overflow the TUI width and no raw ESC sequence reaches the
 * terminal.
 */
export function clampLines(text: string, maxColumns: number): string {
	const width = Math.max(1, maxColumns);
	return sanitizeTerminalText(text)
		.split("\n")
		.map((line) => clampLine(line, width))
		.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function parseSearchDetails(value: unknown): TavilySearchDetailsV1 | undefined {
	if (!isRecord(value) || value.tavily_details_version !== TAVILY_DETAILS_VERSION) return undefined;
	if (!isCount(value.tavily_hit_count)) return undefined;
	return { tavily_details_version: TAVILY_DETAILS_VERSION, tavily_hit_count: value.tavily_hit_count };
}

export function parseExtractDetails(value: unknown): TavilyExtractDetailsV1 | undefined {
	if (!isRecord(value) || value.tavily_details_version !== TAVILY_DETAILS_VERSION) return undefined;
	if (!isCount(value.tavily_url_count) || !isCount(value.tavily_page_count) || !isCount(value.tavily_failed_count)) {
		return undefined;
	}
	return {
		tavily_details_version: TAVILY_DETAILS_VERSION,
		tavily_url_count: value.tavily_url_count,
		tavily_page_count: value.tavily_page_count,
		tavily_failed_count: value.tavily_failed_count,
	};
}

function resultText(result: AgentToolResult<unknown>): string {
	return result.content
		.filter(
			(block): block is { readonly type: "text"; readonly text: string } =>
				block.type === "text" && typeof block.text === "string",
		)
		.map((block) => block.text)
		.join("\n");
}

function firstLine(text: string, fallback: string): string {
	const line = text.split("\n", 1)[0]?.trim();
	return line === undefined || line.length === 0 ? fallback : line;
}

function argsQuery(args: unknown): string | undefined {
	if (!isRecord(args) || typeof args.query !== "string") return undefined;
	const query = args.query.trim();
	return query.length === 0 ? undefined : query;
}

function argsUrlCount(args: unknown): number | undefined {
	if (!isRecord(args) || !Array.isArray(args.urls)) return undefined;
	return args.urls.filter((url): url is string => typeof url === "string").length;
}

function contentText(text: string, maxColumns: number, fallback: string): string {
	return clampLines(text.length === 0 ? fallback : text, maxColumns);
}

function styledText(text: string, color: ThemeColor, theme: Theme, maxColumns: number, fallback: string): Text {
	return new Text(theme.fg(color, contentText(text, maxColumns, fallback)), 0, 0);
}

function expandedText(text: string, color: ThemeColor, theme: Theme, fallback: string): Text {
	const content = text.length === 0 ? fallback : text;
	return new Text(theme.fg(color, sanitizeTerminalText(content)), 0, 0);
}

export function renderSearchCall(args: unknown, theme: Theme, context: RenderContext): Text {
	const head = theme.fg("toolTitle", theme.bold(SEARCH_TOOL_NAME));
	if (context.argsComplete === false) return new Text(head, 0, 0);
	const query = argsQuery(args);
	const detail = query === undefined ? "" : theme.fg("muted", ` · ${clampLines(query, MAX_QUERY_COLUMNS)}`);
	return new Text(`${head}${detail}`, 0, 0);
}

export function renderSearchResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: RenderContext,
): Text {
	const output = resultText(result);
	if (context.isError) {
		return options.expanded
			? expandedText(output, "error", theme, "Search failed")
			: styledText(firstLine(output, "Search failed"), "error", theme, MAX_SUMMARY_COLUMNS, "Search failed");
	}
	if (options.isPartial) {
		return new Text(theme.fg("muted", `${SEARCH_TOOL_NAME} in progress…`), 0, 0);
	}
	if (options.expanded) return expandedText(output, "text", theme, "Search complete");
	const details = parseSearchDetails(result.details);
	if (details === undefined) return new Text(theme.fg("success", "Search complete"), 0, 0);
	const hitCount = `${details.tavily_hit_count} hit${details.tavily_hit_count === 1 ? "" : "s"}`;
	const query = argsQuery(context.args);
	const queryPart = query === undefined ? "" : ` · ${clampLines(query, MAX_QUERY_COLUMNS)}`;
	return new Text(theme.fg("success", clampLines(`${hitCount}${queryPart}`, MAX_SUMMARY_COLUMNS)), 0, 0);
}

export function renderExtractCall(args: unknown, theme: Theme, context: RenderContext): Text {
	const head = theme.fg("toolTitle", theme.bold(EXTRACT_TOOL_NAME));
	if (context.argsComplete === false) return new Text(head, 0, 0);
	const count = argsUrlCount(args);
	const detail = count === undefined ? "" : theme.fg("muted", ` · ${count} URL${count === 1 ? "" : "s"}`);
	return new Text(`${head}${detail}`, 0, 0);
}

export function renderExtractResult(
	result: AgentToolResult<unknown>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: RenderContext,
): Text {
	const output = resultText(result);
	if (context.isError) {
		return options.expanded
			? expandedText(output, "error", theme, "Extract failed")
			: styledText(firstLine(output, "Extract failed"), "error", theme, MAX_SUMMARY_COLUMNS, "Extract failed");
	}
	if (options.isPartial) {
		return new Text(theme.fg("muted", `${EXTRACT_TOOL_NAME} in progress…`), 0, 0);
	}
	if (options.expanded) return expandedText(output, "text", theme, "Extract complete");
	const details = parseExtractDetails(result.details);
	if (details === undefined) return new Text(theme.fg("success", "Extract complete"), 0, 0);
	const summary = [
		`${details.tavily_url_count} URL${details.tavily_url_count === 1 ? "" : "s"}`,
		`${details.tavily_page_count} page${details.tavily_page_count === 1 ? "" : "s"}`,
		`${details.tavily_failed_count} failed`,
	].join(" · ");
	return new Text(theme.fg("success", clampLines(summary, MAX_SUMMARY_COLUMNS)), 0, 0);
}
