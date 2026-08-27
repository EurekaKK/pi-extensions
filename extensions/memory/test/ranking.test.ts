import { describe, expect, it } from "vitest";
import {
	compareRecency,
	countTokenOccurrences,
	extractSearchTokens,
	SUMMARY_WEIGHT,
	scoreSearchTokens,
} from "../src/ranking.js";

function counts(tokens: readonly string[]): ReadonlyMap<string, number> {
	return countTokenOccurrences(tokens);
}

function queryCounts(query: string): ReadonlyMap<string, number> {
	return countTokenOccurrences(extractSearchTokens(query));
}

function score(query: string, summary: string, content: string): number {
	return scoreSearchTokens(
		queryCounts(query),
		counts(extractSearchTokens(summary)),
		counts(extractSearchTokens(content)),
	);
}

describe("extractSearchTokens", () => {
	it("extracts Latin tokens with case folding", () => {
		expect(extractSearchTokens("npm Workspaces")).toEqual(["npm", "workspaces"]);
		expect(extractSearchTokens("NPM WORKSPACES")).toEqual(["npm", "workspaces"]);
	});

	it("keeps Unicode Latin letters and compatibility variants in normalized tokens", () => {
		expect(extractSearchTokens("CAFÉ naïve Ångström")).toEqual(["café", "naïve", "ångström"]);
		expect(extractSearchTokens("ＮＰＭ workspaces")).toEqual(["npm", "workspaces"]);
	});

	it("extracts numbers and digit-leading alphanumeric runs", () => {
		expect(extractSearchTokens("issue 42")).toEqual(["issue", "42"]);
		expect(extractSearchTokens("v2.5.1")).toEqual(["v2", "5", "1"]);
		expect(extractSearchTokens("2024 Q3")).toEqual(["2024", "q3"]);
	});

	it("folds punctuation variants into the same separators", () => {
		expect(extractSearchTokens("npm-workspaces")).toEqual(["npm", "workspaces"]);
		expect(extractSearchTokens("npm, workspaces!")).toEqual(["npm", "workspaces"]);
		expect(extractSearchTokens("npm_workspaces")).toEqual(["npm", "workspaces"]);
		expect(extractSearchTokens("don't stop")).toEqual(["don", "t", "stop"]);
	});

	it("produces overlapping Han bigrams with per-character tokens", () => {
		expect(extractSearchTokens("测试记忆")).toEqual(["测", "测试", "试", "试记", "记", "记忆", "忆"]);
		expect(extractSearchTokens("你好世界")).toEqual(["你", "你好", "好", "好世", "世", "世界", "界"]);
	});

	it("tokenizes supplementary-plane Han characters by code point, including Extensions H and I", () => {
		expect(extractSearchTokens("𠀀𠀁")).toEqual(["𠀀", "𠀀𠀁", "𠀁"]);
		expect(extractSearchTokens("\u{2ebf0}\u{31350}")).toEqual(["\u{2ebf0}", "\u{2ebf0}\u{31350}", "\u{31350}"]);
	});

	it("handles a single Han character deterministically as a unigram", () => {
		expect(extractSearchTokens("的")).toEqual(["的"]);
		expect(extractSearchTokens("TDD的")).toEqual(["tdd", "的"]);
	});

	it("handles mixed CJK/Latin text with independent runs", () => {
		expect(extractSearchTokens("TDD的测试")).toEqual(["tdd", "的", "的测", "测", "测试", "试"]);
		expect(extractSearchTokens("测试TDD功能")).toEqual(["测", "测试", "试", "tdd", "功", "功能", "能"]);
	});

	it("ignores non-Latin, non-Han scripts as separators without crashing", () => {
		expect(extractSearchTokens("npm てすと workspaces")).toEqual(["npm", "workspaces"]);
	});

	it("is idempotent under NFC and repeated folding", () => {
		const folded = "npm\u0301 workspaces"; // e + combining acute stays a single separator char
		expect(extractSearchTokens(folded)).toEqual(extractSearchTokens(extractSearchTokens(folded).join(" ")));
	});
});

