import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import packageEntry from "../index.js";
import sourceEntry from "../src/index.js";

const PACKAGE_ROOT = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Pi package entry", () => {
	it("keeps the root naming adapter as a transparent factory re-export", () => {
		expect(packageEntry).toBe(sourceEntry);
	});

	it("publishes and activates only the root naming adapter", async () => {
		const manifest = JSON.parse(await readFile(join(PACKAGE_ROOT, "package.json"), "utf8")) as unknown;
		expect(manifest).toMatchObject({
			files: expect.arrayContaining(["index.ts"]),
			pi: {
				extensions: ["./index.ts"],
			},
		});
	});

	it("resolves the installed package to root index.ts instead of src/index.ts", async () => {
		const agentDir = await mkdtemp(join(tmpdir(), "tavily-package-entry-"));
		temporaryDirectories.push(agentDir);
		const loader = new DefaultResourceLoader({
			cwd: PACKAGE_ROOT,
			agentDir,
			additionalExtensionPaths: [PACKAGE_ROOT],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});

		await loader.reload();
		const result = loader.getExtensions();

		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0]?.resolvedPath).toBe(join(PACKAGE_ROOT, "index.ts"));
	});
});
