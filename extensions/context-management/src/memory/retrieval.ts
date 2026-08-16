import { MEMORY_PACK_TOKEN_LIMIT, MEMORY_SEARCH_RESULT_LIMIT, MEMORY_SEARCH_TOKEN_LIMIT } from "../constants.js";
import { estimateTextTokens } from "../runtime/budget.js";
import type { MemoryRecord } from "./schema.js";

const HAN_RUN = /\p{Script=Han}+/gu;
const OTHER_WORD_RUN = /[\p{L}\p{N}]+/gu;
const CODE_LITERAL = /`{1,3}([^`\n]+)`{1,3}/gu;
const PATH_LITERAL = /(?:^|[\s("'])((?:\.{0,2}\/|\/)?[\p{L}\p{N}_.-]+(?:\/[\p{L}\p{N}_.-]+)+\/?)/gu;
const IDENTIFIER_LITERAL = /\b[A-Za-z_$][A-Za-z0-9_$]*(?:(?:\.|::)[A-Za-z_$][A-Za-z0-9_$]*)+\b/gu;
const COMMAND_LITERAL = /(?:^|\n)\s*(?:[$>]\s*)?(\/?[A-Za-z][A-Za-z0-9_.:-]*)/gu;

export interface ActivationQuery {
	readonly text: string;
	readonly terms: readonly string[];
	readonly explicitPaths: readonly string[];
	readonly exactLiterals: readonly string[];
}

export interface RankedMemory {
	readonly record: MemoryRecord;
	readonly group: 1 | 2 | 3 | 4;
	readonly score: number;
	readonly preceding: boolean;
}

export interface MemoryPackItem {
	readonly id: string;
	readonly representation: "full" | "stub";
	readonly text: string;
	readonly estimatedTokens: number;
}

export interface MemoryPack {
	readonly items: readonly MemoryPackItem[];
	readonly text: string;
	readonly estimatedTokens: number;
}

function normalizedLiteral(value: string): string {
	return value.normalize("NFKC").replaceAll("\\", "/").toLowerCase().trim();
}

export function lexicalTerms(value: string): readonly string[] {
	const camelSplit = value.normalize("NFKC").replace(/([\p{Ll}\p{N}])([\p{Lu}])/gu, "$1 $2");
	const normalized = normalizedLiteral(camelSplit).replace(/[_-]+/g, " ");
	const terms: string[] = [];
	for (const run of normalized.match(HAN_RUN) ?? []) {
		const characters = [...run];
		terms.push(...characters);
		for (let index = 0; index + 1 < characters.length; index += 1) {
			terms.push(`${characters[index]}${characters[index + 1]}`);
		}
	}
	const withoutHan = normalized.replace(HAN_RUN, " ");
	for (const run of withoutHan.match(OTHER_WORD_RUN) ?? []) terms.push(run);
	return Object.freeze(terms);
}

function matches(value: string, expression: RegExp, group: number): string[] {
	const result: string[] = [];
	expression.lastIndex = 0;
	for (const match of value.matchAll(expression)) {
		const item = match[group];
		if (item !== undefined && item.trim().length > 0) result.push(normalizedLiteral(item));
	}
	return result;
}

function pathLiterals(value: string): string[] {
	return matches(value, PATH_LITERAL, 1)
		.map((path) => path.replace(/\.+$/u, ""))
		.filter((path) => path.length > 0);
}

export function buildActivationQuery(prompt: string): ActivationQuery {
	const explicitPaths = [...new Set(pathLiterals(prompt))].sort();
	const exactLiterals = [
		...matches(prompt, CODE_LITERAL, 1),
		...explicitPaths,
		...matches(prompt, IDENTIFIER_LITERAL, 0),
		...matches(prompt, COMMAND_LITERAL, 1),
	];
	return Object.freeze({
		text: prompt,
		terms: lexicalTerms(prompt),
		explicitPaths: Object.freeze(explicitPaths),
		exactLiterals: Object.freeze([...new Set(exactLiterals)].sort()),
	});
}

function markdownLiterals(markdown: string): readonly string[] {
	return Object.freeze(
		[
			...new Set([
				...matches(markdown, CODE_LITERAL, 1),
				...pathLiterals(markdown),
				...matches(markdown, IDENTIFIER_LITERAL, 0),
				...matches(markdown, COMMAND_LITERAL, 1),
			]),
		].sort(),
	);
}

function pathMatches(queryPath: string, scopePath: string): boolean {
	const query = normalizedLiteral(queryPath).replace(/\/$/, "");
	const scope = normalizedLiteral(scopePath).replace(/\/$/, "");
	return query === scope || query.startsWith(`${scope}/`);
}

export function isMemoryApplicable(
	record: MemoryRecord,
	query: ActivationQuery,
	currentBranch: string | null,
): boolean {
	if (record.supersededBy !== null) return false;
	if (record.scope.kind === "branch" && (currentBranch === null || record.scope.branch !== currentBranch)) return false;
	if (record.scope.paths.length === 0) return true;
	const pathCandidates = [...query.explicitPaths, ...query.exactLiterals];
	return pathCandidates.some((queryPath) => record.scope.paths.some((scopePath) => pathMatches(queryPath, scopePath)));
}

interface IndexedRecord {
	readonly record: MemoryRecord;
	readonly titleTerms: readonly string[];
	readonly summaryTerms: readonly string[];
	readonly bodyTerms: readonly string[];
	readonly weightedTerms: readonly string[];
	readonly exactLiterals: ReadonlySet<string>;
}

function indexRecord(record: MemoryRecord): IndexedRecord {
	const titleTerms = lexicalTerms(record.title);
	const summaryTerms = lexicalTerms(record.summary);
	const bodyTerms = lexicalTerms(record.contentMarkdown);
	const kindTerms = lexicalTerms(record.kind);
	const scopePaths = record.scope.paths.map(normalizedLiteral);
	return {
		record,
		titleTerms,
		summaryTerms,
		bodyTerms,
		weightedTerms: [
			...titleTerms,
			...titleTerms,
			...titleTerms,
			...summaryTerms,
			...summaryTerms,
			...bodyTerms,
			...kindTerms,
		],
		exactLiterals: new Set([
			...scopePaths,
			...markdownLiterals(record.title),
			...markdownLiterals(record.summary),
			...markdownLiterals(record.contentMarkdown),
		]),
	};
}

function intersects(left: readonly string[], right: readonly string[]): boolean {
	const values = new Set(left);
	return right.some((value) => values.has(value));
}

function bm25(indexed: IndexedRecord, candidates: readonly IndexedRecord[], queryTerms: readonly string[]): number {
	if (queryTerms.length === 0 || indexed.weightedTerms.length === 0) return 0;
	const averageLength =
		candidates.reduce((sum, candidate) => sum + candidate.weightedTerms.length, 0) / Math.max(1, candidates.length);
	const frequencies = new Map<string, number>();
	for (const term of indexed.weightedTerms) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
	let score = 0;
	for (const term of new Set(queryTerms)) {
		const frequency = frequencies.get(term) ?? 0;
		if (frequency === 0) continue;
		const documentFrequency = candidates.filter((candidate) => candidate.weightedTerms.includes(term)).length;
		const inverseDocumentFrequency = Math.log(
			1 + (candidates.length - documentFrequency + 0.5) / (documentFrequency + 0.5),
		);
		const denominator = frequency + 1.2 * (1 - 0.75 + 0.75 * (indexed.weightedTerms.length / averageLength));
		score += inverseDocumentFrequency * ((frequency * 2.2) / denominator);
	}
	return score;
}

export function rankMemoryRecords(
	records: readonly MemoryRecord[],
	query: ActivationQuery,
	currentBranch: string | null,
	precedingPackIds: ReadonlySet<string> = new Set(),
): readonly RankedMemory[] {
	const candidates = records.filter((record) => isMemoryApplicable(record, query, currentBranch)).map(indexRecord);
	const ranked: RankedMemory[] = [];
	for (const candidate of candidates) {
		const exact =
			query.text.trim() === candidate.record.id ||
			query.exactLiterals.some((literal) => candidate.exactLiterals.has(literal)) ||
			query.explicitPaths.some((queryPath) =>
				candidate.record.scope.paths.some((scopePath) => pathMatches(queryPath, scopePath)),
			);
		const titleOrSummary = intersects(query.terms, [...candidate.titleTerms, ...candidate.summaryTerms]);
		const body = intersects(query.terms, candidate.bodyTerms);
		const preceding = precedingPackIds.has(candidate.record.id);
		const group = exact ? 1 : titleOrSummary ? 2 : body ? 3 : preceding ? 4 : null;
		if (group === null) continue;
		ranked.push({
			record: candidate.record,
			group,
			score: group === 4 ? 0 : bm25(candidate, candidates, query.terms),
			preceding,
		});
	}
	return Object.freeze(
		ranked.sort((left, right) => {
			if (left.group !== right.group) return left.group - right.group;
			if (left.group !== 4 && left.score !== right.score) return right.score - left.score;
			if (left.group !== 4 && left.preceding !== right.preceding) return left.preceding ? -1 : 1;
			if (left.record.createdAt !== right.record.createdAt) {
				return right.record.createdAt.localeCompare(left.record.createdAt);
			}
			return left.record.id.localeCompare(right.record.id);
		}),
	);
}

function scopeLabel(record: MemoryRecord): string {
	return record.scope.kind === "repository" ? "repository" : `branch:${record.scope.branch}`;
}

function pathLabel(record: MemoryRecord): string {
	return record.scope.paths.length === 0 ? "none" : record.scope.paths.join(", ");
}

export function renderMemoryFull(record: MemoryRecord): string {
	return `## Memory ${record.id}: ${record.title}\n\n- Kind: ${record.kind}\n- Scope: ${scopeLabel(record)}\n- Paths: ${pathLabel(record)}\n- Summary: ${record.summary}\n\n${record.contentMarkdown}`;
}

