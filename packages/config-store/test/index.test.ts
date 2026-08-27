import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	CONFIG_FILE_MODE,
	type FileMutationQueue,
	initializeStrictConfig,
	MAX_CONFIG_BYTES,
	readStrictJsonFile,
	StrictConfigError,
} from "../src/index.js";

function queue(): FileMutationQueue & { calls: string[] } {
	const calls: string[] = [];
	const run = <T>(_filePath: string, mutation: () => Promise<T>) => {
		calls.push(_filePath);
		return mutation();
	};
	return Object.assign(run, { calls });
}

async function tempAgentDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "config-store-"));
}

const DEFAULT_TEXT = '{"version":1,"enabled":true}\n';
const validate = (value: unknown, configPath: string): { version: number } => {
	if ((value as { version?: number }).version !== 1) throw new StrictConfigError(configPath, "version must equal 1");
	return { version: 1 };
};

describe("initializeStrictConfig", () => {
	it("creates the default config exclusively and validates it", async () => {
		const agentDir = await tempAgentDir();
		const q = queue();

		const result = await initializeStrictConfig({
			agentDir,
			directoryName: "ext",
			defaultText: DEFAULT_TEXT,
			validate,
			withFileMutationQueue: q,
		});

		expect(result.created).toBe(true);
		expect(result.configDir).toBe(join(agentDir, "ext"));
		expect(result.config).toEqual({ version: 1 });
		await expect(readFile(result.configPath, "utf8")).resolves.toBe(DEFAULT_TEXT);
		if (process.platform !== "win32") {
			const stat = await lstat(result.configPath);
			expect(stat.mode & 0o777).toBe(CONFIG_FILE_MODE);
		}
		expect(q.calls).toEqual([result.configPath]);
	});

	it("keeps an existing config and reports created=false", async () => {
		const agentDir = await tempAgentDir();
		const options = {
			agentDir,
			directoryName: "ext",
			defaultText: DEFAULT_TEXT,
			validate,
		};

		const first = await initializeStrictConfig({ ...options, withFileMutationQueue: queue() });
		await writeFile(first.configPath, '{"version":1,"enabled":false}\n', { encoding: "utf8", mode: 0o600 });

		const second = await initializeStrictConfig({ ...options, withFileMutationQueue: queue() });

		expect(second.created).toBe(false);
		expect(await readFile(second.configPath, "utf8")).toBe('{"version":1,"enabled":false}\n');
	});

	it("reads packaged defaults from a file when defaultText is absent", async () => {
		const agentDir = await tempAgentDir();
		const defaultsFile = join(agentDir, "packaged-default.json");
		await writeFile(defaultsFile, DEFAULT_TEXT, "utf8");

		const result = await initializeStrictConfig({
			agentDir,
			directoryName: "ext",
			defaultTextFile: defaultsFile,
			validate,
			withFileMutationQueue: queue(),
		});

		expect(result.created).toBe(true);
		expect(await readFile(result.configPath, "utf8")).toBe(DEFAULT_TEXT);
	});

	it("rejects a missing packaged defaults file with a stable message", async () => {
		const agentDir = await tempAgentDir();

		const promise = initializeStrictConfig({
			agentDir,
			directoryName: "ext",
			defaultTextFile: join(agentDir, "absent.json"),
			validate,
			withFileMutationQueue: queue(),
		});

		await expect(promise).rejects.toThrow(StrictConfigError);
		await expect(promise).rejects.toThrow(/cannot read package default config/);
	});

	it("requires one of defaultText or defaultTextFile", async () => {
		const agentDir = await tempAgentDir();
		const promise = initializeStrictConfig({
			agentDir,
			directoryName: "ext",
			// biome-ignore lint/suspicious/noExplicitAny: exercising a misuse the type system already prevents
			defaultText: undefined as any,
			validate,
			withFileMutationQueue: queue(),
		});
		await expect(promise).rejects.toThrow(/one of defaultText or defaultTextFile is required/);
	});

	it("rejects non-strict JSON, oversized files, invalid UTF-8, and directories with stable messages", async () => {
		const agentDir = await tempAgentDir();
		await mkdir(join(agentDir, "ext"), { recursive: true });
		const configPath = join(agentDir, "ext", "config.json");

		const cases: Array<[string | Uint8Array, string]> = [
			["not json", "file is not strict JSON"],
			[`"${"a".repeat(MAX_CONFIG_BYTES + 1)}"`, `file exceeds ${MAX_CONFIG_BYTES} UTF-8 bytes`],
		];
		for (const [contents, reason] of cases) {
			await writeFile(configPath, contents, { encoding: "utf8", mode: 0o600, flag: "w" });
			const promise = initializeStrictConfig({
				agentDir,
				directoryName: "ext",
				defaultText: DEFAULT_TEXT,
				validate,
				withFileMutationQueue: queue(),
			});
			await expect(promise).rejects.toThrow(StrictConfigError);
			await expect(promise).rejects.toThrow(`${configPath}: ${reason}`);
		}

		await writeFile(configPath, new Uint8Array([0xff, 0xfe]), { mode: 0o600, flag: "w" });
		const utf8Promise = initializeStrictConfig({
			agentDir,
			directoryName: "ext",
			defaultText: DEFAULT_TEXT,
			validate,
			withFileMutationQueue: queue(),
		});
		await expect(utf8Promise).rejects.toThrow("file is not valid UTF-8");

		await rm(configPath);
		await mkdir(configPath, { recursive: true });
		const promise = initializeStrictConfig({
			agentDir,
			directoryName: "ext",
			defaultText: DEFAULT_TEXT,
			validate,
			withFileMutationQueue: queue(),
		});
		await expect(promise).rejects.toThrow("config path must be a regular file");
	});

	it("hands the parsed value and the config path to validate", async () => {
		const agentDir = await tempAgentDir();
		let seenValue: unknown;
		let seenPath = "";
		const result = await initializeStrictConfig({
			agentDir,
			directoryName: "ext",
			defaultText: DEFAULT_TEXT,
			validate(value, configPath) {
				seenValue = value;
				seenPath = configPath;
				return { version: 1 };
			},
			withFileMutationQueue: queue(),
		});

		expect(seenValue).toEqual({ version: 1, enabled: true });
		expect(seenPath).toBe(result.configPath);
	});
});

