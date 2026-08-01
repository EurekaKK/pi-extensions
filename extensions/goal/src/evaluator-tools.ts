import { lstat, readdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import {
	GOAL_SNAPSHOT_IMAGE_TOOL,
	GOAL_SNAPSHOT_READ_TOOL,
	GOAL_SNAPSHOT_SEARCH_TOOL,
	GOAL_SUBMIT_EVALUATION_TOOL,
} from "./constants.js";
import { GOAL_DECISIONS, type GoalEvaluationReportV1 } from "./domain.js";
import {
	type GoalEvaluationSnapshotBundle,
	type GoalSnapshotImage,
	isTextSnapshotPath,
	openSnapshotFile,
	resolveSnapshotEntry,
} from "./snapshots.js";

const MAX_READ_LINES = 200;
const MAX_READ_BYTES = 64 * 1024;
const MAX_SEARCH_RESULTS = 50;
const MAX_SEARCH_SNIPPET_CHARACTERS = 480;

export const GoalSnapshotReadParametersSchema = Type.Object(
	{
		path: Type.String({ minLength: 1, maxLength: 4096 }),
		startLine: Type.Optional(Type.Integer({ minimum: 1, maximum: 1_000_000_000 })),
		lineCount: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_READ_LINES })),
	},
	{ additionalProperties: false },
);

export const GoalSnapshotSearchParametersSchema = Type.Object(
	{
		query: Type.String({ minLength: 1, maxLength: 1000 }),
		path: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
		maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SEARCH_RESULTS })),
	},
	{ additionalProperties: false },
);

export const GoalSnapshotImageParametersSchema = Type.Object(
	{
		id: Type.String({ minLength: 1, maxLength: 128 }),
	},
	{ additionalProperties: false },
);

/**
 * Keep the provider-facing schema as one plain object. Decision-dependent rules
 * are enforced by validateGoalEvaluationReport before Pi's schema validation.
 * This avoids a root anyOf/const schema, which some tool-calling providers do
 * not reliably follow, while preserving the exact canonical report contract.
 */
export const GoalEvaluationReportSchema = Type.Object(
	{
		decision: StringEnum(GOAL_DECISIONS, {
			description: "Choose exactly one of continue, complete, or fail.",
		}),
		progress: Type.String({ description: "Concrete progress already achieved." }),
		reason: Type.String({ description: "Evidence-based reason for the decision." }),
		next_action: Type.Unsafe<string | null>({
			type: ["string", "null"],
			description: "A non-empty string for continue; JSON null for complete or fail.",
		}),
		evidence: Type.Array(Type.String(), {
			description: "One to sixteen concrete evidence references.",
		}),
	},
	{ additionalProperties: false },
);

export type GoalSnapshotReadParameters = Static<typeof GoalSnapshotReadParametersSchema>;
export type GoalSnapshotSearchParameters = Static<typeof GoalSnapshotSearchParametersSchema>;
export type GoalSnapshotImageParameters = Static<typeof GoalSnapshotImageParametersSchema>;

export type GoalEvaluationValidation =
	| { readonly ok: true; readonly report: GoalEvaluationReportV1 }
	| { readonly ok: false; readonly message: string };

export type GoalFormatFailureDisposition = "correction" | "exhausted" | "accepted";

export class GoalEvaluationFormatError extends Error {
	readonly disposition: Exclude<GoalFormatFailureDisposition, "accepted">;

	constructor(message: string, disposition: Exclude<GoalFormatFailureDisposition, "accepted">) {
		super(message);
		this.name = "GoalEvaluationFormatError";
		this.disposition = disposition;
	}
}

export interface GoalEvaluatorToolDetails {
	readonly version: 1;
	readonly operation: "read" | "search" | "image" | "submit";
	readonly path?: string;
	readonly hasMore?: boolean;
	readonly resultCount?: number;
	readonly imageId?: string;
	readonly imageAvailable?: boolean;
	readonly accepted?: boolean;
}

