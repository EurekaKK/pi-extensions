import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import packageFactory from "../index.js";
import implementationFactory from "../src/index.js";

const PACKAGE_PATH = fileURLToPath(new URL("../package.json", import.meta.url));
const ROOT_ENTRY_PATH = fileURLToPath(new URL("../index.ts", import.meta.url));
const TSCONFIG_PATH = fileURLToPath(new URL("../tsconfig.json", import.meta.url));
const SRC_DIR_PATH = fileURLToPath(new URL("../src", import.meta.url));

interface ManifestShape {
	readonly files: readonly string[];
	readonly pi: { readonly extensions: readonly string[] };
	readonly dependencies?: Readonly<Record<string, string>>;
	readonly peerDependencies?: Readonly<Record<string, string>>;
	readonly devDependencies?: Readonly<Record<string, string>>;
	readonly piExtensionDependencies?: unknown;
	readonly keywords?: readonly string[];
	readonly private?: boolean;
	readonly type?: string;
}

async function readManifest(): Promise<ManifestShape> {
	return JSON.parse(await readFile(PACKAGE_PATH, "utf8")) as ManifestShape;
}

async function listTypeScriptFiles(directory: string): Promise<readonly string[]> {
	const files: string[] = [];
	for (const entry of await readdir(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) files.push(...(await listTypeScriptFiles(path)));
		if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
	}
	return files.sort();
}

interface SourceInspection {
	readonly modules: ReadonlySet<string>;
	readonly calls: ReadonlySet<string>;
}

function inspectSource(source: string): SourceInspection {
	const modules = new Set<string>();
	const calls = new Set<string>();
	const modulePatterns = [
		/\bfrom\s+["']([^"']+)["']/gu,
		/\bimport\s+["']([^"']+)["']/gu,
		/\b(?:import|require)\s*\(\s*["']([^"']+)["']/gu,
	];
	for (const pattern of modulePatterns) {
		for (const match of source.matchAll(pattern)) {
			const specifier = match[1];
			if (specifier !== undefined) modules.add(specifier);
		}
	}
	for (const match of source.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/gu)) {
		const call = match[1];
		if (call !== undefined) calls.add(call);
	}
	return { modules, calls };
}

describe("memory package boundary", () => {
	it("re-exports the implementation factory from the package root", () => {
		expect(packageFactory).toBe(implementationFactory);
	});

	it("publishes only the root Pi entry so Pi resolves the package as `memory` exactly once", async () => {
		const manifest = await readManifest();
		const tsconfig = JSON.parse(await readFile(TSCONFIG_PATH, "utf8")) as {
			readonly include: readonly string[];
		};
		const rootEntry = await readFile(ROOT_ENTRY_PATH, "utf8");

		expect(manifest.pi.extensions).toEqual(["./index.ts"]);
		expect(manifest.files).toContain("index.ts");
		expect(tsconfig.include).toContain("index.ts");
		expect(rootEntry).toBe('export { default } from "./src/index.js";\n');
		// Pi derives the startup label from the root entry's parent directory:
		// loading `./index.ts` must present the package as `memory`, never as
		// `src` and never twice. A real Pi load from the package root with
		// temporary agent/working directories is the separate manual smoke step.
		expect(basename(dirname(ROOT_ENTRY_PATH))).toBe("memory");
		expect(manifest.pi.extensions.length).toBe(1);
		expect(manifest.pi.extensions[0]).not.toContain("src");
	});

	it("declares no sibling-extension dependency and only the internal config-store runtime dependency", async () => {
		const manifest = await readManifest();

		// Runtime dependencies are exactly the internal shared package vendored by the
		// install script. Any sibling extension, provider SDK, SQLite, vector library,
		// or other new runtime dependency would fail this exact match.
		expect(manifest.dependencies).toEqual({ "config-store": "*" });
		// No installation-phase dependency on any sibling extension.
		expect(manifest.piExtensionDependencies).toBeUndefined();
		// Peer scope stays limited to Pi-provided packages; the retired
		// @mariozechner/* scope must never reappear.
		expect(Object.keys(manifest.peerDependencies ?? {}).sort()).toEqual([
			"@earendil-works/pi-ai",
			"@earendil-works/pi-coding-agent",
			"@earendil-works/pi-tui",
			"typebox",
		]);
		// Published file list must carry the root adapter and implementation sources.
		expect(manifest.files).toEqual(expect.arrayContaining(["index.ts", "src/**/*.ts", "README.md"]));
	});

	it("keeps the package private, ESM, and tagged as a Pi package without a release version", async () => {
		const manifest = await readManifest();

		expect(manifest.private).toBe(true);
		expect(manifest.type).toBe("module");
		expect(manifest.keywords).toContain("pi-package");
	});

	it("uses no forbidden runtime resources: network, workers, timers, watchers, or sockets", async () => {
		const sources = new Map<string, SourceInspection>();
		for (const path of await listTypeScriptFiles(SRC_DIR_PATH)) {
			const file = relative(SRC_DIR_PATH, path);
			const source = await readFile(path, "utf8");
			sources.set(file, inspectSource(source));
		}

		// v1 must stay local-first: no networking, worker, timer, watcher, or socket
		// modules anywhere in the implementation (the manifest test above already
		// forbids third-party providers; this pins the Node built-in surface).
		const forbiddenBuiltins = [
			"node:http",
			"node:https",
			"node:net",
			"node:tls",
			"node:dgram",
			"node:worker_threads",
			"node:cluster",
			"node:timers",
			"node:timers/promises",
		];
		for (const [file, inspection] of sources) {
			for (const mod of forbiddenBuiltins) {
				expect(inspection.modules.has(mod), `${file} must not import ${mod}`).toBe(false);
			}
			for (const call of ["setTimeout", "setInterval"]) {
				expect(inspection.calls.has(call), `${file} must not schedule ${call}`).toBe(false);
			}
			for (const call of ["watch", "watchFile", "unstable_watch"]) {
				expect(inspection.calls.has(call), `${file} must not start ${call}`).toBe(false);
			}
		}

		// Only the advisory Git diagnostic may spawn a short-lived child process,
		// and only from git.ts with its timeout/cancellation handling.
		const childProcessFiles = [...sources]
			.filter(([, inspection]) => inspection.modules.has("node:child_process"))
			.map(([file]) => file);
		expect(childProcessFiles).toEqual(["git.ts"]);

		// Every non-Node import is either a Pi peer, the internal shared package, or
		// a relative module. Anything else (provider SDK, SQLite, vector store, …)
		// fails here even if it sneaks past the manifest test.
		const allowedImports = new Set([
			"@earendil-works/pi-ai",
			"@earendil-works/pi-coding-agent",
			"@earendil-works/pi-tui",
			"config-store",
			"typebox",
		]);
		for (const [file, inspection] of sources) {
			for (const specifier of inspection.modules) {
				if (specifier.startsWith("node:") || specifier.startsWith(".")) continue;
				expect(allowedImports.has(specifier), `${file} imports forbidden module ${specifier}`).toBe(true);
			}
		}
	});
});
