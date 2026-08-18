import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import packageFactory from "../index.js";
import implementationFactory from "../src/index.js";

const PACKAGE_PATH = fileURLToPath(new URL("../package.json", import.meta.url));
const ROOT_ENTRY_PATH = fileURLToPath(new URL("../index.ts", import.meta.url));
const TSCONFIG_PATH = fileURLToPath(new URL("../tsconfig.json", import.meta.url));

describe("sub-agent v2 package boundary", () => {
	it("re-exports the implementation factory from the package root", () => {
		expect(packageFactory).toBe(implementationFactory);
	});

	it("publishes only the root Pi entry and has no sidecar build", async () => {
		const manifest = JSON.parse(await readFile(PACKAGE_PATH, "utf8")) as {
			readonly files: readonly string[];
			readonly scripts: Record<string, string>;
			readonly pi: { readonly extensions: readonly string[] };
		};
		const tsconfig = JSON.parse(await readFile(TSCONFIG_PATH, "utf8")) as {
			readonly include: readonly string[];
		};
		const rootEntry = await readFile(ROOT_ENTRY_PATH, "utf8");

		expect(manifest.pi.extensions).toEqual(["./index.ts"]);
		expect(manifest.files).toContain("index.ts");
		expect(manifest.files).not.toContain("sidecar/**/*.ts");
		expect(manifest.scripts.prepare).toBeUndefined();
		expect(manifest.scripts.prebuild).toBeUndefined();
		expect(tsconfig.include).toContain("index.ts");
		expect(rootEntry).toBe('export { default } from "./src/index.js";\n');
	});
});