export interface CreateGoalEvaluatorToolsInput {
	readonly snapshot: GoalEvaluationSnapshotBundle;
	readonly supportsImages: boolean;
	readonly formatGuard?: GoalEvaluationFormatGuard;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Object.keys(value);
	return (
		Object.getOwnPropertySymbols(value).length === 0 &&
		keys.length === expected.length &&
		expected.every((key) => Object.hasOwn(value, key))
	);
}

function characterLength(value: string): number {
	return [...value].length;
}

function validRequiredString(value: unknown, maximum: number): value is string {
	return typeof value === "string" && value.trim().length > 0 && characterLength(value) <= maximum;
}

export function validateGoalEvaluationReport(value: unknown): GoalEvaluationValidation {
	const exactKeys = ["decision", "progress", "reason", "next_action", "evidence"] as const;
	if (!isRecord(value) || !hasExactKeys(value, exactKeys)) {
		return { ok: false, message: "Report must contain exactly decision, progress, reason, next_action, and evidence." };
	}
	if (value.decision !== "continue" && value.decision !== "complete" && value.decision !== "fail") {
		return { ok: false, message: "decision must be continue, complete, or fail." };
	}
	if (!validRequiredString(value.progress, 4000)) {
		return { ok: false, message: "progress must be non-blank and at most 4000 characters." };
	}
	if (!validRequiredString(value.reason, 1000)) {
		return { ok: false, message: "reason must be non-blank and at most 1000 characters." };
	}
	if (value.decision === "continue") {
		if (!validRequiredString(value.next_action, 2000)) {
			return { ok: false, message: "continue requires a non-blank next_action of at most 2000 characters." };
		}
	} else if (value.next_action !== null) {
		return { ok: false, message: "complete and fail require next_action to be null." };
	}
	if (!Array.isArray(value.evidence) || value.evidence.length < 1 || value.evidence.length > 16) {
		return { ok: false, message: "evidence must contain between 1 and 16 items." };
	}
	const evidence: string[] = [];
	for (const [index, item] of value.evidence.entries()) {
		if (!validRequiredString(item, 1000)) {
			return { ok: false, message: `evidence[${index}] must be non-blank and at most 1000 characters.` };
		}
		evidence.push(item);
	}

	const report = Object.freeze({
		decision: value.decision,
		progress: value.progress,
		reason: value.reason,
		next_action: value.next_action,
		evidence: Object.freeze(evidence),
	}) as GoalEvaluationReportV1;
	return { ok: true, report };
}

export class GoalEvaluationFormatGuard {
	#acceptedReport: GoalEvaluationReportV1 | undefined;
	#formatFailures = 0;

	get acceptedReport(): GoalEvaluationReportV1 | undefined {
		return this.#acceptedReport;
	}

	get formatFailures(): number {
		return this.#formatFailures;
	}

	accept(value: unknown): GoalEvaluationValidation {
		if (this.#acceptedReport !== undefined) {
			return { ok: false, message: "An evaluation report has already been accepted." };
		}
		if (this.#formatFailures >= 2) {
			return { ok: false, message: "The single evaluation format-correction opportunity is exhausted." };
		}
		const validation = validateGoalEvaluationReport(value);
		if (validation.ok) this.#acceptedReport = validation.report;
		return validation;
	}

