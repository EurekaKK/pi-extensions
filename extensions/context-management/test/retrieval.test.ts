import { describe, expect, it } from "vitest";
import {
	assembleMemoryPack,
	buildActivationQuery,
	lexicalTerms,
	rankMemoryRecords,
	selectMemorySearch,
} from "../src/memory/retrieval.js";
import { createMemoryFingerprint, createMemoryId, type MemoryRecord } from "../src/memory/schema.js";

function record(input: {
	idTime: number;
	title: string;
	summary: string;
	body: string;
	paths?: readonly string[];
}): MemoryRecord {
	const scope = { kind: "repository" as const, paths: input.paths ?? [] };
	const fields = {
		kind: "learning" as const,
		title: input.title,
		summary: input.summary,
		contentMarkdown: input.body,
		scope,
		supersedes: [],
	};
	return {
		id: createMemoryId(input.idTime),
		...fields,
		origin: { sessionId: "s", entryId: null, gitBranch: null, gitHead: null, trigger: "primary-agent-tool" },
		createdAt: new Date(input.idTime).toISOString(),
		fingerprint: createMemoryFingerprint(fields),
		supersededBy: null,
	};
}

describe("memory retrieval", () => {
	it("tokenizes camel, snake, kebab, and Han unigram/bigram", () => {
		const terms = lexicalTerms("contextManager foo_bar baz-qux 上下文");
		expect(terms).toEqual(
			expect.arrayContaining(["context", "manager", "foo", "bar", "baz", "qux", "上", "下", "文", "上下", "下文"]),
		);
	});

	it("requires an explicit path for path-scoped automatic activation", () => {
		const scoped = record({
			idTime: 1,
			title: "Parser",
			summary: "Parser rules",
			body: "details",
			paths: ["src/parser"],
		});
		expect(rankMemoryRecords([scoped], buildActivationQuery("fix parser"), null)).toHaveLength(0);
		expect(rankMemoryRecords([scoped], buildActivationQuery("fix src/parser/index.ts"), null)).toHaveLength(1);
	});

	it("recognizes an exact root-level file literal for path applicability", () => {
		const scoped = record({
			idTime: 1,
			title: "Repository guide",
			summary: "Documentation rules",
			body: "details",
			paths: ["README.md"],
		});
		expect(rankMemoryRecords([scoped], buildActivationQuery("update `README.md`"), null)).toHaveLength(1);
		expect(rankMemoryRecords([scoped], buildActivationQuery("update documentation"), null)).toHaveLength(0);
	});

	it("uses title/summary matches before body-only matches", () => {
		const title = record({ idTime: 1, title: "Checkpoint", summary: "rolling", body: "other" });
		const body = record({ idTime: 2, title: "Other", summary: "other", body: "checkpoint" });
		const ranked = rankMemoryRecords([body, title], buildActivationQuery("checkpoint"), null);
		expect(ranked.map((item) => item.record.id)).toEqual([title.id, body.id]);
	});

	it("retains a full path found in record Markdown as an exact ranking literal", () => {
		const pathRecord = record({
			idTime: 1,
			title: "Location",
			summary: "implementation location",
			body: "The implementation lives at src/runtime/compiler.ts.",
		});
		const ranked = rankMemoryRecords([pathRecord], buildActivationQuery("inspect src/runtime/compiler.ts"), null);
		expect(ranked[0]?.group).toBe(1);
	});

	it("downgrades a large first record and still admits a later small record", () => {
		const large = record({ idTime: 1, title: "Large", summary: "match", body: "x".repeat(5_000) });
		const small = record({ idTime: 2, title: "Small", summary: "match", body: "short" });
		const ranked = rankMemoryRecords([large, small], buildActivationQuery("match"), null);
		const pack = assembleMemoryPack(ranked, 300);
		expect(pack.items.some((item) => item.id === large.id && item.representation === "stub")).toBe(true);
		expect(pack.items.some((item) => item.id === small.id)).toBe(true);
		expect(pack.estimatedTokens).toBeLessThanOrEqual(300);
	});

	it("stops explicit search at ten stubs or the 4096-token boundary", () => {
		const small = Array.from({ length: 12 }, (_, index) =>
			record({ idTime: index + 1, title: `Small ${index}`, summary: "match", body: "short" }),
		);
		expect(selectMemorySearch(rankMemoryRecords(small, buildActivationQuery("match"), null)).ids).toHaveLength(10);

		const oversized = record({
			idTime: 100,
			title: "Oversized",
			summary: "match",
			body: "body",
			paths: Array.from({ length: 1_200 }, (_, index) => `src/generated/path-${index}`),
		});
		const selected = selectMemorySearch([
			{ record: oversized, group: 1, score: 1, preceding: false },
			...rankMemoryRecords(small, buildActivationQuery("match"), null),
		]);
		expect(selected.ids).toEqual([]);
		expect(selected.text).toBe("[context-management: no applicable memory matched]");
	});
});