describe("readStrictJsonFile", () => {
	async function file(): Promise<string> {
		const agentDir = await tempAgentDir();
		return join(agentDir, "data.json");
	}

	it("parses a strict JSON file", async () => {
		const filePath = await file();
		await writeFile(filePath, '{"version":1,"enabled":true}\n', "utf8");

		await expect(readStrictJsonFile({ filePath, maxBytes: 1024 })).resolves.toEqual({
			version: 1,
			enabled: true,
		});
	});

	it("rejects a missing file with the stable missing reason", async () => {
		const filePath = join(await tempAgentDir(), "absent.json");

		const promise = readStrictJsonFile({ filePath, maxBytes: 1024 });

		await expect(promise).rejects.toBeInstanceOf(StrictConfigError);
		await expect(promise).rejects.toMatchObject({ reason: "missing" });
	});

	it("rejects a directory with the not-regular-file reason and stable message", async () => {
		const filePath = await file();
		await mkdir(filePath, { recursive: true });

		const promise = readStrictJsonFile({ filePath, maxBytes: 1024 });

		await expect(promise).rejects.toMatchObject({ reason: "not-regular-file" });
		await expect(promise).rejects.toThrow("path must be a regular file");
	});

	it("rejects an oversized file with the over-limit reason and stable message", async () => {
		const filePath = await file();
		await writeFile(filePath, `"${"a".repeat(2048)}"`, "utf8");

		const promise = readStrictJsonFile({ filePath, maxBytes: 1024 });

		await expect(promise).rejects.toMatchObject({ reason: "over-limit" });
		await expect(promise).rejects.toThrow("file exceeds 1024 UTF-8 bytes");
	});

	it("rejects invalid UTF-8 with the invalid-utf8 reason", async () => {
		const filePath = await file();
		await writeFile(filePath, new Uint8Array([0xff, 0xfe, 0x00]));

		await expect(readStrictJsonFile({ filePath, maxBytes: 1024 })).rejects.toMatchObject({
			reason: "invalid-utf8",
		});
	});

	it("rejects non-strict JSON with the invalid-json reason", async () => {
		const filePath = await file();
		await writeFile(filePath, "{not json", "utf8");

		const promise = readStrictJsonFile({ filePath, maxBytes: 1024 });

		await expect(promise).rejects.toMatchObject({ reason: "invalid-json" });
		await expect(promise).rejects.toThrow("file is not strict JSON");
	});

	it("uses a custom label in diagnostics while keeping the strict JSON messages stable", async () => {
		const filePath = await file();
		await mkdir(filePath, { recursive: true });

		const promise = readStrictJsonFile({ filePath, maxBytes: 1024, label: "memory store" });

		await expect(promise).rejects.toMatchObject({ reason: "not-regular-file" });
		await expect(promise).rejects.toThrow("memory store path must be a regular file");
	});

	it("rejects a pre-aborted signal with the aborted reason", async () => {
		const filePath = await file();
		await writeFile(filePath, '{"ok":true}', "utf8");

		await expect(readStrictJsonFile({ filePath, maxBytes: 1024, signal: AbortSignal.abort() })).rejects.toMatchObject({
			reason: "aborted",
		});
	});
});