	recordFormatFailure(): GoalFormatFailureDisposition {
		if (this.#acceptedReport !== undefined) return "accepted";
		this.#formatFailures = Math.min(this.#formatFailures + 1, 2);
		return this.#formatFailures === 1 ? "correction" : "exhausted";
	}
}

function rejectGoalEvaluationFormat(guard: GoalEvaluationFormatGuard, message: string): never {
	const disposition = guard.recordFormatFailure();
	if (disposition === "accepted") throw new Error(message);
	throw new GoalEvaluationFormatError(message, disposition);
}

function prepareGoalEvaluationReport(
	guard: GoalEvaluationFormatGuard,
	value: unknown,
): Static<typeof GoalEvaluationReportSchema> {
	const validation = validateGoalEvaluationReport(value);
	if (!validation.ok) rejectGoalEvaluationFormat(guard, validation.message);
	return {
		decision: validation.report.decision,
		progress: validation.report.progress,
		reason: validation.report.reason,
		next_action: validation.report.next_action,
		evidence: [...validation.report.evidence],
	};
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	signal?.throwIfAborted();
}

function truncateUtf8(value: string, maximumBytes: number): { readonly text: string; readonly truncated: boolean } {
	if (Buffer.byteLength(value, "utf8") <= maximumBytes) return { text: value, truncated: false };
	let bytes = 0;
	let output = "";
	for (const character of value) {
		const size = Buffer.byteLength(character, "utf8");
		if (bytes + size > maximumBytes) break;
		output += character;
		bytes += size;
	}
	return { text: output, truncated: true };
}

interface ReadSnapshotResult {
	readonly text: string;
	readonly hasMore: boolean;
	readonly startLine: number;
	readonly endLine: number | null;
}

async function readSnapshotLines(
	snapshot: GoalEvaluationSnapshotBundle,
	parameters: GoalSnapshotReadParameters,
	signal: AbortSignal | undefined,
): Promise<ReadSnapshotResult> {
	const startLine = parameters.startLine ?? 1;
	const lineCount = Math.min(parameters.lineCount ?? MAX_READ_LINES, MAX_READ_LINES);
	const handle = await openSnapshotFile(snapshot.root, parameters.path, signal);
	const stream = handle.createReadStream(
		signal ? { encoding: "utf8", autoClose: false, signal } : { encoding: "utf8", autoClose: false },
	);
	const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
	let lineNumber = 0;
	let included = 0;
	let endLine: number | null = null;
	let body = "";
	let hasMore = false;
	const bodyBudget = MAX_READ_BYTES - 1024;
	try {
		for await (const line of lines) {
			throwIfAborted(signal);
			lineNumber += 1;
			if (lineNumber < startLine) continue;
			if (included >= lineCount) {
				hasMore = true;
				break;
			}
			const rendered = `${lineNumber}: ${line}\n`;
			const remaining = Math.max(0, bodyBudget - Buffer.byteLength(body, "utf8"));
			const truncated = truncateUtf8(rendered, remaining);
			body += truncated.text;
			included += 1;
			endLine = lineNumber;
			if (truncated.truncated) {
				hasMore = true;
				break;
			}
		}
	} finally {
		lines.close();
		stream.destroy();
		await handle.close().catch(() => undefined);
	}
	const header = [
		`Path: ${parameters.path}`,
		`Lines: ${endLine === null ? "none" : `${startLine}-${endLine}`}`,
		`Has more: ${hasMore ? "yes" : "no"}`,
		"",
	].join("\n");
	const bounded = truncateUtf8(`${header}${body}`, MAX_READ_BYTES);
	return { text: bounded.text, hasMore: hasMore || bounded.truncated, startLine, endLine };
}

async function listTextSnapshotFiles(
	snapshot: GoalEvaluationSnapshotBundle,
	path: string | undefined,
	signal: AbortSignal | undefined,
): Promise<readonly string[]> {
	const files: string[] = [];
	const walk = async (directoryPath: string, relativeDirectory: string): Promise<void> => {
		throwIfAborted(signal);
		const entries = await readdir(directoryPath, { withFileTypes: true });
		entries.sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of entries) {
			throwIfAborted(signal);
			const relativePath = relativeDirectory.length === 0 ? entry.name : `${relativeDirectory}/${entry.name}`;
			const resolved = await resolveSnapshotEntry(snapshot.root, relativePath, "either", signal);
			if (resolved.kind === "directory") {
				await walk(resolved.absolutePath, resolved.relativePath);
			} else if (isTextSnapshotPath(resolved.relativePath)) {
				files.push(resolved.relativePath);
			}
		}
	};

