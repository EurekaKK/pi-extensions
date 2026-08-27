import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { MEMORY_STORE_DIRECTORY_NAME, MEMORY_STORE_FILE_NAME } from "../src/constants.js";
import { getMemoryStoreDirectory, getMemoryStorePath } from "../src/store-layout.js";

async function tempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "memory-layout-"));
}

describe("Memory Store layout", () => {
	it("places the Store inside the Working Directory's Pi configuration area", async () => {
		const cwd = await tempDir();

		expect(getMemoryStoreDirectory(cwd)).toBe(join(cwd, CONFIG_DIR_NAME, MEMORY_STORE_DIRECTORY_NAME));
		expect(getMemoryStorePath(cwd)).toBe(
			join(cwd, CONFIG_DIR_NAME, MEMORY_STORE_DIRECTORY_NAME, MEMORY_STORE_FILE_NAME),
		);
	});
});
