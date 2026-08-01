import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import packageEntry from "../index.js";
import sourceEntry from "../src/index.js";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("goal package", () => {
	it("exports the source factory through the root naming adapter", () => {
		expect(packageEntry).toBe(sourceEntry);
		expect(packageEntry).toBeTypeOf("function");
	});

	it("declares only the package root as its Pi entry", async () => {
		const manifest = JSON.parse(await readFile(resolve(packageDirectory, "package.json"), "utf8")) as {
			pi?: { extensions?: unknown };
			files?: unknown;
		};
		expect(manifest.pi?.extensions).toEqual(["./index.ts"]);
		expect(manifest.files).toContain("index.ts");
	});
});