	if (path !== undefined) {
		const resolved = await resolveSnapshotEntry(snapshot.root, path, "either", signal);
		if (resolved.kind === "file") {
			if (!isTextSnapshotPath(resolved.relativePath)) throw new Error("Search path is not a text snapshot file.");
			return [resolved.relativePath];
		}
		await walk(resolved.absolutePath, resolved.relativePath);
		return files;
	}

	const rootStats = await lstat(snapshot.root);
	if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) throw new Error("Snapshot root is not a real directory.");
	await walk(snapshot.root, "");
	return files;
}

function searchSnippet(line: string, matchIndex: number, queryLength: number): string {
	const start = Math.max(0, matchIndex - 120);
	const end = Math.min(line.length, matchIndex + queryLength + 280);
	const raw = `${start > 0 ? "…" : ""}${line.slice(start, end)}${end < line.length ? "…" : ""}`;
	return [...raw].slice(0, MAX_SEARCH_SNIPPET_CHARACTERS).join("");
}

export interface GoalSnapshotSearchMatch {
	readonly path: string;
	readonly line: number;
	readonly snippet: string;
}

async function searchSnapshot(
	snapshot: GoalEvaluationSnapshotBundle,
	parameters: GoalSnapshotSearchParameters,
	signal: AbortSignal | undefined,
): Promise<readonly GoalSnapshotSearchMatch[]> {
	throwIfAborted(signal);
	if (parameters.query.trim().length === 0) throw new Error("Search query must not be blank.");
	const maximum = Math.min(parameters.maxResults ?? MAX_SEARCH_RESULTS, MAX_SEARCH_RESULTS);
	const query = parameters.query.toLowerCase();
	const files = await listTextSnapshotFiles(snapshot, parameters.path, signal);
	const matches: GoalSnapshotSearchMatch[] = [];
	for (const path of files) {
		const handle = await openSnapshotFile(snapshot.root, path, signal);
		const stream = handle.createReadStream(
			signal ? { encoding: "utf8", autoClose: false, signal } : { encoding: "utf8", autoClose: false },
		);
		const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
		let lineNumber = 0;
		try {
			for await (const line of lines) {
				throwIfAborted(signal);
				lineNumber += 1;
				const index = line.toLowerCase().indexOf(query);
				if (index < 0) continue;
				matches.push({ path, line: lineNumber, snippet: searchSnippet(line, index, parameters.query.length) });
				if (matches.length >= maximum) break;
			}
		} finally {
			lines.close();
			stream.destroy();
			await handle.close().catch(() => undefined);
		}
		if (matches.length >= maximum) break;
	}
	return matches;
}

function textResult(
	text: string,
	details: GoalEvaluatorToolDetails,
	terminate = false,
): AgentToolResult<GoalEvaluatorToolDetails> {
	return { content: [{ type: "text", text }], details, terminate };
}

