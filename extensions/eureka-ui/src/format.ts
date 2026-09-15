/**
 * Pure formatting helpers for eureka-ui.
 *
 * Everything here returns plain text; theme colors are applied by the
 * components that own the row or the activity line.
 */

const DEFAULT_FOCUS_LIMIT = 60;

export interface ToolResultLike {
	readonly content?: unknown;
	readonly details?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function clip(text: string, limit = DEFAULT_FOCUS_LIMIT): string {
	const collapsed = text.replaceAll(/\s+/g, " ").trim();
	if (collapsed.length <= limit) return collapsed;
	return `${collapsed.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

/** Concatenated text of a tool result's text blocks. */
export function textContent(result: ToolResultLike | undefined): string {
	const content = result?.content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!isRecord(block) || block.type !== "text") continue;
		const text = str(block.text);
		if (text !== undefined) parts.push(text);
	}
	return parts.join("\n");
}

export function countNonEmptyLines(text: string): number {
	if (text.trim().length === 0) return 0;
	return text.split("\n").filter((line) => line.trim().length > 0).length;
}

export function formatDuration(durationMs: number): string {
	return `${(Math.max(0, durationMs) / 1000).toFixed(1)}s`;
}

/** Exit code reported by Pi's shell tools when a command fails. */
export function extractExitCode(text: string): number | undefined {
	const match = /Command exited with code (\d+)/.exec(text);
	if (match?.[1] === undefined) return undefined;
	const code = Number.parseInt(match[1], 10);
	return Number.isFinite(code) ? code : undefined;
}

function formatPath(args: Record<string, unknown> | undefined): string | undefined {
	const path = args === undefined ? undefined : (str(args.path) ?? str(args.file_path));
	return path === undefined ? undefined : clip(path);
}

function formatReadPath(args: Record<string, unknown> | undefined): string | undefined {
	const path = formatPath(args);
	if (path === undefined || args === undefined) return path;
	const offset = num(args.offset);
	const limit = num(args.limit);
	if (offset === undefined && limit === undefined) return path;
	const start = offset ?? 1;
	const end = limit === undefined ? "" : `-${start + limit - 1}`;
	return `${path}:${start}${end}`;
}

/** Short human phrase for what a tool is acting on, used by the activity line. */
export function formatToolFocus(toolName: string, args: unknown): string {
	const record = isRecord(args) ? args : undefined;
	switch (toolName) {
		case "bash":
		case "powershell": {
			const command = record === undefined ? undefined : str(record.command);
			return command === undefined ? "" : clip(command);
		}
		case "read":
			return formatReadPath(record) ?? "";
		case "edit":
		case "write": {
			const path = formatPath(record);
			if (path !== undefined) return path;
			const content = record === undefined ? undefined : str(record.content);
			return content === undefined ? "" : clip(content);
		}
		case "grep": {
			const pattern = record === undefined ? undefined : str(record.pattern);
			return pattern === undefined ? "" : clip(`/${pattern}/`);
		}
		case "find": {
			const pattern = record === undefined ? undefined : str(record.pattern);
			return pattern === undefined ? "" : clip(pattern);
		}
		case "ls":
			return formatPath(record) ?? "";
		default:
			return "";
	}
}

/** The call half of a `line` row, for example `$ npm test` or `read src/index.ts`. */
export function formatCallLine(toolName: string, args: unknown): string {
	const focus = formatToolFocus(toolName, args);
	switch (toolName) {
		case "bash":
			return focus.length === 0 ? "$ …" : `$ ${focus}`;
		case "powershell":
			return focus.length === 0 ? "PS> …" : `PS> ${focus}`;
		case "read":
		case "edit":
		case "write":
		case "ls":
			return focus.length === 0 ? `${toolName} …` : `${toolName} ${focus}`;
		case "grep":
			return focus.length === 0 ? "grep …" : `grep ${focus}`;
		case "find":
			return focus.length === 0 ? "find …" : `find ${focus}`;
		default:
			return toolName;
	}
}

export function formatEditStats(details: unknown): string | undefined {
	if (!isRecord(details)) return undefined;
	const diff = str(details.diff);
	if (diff === undefined || diff.length === 0) return undefined;
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
		if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
	}
	if (added === 0 && removed === 0) return undefined;
	return `+${added} -${removed}`;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : pluralForm}`;
}

/** The result half of a `line` row, for example `✓ 12 lines · 1.2s`. */
export function formatResultSummary(
	toolName: string,
	args: unknown,
	result: ToolResultLike | undefined,
	isError: boolean,
	durationMs: number | undefined,
): string {
	const output = textContent(result);
	if (isError) {
		const exitCode = extractExitCode(output);
		const detail = exitCode === undefined ? clip(firstLine(output)) : `exit ${exitCode}`;
		return detail.length === 0 ? "✗ failed" : `✗ ${detail}`;
	}
	const suffix = durationMs === undefined ? "" : ` · ${formatDuration(durationMs)}`;
	switch (toolName) {
		case "bash":
		case "powershell": {
			const lines = countNonEmptyLines(output);
			return `✓ ${plural(lines, "line")}${suffix}`;
		}
		case "read":
			return `✓ ${plural(countNonEmptyLines(output), "line")}`;
		case "edit": {
			const stats = formatEditStats(result?.details);
			return stats === undefined ? "✓ edited" : `✓ ${stats}`;
		}
		case "write": {
			const record = isRecord(args) ? args : undefined;
			const content = record === undefined ? undefined : str(record.content);
			const lines = content === undefined ? 0 : content.split("\n").length;
			return `✓ ${plural(lines, "line")}`;
		}
		case "grep":
			return `✓ ${plural(countNonEmptyLines(output), "match", "matches")}`;
		case "find":
			return `✓ ${plural(countNonEmptyLines(output), "file")}`;
		case "ls":
			return `✓ ${plural(countNonEmptyLines(output), "entry", "entries")}`;
		default:
			return "✓ done";
	}
}

function firstLine(text: string): string {
	const [line = ""] = text.trim().split("\n", 1);
	return line;
}

export interface ActivityToolLike {
	readonly toolName: string;
	readonly args: unknown;
}

const ACTIVITY_TOOL_LIMIT = 2;

/** `Running npm test…`, or a two-tool form with a `(+N)` tail. */
export function formatActivityRunning(tools: readonly ActivityToolLike[]): string {
	if (tools.length === 0) return "";
	const shown = tools.slice(0, ACTIVITY_TOOL_LIMIT).map((tool) => describeTool(tool.toolName, tool.args));
	const hidden = tools.length - shown.length;
	const list = shown.join(", ");
	return hidden > 0 ? `Running ${list}… (+${hidden})` : `Running ${list}…`;
}

export function formatActivityRan(tool: ActivityToolLike, durationMs: number): string {
	return `Ran ${describeTool(tool.toolName, tool.args)} · ${formatDuration(durationMs)}`;
}

export function formatActivityFailed(tool: ActivityToolLike, detail: string | undefined): string {
	const description = describeTool(tool.toolName, tool.args);
	return detail === undefined || detail.length === 0 ? `Failed ${description}` : `Failed ${description} · ${detail}`;
}

export function describeTool(toolName: string, args: unknown): string {
	const focus = formatToolFocus(toolName, args);
	return focus.length === 0 ? toolName : focus;
}

/** Failure detail for the activity line: exit code when known, otherwise the first line. */
export function failureDetail(result: ToolResultLike | undefined): string | undefined {
	const output = textContent(result);
	const exitCode = extractExitCode(output);
	if (exitCode !== undefined) return `exit ${exitCode}`;
	const line = clip(firstLine(output));
	return line.length === 0 ? undefined : line;
}
