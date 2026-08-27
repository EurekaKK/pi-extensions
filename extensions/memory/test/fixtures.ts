import { MEMORY_STORE_SCHEMA, MEMORY_STORE_VERSION } from "../src/constants.js";
import type { MemoryProvenanceV1, MemoryRecordV1, MemoryStoreV1 } from "../src/store.js";

const TIMESTAMP = "2025-01-01T00:00:00.000Z";

export function provenanceFixture(overrides: Partial<MemoryProvenanceV1> = {}): MemoryProvenanceV1 {
	return {
		sessionId: "session-1",
		directoryId: "/tmp/memory-dir",
		author: "primary-agent",
		...(overrides.entryId === undefined ? {} : { entryId: overrides.entryId }),
		...overrides,
	};
}

export function recordFixture(overrides: Partial<MemoryRecordV1> = {}): MemoryRecordV1 {
	return {
		id: "rec-1",
		revision: 1,
		state: "active",
		summary: "Build uses npm workspaces",
		content: "The monorepo is managed with npm workspaces; never mix pnpm or Yarn.",
		supersedes: null,
		provenance: provenanceFixture(),
		createdAt: TIMESTAMP,
		updatedAt: TIMESTAMP,
		...overrides,
	};
}

export function storeFixture(
	overrides: Partial<MemoryStoreV1> = {},
	records: readonly MemoryRecordV1[] = [recordFixture()],
): MemoryStoreV1 {
	return {
		version: MEMORY_STORE_VERSION,
		schema: MEMORY_STORE_SCHEMA,
		revision: records.length === 0 ? 0 : 1,
		directory: { id: "/tmp/memory-dir" },
		records,
		...overrides,
	};
}

/** Serialize a fixture exactly as it would land on disk (strict JSON). */
export function storeText(fixture: object): string {
	return JSON.stringify(fixture, null, 2);
}
