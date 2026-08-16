import type { CompactionEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	coveredThroughEntryId,
	createCompactionDetails,
	parseCompactionDetails,
	restoreLatestCheckpoint,
} from "../src/compaction/details.js";

function compaction(input: {
	id: string;
	summary: string;
	firstKeptEntryId: string;
	details?: unknown;
	parentId?: string | null;
}): CompactionEntry {
	return {
		type: "compaction",
		id: input.id,
		parentId: input.parentId ?? null,
		timestamp: "2026-08-16T00:00:00.000Z",
		summary: input.summary,
		firstKeptEntryId: input.firstKeptEntryId,
		tokensBefore: 1_000,
		...(input.details === undefined ? {} : { details: input.details }),
	};
}

describe("checkpoint durable details", () => {
	it("round trips strict details and canonicalizes reachable references", () => {
		const details = createCompactionDetails({
			summary: "checkpoint",
			coveredThroughEntryId: "covered",
			firstKeptEntryId: "kept",
			sourceFingerprint: "source",
			evidenceReferences: ["cm-evidence:v1:z", "cm-evidence:v1:a", "cm-evidence:v1:z"],
			now: new Date("2026-08-16T00:00:00.000Z"),
		});
		expect(parseCompactionDetails(details)).toEqual(details);
		expect(details.evidenceReferences).toEqual(["cm-evidence:v1:a", "cm-evidence:v1:z"]);
		expect(parseCompactionDetails({ ...details, sourceFingerprint: "not-a-hash" })).toBeNull();
	});

	it("restores an extension checkpoint only when carrier and fingerprints agree", () => {
		const details = createCompactionDetails({
			summary: "checkpoint",
			coveredThroughEntryId: "covered",
			firstKeptEntryId: "kept",
			sourceFingerprint: "source",
			evidenceReferences: [],
		});
		expect(
			restoreLatestCheckpoint([compaction({ id: "cp", summary: "checkpoint", firstKeptEntryId: "kept", details })]),
		).toMatchObject({ kind: "context-management", entryId: "cp", details });
		expect(
			restoreLatestCheckpoint([compaction({ id: "cp", summary: "tampered", firstKeptEntryId: "kept", details })]),
		).toMatchObject({ kind: "legacy", entryId: "cp" });
	});

	it("adopts the latest foreign Pi compaction as an opaque legacy checkpoint", () => {
		const entries: SessionEntry[] = [
			compaction({ id: "older", summary: "older", firstKeptEntryId: "a" }),
			compaction({ id: "latest", summary: "opaque", firstKeptEntryId: "b", parentId: "older" }),
		];
		expect(restoreLatestCheckpoint(entries)).toEqual({
			kind: "legacy",
			entryId: "latest",
			summary: "opaque",
			firstKeptEntryId: "b",
			tokensBefore: 1_000,
		});
	});

	it("derives the covered boundary immediately before the retained entry", () => {
		const entries = [{ id: "old" }, { id: "covered" }, { id: "kept" }] as SessionEntry[];
		expect(coveredThroughEntryId(entries, "kept")).toBe("covered");
		expect(coveredThroughEntryId(entries, "old")).toBeNull();
		expect(coveredThroughEntryId(entries, "missing")).toBeNull();
	});
});
