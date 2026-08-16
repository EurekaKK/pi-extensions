import { describe, expect, it } from "vitest";
import { MEMORY_STORE_BYTE_LIMIT } from "../src/constants.js";
import {
	createMemoryFingerprint,
	createMemoryId,
	type MemoryEnvelope,
	type MemoryRecord,
	parseMemoryEnvelope,
	serializeMemoryEnvelope,
	validateMemoryAuthorFields,
} from "../src/memory/schema.js";

function envelope(contentMarkdown = "## Decision\n\nKeep one checkpoint."): MemoryEnvelope {
	const fields = validateMemoryAuthorFields({
		kind: "decision",
		title: "One checkpoint",
		summary: "Keep a single rolling checkpoint.",
		contentMarkdown,
		scope: { kind: "repository", paths: ["src/context/"] },
		supersedes: [],
	});
	return {
		schemaVersion: 1,
		repository: {
			key: "git-test",
			identityKind: "git-common-dir",
			canonicalPath: "/tmp/repo/.git",
			createdAt: "2026-08-16T00:00:00.000Z",
		},
		records: [
			{
				id: createMemoryId(1_700_000_000_000),
				...fields,
				origin: {
					sessionId: "session",
					entryId: null,
					gitBranch: "main",
					gitHead: "abc",
					trigger: "primary-agent-tool",
				},
				createdAt: "2026-08-16T00:00:00.000Z",
				fingerprint: createMemoryFingerprint(fields),
				supersededBy: null,
			},
		],
	};
}

function largeRecord(index: number): MemoryRecord {
	const fields = validateMemoryAuthorFields({
		kind: "learning",
		title: `Record ${index}`,
		summary: "Boundary fixture",
		contentMarkdown: "x".repeat(10_240),
		scope: { kind: "repository", paths: [] },
		supersedes: [],
	});
	return {
		id: createMemoryId(index + 1),
		...fields,
		origin: { sessionId: "session", entryId: null, gitBranch: null, gitHead: null, trigger: "primary-agent-tool" },
		createdAt: "2026-08-16T00:00:00.000Z",
		fingerprint: createMemoryFingerprint(fields),
		supersededBy: null,
	};
}

function serializedBytes(value: MemoryEnvelope): number {
	return Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("memory schema", () => {
	it("creates UUIDv7 record IDs", () => {
		expect(createMemoryId(1_700_000_000_000)).toMatch(/^mem_[0-9a-f-]{36}$/);
		expect(createMemoryId(1_700_000_000_000).split("-")[2]?.startsWith("7")).toBe(true);
	});

	it("round trips deterministic JSON with a trailing LF", () => {
		const value = envelope();
		const text = serializeMemoryEnvelope(value);
		expect(text.endsWith("\n")).toBe(true);
		expect(parseMemoryEnvelope(JSON.parse(text) as unknown, "git-test").records).toHaveLength(1);
		expect(serializeMemoryEnvelope(value)).toBe(text);
	});

	it("preserves content body whitespace while checking its trimmed value", () => {
		const fields = validateMemoryAuthorFields({
			kind: "learning",
			title: " Title ",
			summary: " Summary ",
			contentMarkdown: "\nBody\n",
			scope: { kind: "repository", paths: [] },
			supersedes: [],
		});
		expect(fields.title).toBe("Title");
		expect(fields.summary).toBe("Summary");
		expect(fields.contentMarkdown).toBe("\nBody\n");
	});

	it("accepts exactly 10 KiB and rejects one byte more", () => {
		expect(
			validateMemoryAuthorFields({
				kind: "learning",
				title: "t",
				summary: "s",
				contentMarkdown: "a".repeat(10_240),
				scope: { kind: "repository", paths: [] },
				supersedes: [],
			}).contentMarkdown,
		).toHaveLength(10_240);
		expect(() =>
			validateMemoryAuthorFields({
				kind: "learning",
				title: "t",
				summary: "s",
				contentMarkdown: "a".repeat(10_241),
				scope: { kind: "repository", paths: [] },
				supersedes: [],
			}),
		).toThrow(/10241 bytes/);
	});

	it("accepts an exact 8 MiB store and rejects the same valid store one byte over", () => {
		const repository = envelope().repository;
		const candidates = Array.from({ length: 800 }, (_, index) => largeRecord(index));
		let low = 0;
		let high = candidates.length;
		while (low < high) {
			const middle = Math.ceil((low + high) / 2);
			const candidate: MemoryEnvelope = { schemaVersion: 1, repository, records: candidates.slice(0, middle) };
			if (serializedBytes(candidate) <= MEMORY_STORE_BYTE_LIMIT) low = middle;
			else high = middle - 1;
		}
		const records = candidates.slice(0, low);
		const first = records[0];
		if (first === undefined) throw new Error("Expected at least one boundary fixture record.");
		const base: MemoryEnvelope = { schemaVersion: 1, repository, records };
		const padding = MEMORY_STORE_BYTE_LIMIT - serializedBytes(base);
		const title = `${first.title}${"z".repeat(padding)}`;
		const adjustedFields = { ...first, title };
		const adjusted: MemoryRecord = { ...first, title, fingerprint: createMemoryFingerprint(adjustedFields) };
		const exact: MemoryEnvelope = { ...base, records: [adjusted, ...records.slice(1)] };
		const exactText = serializeMemoryEnvelope(exact);
		expect(Buffer.byteLength(exactText, "utf8")).toBe(MEMORY_STORE_BYTE_LIMIT);

		const overTitle = `${adjusted.title}q`;
		const overFields = { ...adjusted, title: overTitle };
		const over: MemoryRecord = { ...adjusted, title: overTitle, fingerprint: createMemoryFingerprint(overFields) };
		expect(() => serializeMemoryEnvelope({ ...exact, records: [over, ...records.slice(1)] })).toThrow(
			new RegExp(`${MEMORY_STORE_BYTE_LIMIT + 1} bytes`),
		);
	});
});