export function renderMemoryStub(record: MemoryRecord): string {
	return `## Memory ${record.id}: ${record.title}\n\n- Kind: ${record.kind}\n- Scope: ${scopeLabel(record)}\n- Paths: ${pathLabel(record)}\n- Summary: ${record.summary}\n- Full body: ${Buffer.byteLength(record.contentMarkdown, "utf8")} bytes\n- Read: use context_management_memory_read with this exact ID`;
}

export function assembleMemoryPack(ranked: readonly RankedMemory[], limit = MEMORY_PACK_TOKEN_LIMIT): MemoryPack {
	const items: MemoryPackItem[] = [];
	let total = 0;
	for (const candidate of ranked) {
		const full = renderMemoryFull(candidate.record);
		const fullTokens = estimateTextTokens(full) + 4;
		if (total + fullTokens <= limit) {
			items.push({ id: candidate.record.id, representation: "full", text: full, estimatedTokens: fullTokens });
			total += fullTokens;
			continue;
		}
		const stub = renderMemoryStub(candidate.record);
		const stubTokens = estimateTextTokens(stub) + 4;
		if (total + stubTokens <= limit) {
			items.push({ id: candidate.record.id, representation: "stub", text: stub, estimatedTokens: stubTokens });
			total += stubTokens;
		}
	}
	return Object.freeze({
		items: Object.freeze(items),
		text: items.map((item) => item.text).join("\n\n"),
		estimatedTokens: total,
	});
}

export function selectMemorySearch(ranked: readonly RankedMemory[]): {
	readonly text: string;
	readonly ids: readonly string[];
} {
	const stubs: string[] = [];
	const ids: string[] = [];
	let total = 0;
	for (const candidate of ranked) {
		if (stubs.length >= MEMORY_SEARCH_RESULT_LIMIT) break;
		const stub = renderMemoryStub(candidate.record);
		const tokens = estimateTextTokens(stub) + 4;
		if (total + tokens > MEMORY_SEARCH_TOKEN_LIMIT) break;
		stubs.push(stub);
		ids.push(candidate.record.id);
		total += tokens;
	}
	return Object.freeze({
		text: stubs.length === 0 ? "[context-management: no applicable memory matched]" : stubs.join("\n\n"),
		ids: Object.freeze(ids),
	});
}

export function renderMemorySearch(ranked: readonly RankedMemory[]): string {
	return selectMemorySearch(ranked).text;
}