async function imageResult(
	snapshot: GoalEvaluationSnapshotBundle,
	image: GoalSnapshotImage,
	supportsImages: boolean,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GoalEvaluatorToolDetails>> {
	throwIfAborted(signal);
	if (!supportsImages) {
		return textResult(
			`Image ${image.id} (${image.mediaType}) is registered, but the current evaluator model cannot inspect images.`,
			{ version: 1, operation: "image", imageId: image.id, imageAvailable: false },
		);
	}
	const handle = await openSnapshotFile(snapshot.root, image.relativePath, signal);
	try {
		const data = await handle.readFile(signal ? { signal } : undefined);
		throwIfAborted(signal);
		return {
			content: [
				{ type: "text", text: `Registered snapshot image ${image.id} (${image.mediaType}).` },
				{ type: "image", data: data.toString("base64"), mimeType: image.mediaType },
			],
			details: { version: 1, operation: "image", imageId: image.id, imageAvailable: true },
		};
	} finally {
		await handle.close().catch(() => undefined);
	}
}

export function createGoalEvaluatorTools(input: CreateGoalEvaluatorToolsInput) {
	const guard = input.formatGuard ?? new GoalEvaluationFormatGuard();
	const images = new Map<string, GoalSnapshotImage>();
	for (const image of input.snapshot.images) {
		if (images.has(image.id)) throw new Error(`Duplicate snapshot image id: ${image.id}`);
		images.set(image.id, image);
	}

	const readTool = defineTool({
		name: GOAL_SNAPSHOT_READ_TOOL,
		label: "Read goal snapshot",
		description: "Read a bounded range of lines from a file inside the isolated goal evaluation snapshot.",
		promptSnippet: "Read lines from the isolated goal snapshot bundle.",
		parameters: GoalSnapshotReadParametersSchema,
		async execute(_toolCallId, parameters, signal) {
			const result = await readSnapshotLines(input.snapshot, parameters, signal);
			return textResult(result.text, {
				version: 1,
				operation: "read",
				path: parameters.path,
				hasMore: result.hasMore,
			});
		},
	});

	const searchTool = defineTool({
		name: GOAL_SNAPSHOT_SEARCH_TOOL,
		label: "Search goal snapshot",
		description: "Search literal text case-insensitively within the isolated goal evaluation snapshot.",
		promptSnippet: "Search literal text in the isolated goal snapshot bundle.",
		parameters: GoalSnapshotSearchParametersSchema,
		async execute(_toolCallId, parameters, signal) {
			const matches = await searchSnapshot(input.snapshot, parameters, signal);
			const output =
				matches.length === 0
					? "No literal matches found."
					: [
							`Found ${matches.length} match(es):`,
							...matches.map((match) => `${match.path}:${match.line}: ${match.snippet}`),
						].join("\n");
			return textResult(output, {
				version: 1,
				operation: "search",
				...(parameters.path === undefined ? {} : { path: parameters.path }),
				resultCount: matches.length,
			});
		},
	});

	const imageTool = defineTool({
		name: GOAL_SNAPSHOT_IMAGE_TOOL,
		label: "Inspect goal snapshot image",
		description: "Inspect one image by its registered snapshot image id; arbitrary paths are not accepted.",
		promptSnippet: "Inspect a registered image from the isolated goal snapshot.",
		parameters: GoalSnapshotImageParametersSchema,
		async execute(_toolCallId, parameters, signal) {
			throwIfAborted(signal);
			const image = images.get(parameters.id);
			if (image === undefined) throw new Error(`Unknown snapshot image id: ${parameters.id}`);
			return await imageResult(input.snapshot, image, input.supportsImages, signal);
		},
	});

	const submitTool = defineTool({
		name: GOAL_SUBMIT_EVALUATION_TOOL,
		label: "Submit goal evaluation",
		description: "Submit the evaluator's single structured continue, complete, or fail report.",
		promptSnippet: "Submit exactly one structured goal evaluation report.",
		executionMode: "sequential",
		parameters: GoalEvaluationReportSchema,
		prepareArguments(parameters) {
			return prepareGoalEvaluationReport(guard, parameters);
		},
		async execute(_toolCallId, parameters, signal) {
			throwIfAborted(signal);
			const validation = guard.accept(parameters);
			if (!validation.ok) rejectGoalEvaluationFormat(guard, validation.message);
			return textResult(
				`Accepted ${validation.report.decision} evaluation report.`,
				{ version: 1, operation: "submit", accepted: true },
				true,
			);
		},
	});

	const tools = [readTool, searchTool, imageTool, submitTool] as const satisfies readonly ToolDefinition[];
	return {
		tools,
		readTool,
		searchTool,
		imageTool,
		submitTool,
		formatGuard: guard,
		get acceptedReport(): GoalEvaluationReportV1 | undefined {
			return guard.acceptedReport;
		},
	};
}