describe("scoreSearchTokens", () => {
	it("scores exact case variant matches", () => {
		expect(score("NPM Workspaces", "Build uses npm workspaces", "plain content")).toBe(4);
	});

	it("scores numbers and punctuation variants", () => {
		expect(score("issue 42", "Issue #42 fixed", "release notes")).toBe(4);
		expect(score("npm-workspaces", "npm workspaces build", "content")).toBe(4);
	});

	it("scores overlapping Chinese bigrams", () => {
		expect(score("测试记忆", "测试记忆", "功能")).toBe(14);
		expect(score("记忆", "测试记忆", "其他")).toBe(6);
	});

	it("scores mixed CJK/Latin queries against mixed records", () => {
		expect(score("TDD 测试", "", "TDD的测试功能")).toBe(4);
		expect(score("TDD测试", "TDD的测试功能实现", "")).toBe(8);
	});

	it("scores a single Han character query inside any Han run", () => {
		expect(score("的", "的用法", "")).toBe(2);
		expect(score("的", "", "TDD的测试")).toBe(1);
	});

	it("returns zero when there is no lexical overlap at all", () => {
		expect(score("unrelated", "npm workspaces", "other content")).toBe(0);
	});

	it("amplifies repeated terms in the document (repeated-term scoring)", () => {
		expect(score("test", "", "test")).toBe(1);
		expect(score("test", "", "test test")).toBe(2);
		expect(score("test", "test test test", "")).toBe(6);
	});

	it("amplifies repeated terms in the query", () => {
		expect(score("test test", "", "test")).toBe(2);
		expect(score("test test", "", "test test")).toBe(4);
	});

	it("weighs summary matches explicitly heavier than content matches", () => {
		expect(SUMMARY_WEIGHT).toBe(2);
		expect(score("npm", "npm", "")).toBe(2);
		expect(score("npm", "", "npm")).toBe(1);
		expect(score("npm", "npm", "npm npm")).toBe(4);
	});

	it("ranks a summary match above a content-only match (sparse summaries still rank fairly)", () => {
		const summaryWins = score("npm", "npm", "");
		const contentOnly = score("npm", "", "npm");
		expect(summaryWins).toBeGreaterThan(contentOnly);
	});

	it("gives sparse summaries no advantage when they do not contain the terms", () => {
		// Sparse summary absent from the query terms: content alone decides.
		expect(score("npm", "build", "npm")).toBe(1);
		expect(score("npm", "build", "npm npm")).toBe(2);
	});
});

describe("compareRecency", () => {
	const base = { id: "rec-a", revision: 1, createdAt: "2025-01-01T00:00:00.000Z" };

	it("orders by updatedAt descending (recency)", () => {
		const older = { ...base, updatedAt: "2025-01-01T00:00:00.000Z" };
		const newer = { ...base, updatedAt: "2025-01-02T00:00:00.000Z" };
		expect(compareRecency(newer, older)).toBeLessThan(0);
		expect(compareRecency(older, newer)).toBeGreaterThan(0);
	});

	it("breaks updatedAt ties by createdAt descending", () => {
		const early = { ...base, updatedAt: "2025-01-02T00:00:00.000Z", createdAt: "2025-01-01T00:00:00.000Z" };
		const late = { ...base, updatedAt: "2025-01-02T00:00:00.000Z", createdAt: "2025-01-03T00:00:00.000Z" };
		expect(compareRecency(late, early)).toBeLessThan(0);
	});

	it("breaks full recency ties by id ascending then revision ascending", () => {
		const a1 = { ...base, updatedAt: "2025-01-02T00:00:00.000Z", createdAt: "2025-01-01T00:00:00.000Z" };
		const b1 = { ...a1, id: "rec-b" };
		const a2 = { ...a1, revision: 2 };
		expect(compareRecency(a1, b1)).toBeLessThan(0);
		expect(compareRecency(b1, a1)).toBeGreaterThan(0);
		expect(compareRecency(a1, a2)).toBeLessThan(0);
		expect(compareRecency(a2, a1)).toBeGreaterThan(0);
		expect(compareRecency(a1, a1)).toBe(0);
	});

	it("orders a stable total sequence equal to the documented tie-break ladder", () => {
		const records = [
			{
				...base,
				id: "rec-a",
				revision: 1,
				createdAt: "2025-01-01T00:00:00.000Z",
				updatedAt: "2025-01-01T00:00:00.000Z",
			},
			{
				...base,
				id: "rec-b",
				revision: 1,
				createdAt: "2025-01-01T00:00:00.000Z",
				updatedAt: "2025-01-01T00:00:00.000Z",
			},
			{
				...base,
				id: "rec-a",
				revision: 2,
				createdAt: "2025-01-01T00:00:00.000Z",
				updatedAt: "2025-01-01T00:00:00.000Z",
			},
			{
				...base,
				id: "rec-c",
				revision: 1,
				createdAt: "2025-01-02T00:00:00.000Z",
				updatedAt: "2025-01-01T00:00:00.000Z",
			},
			{
				...base,
				id: "rec-d",
				revision: 1,
				createdAt: "2025-01-01T00:00:00.000Z",
				updatedAt: "2025-01-03T00:00:00.000Z",
			},
		];
		const sorted = [...records].sort(compareRecency);
		expect(sorted.map((record) => `${record.id}#${record.revision}`)).toEqual([
			"rec-d#1",
			"rec-c#1",
			"rec-a#1",
			"rec-a#2",
			"rec-b#1",
		]);
	});
});
