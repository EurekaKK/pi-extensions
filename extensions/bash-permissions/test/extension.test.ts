import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import packageEntry from "../index.js";
import bashPermissions, { type BashPermissionsDependencies, registerBashPermissions } from "../src/index.js";

type RegisteredHandler = (...arguments_: unknown[]) => unknown;

interface FakeExtension {
	readonly api: ExtensionAPI;
	invoke(eventName: string, event: unknown, context: ExtensionContext): Promise<unknown>;
}

interface FakeUi {
	readonly notify: ReturnType<typeof vi.fn>;
	readonly setStatus: ReturnType<typeof vi.fn>;
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function makeTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "bash-permissions-extension-test-"));
	temporaryDirectories.push(directory);
	return directory;
}

function createFakeExtension(): FakeExtension {
	const handlers = new Map<string, RegisteredHandler[]>();
	const api = {
		on(eventName: string, handler: unknown): void {
			const existing = handlers.get(eventName) ?? [];
			existing.push(handler as RegisteredHandler);
			handlers.set(eventName, existing);
		},
	} as unknown as ExtensionAPI;

	return {
		api,
		async invoke(eventName: string, event: unknown, context: ExtensionContext): Promise<unknown> {
			let result: unknown;
			for (const handler of handlers.get(eventName) ?? []) {
				result = await handler(event, context);
			}
			return result;
		},
	};
}

function createContext(cwd: string, hasUI = true): { readonly context: ExtensionContext; readonly ui: FakeUi } {
	const ui: FakeUi = {
		notify: vi.fn(),
		setStatus: vi.fn(),
	};
	const context = {
		cwd,
		hasUI,
		mode: hasUI ? "tui" : "print",
		ui,
	} as unknown as ExtensionContext;
	return { context, ui };
}

async function makeDependencies(
	yellowRules: readonly Record<string, unknown>[] = [],
	redRules: readonly Record<string, unknown>[] = [],
): Promise<{
	readonly dependencies: BashPermissionsDependencies;
	readonly agentDir: string;
	readonly defaultsDir: string;
}> {
	const root = await makeTemporaryDirectory();
	const agentDir = join(root, "agent");
	const defaultsDir = join(root, "defaults");
	await mkdir(defaultsDir, { recursive: true });
	await Promise.all([
		writeFile(join(defaultsDir, "yellow.json"), JSON.stringify({ version: 1, rules: yellowRules })),
		writeFile(join(defaultsDir, "red.json"), JSON.stringify({ version: 1, rules: redRules })),
	]);
	return {
		agentDir,
		defaultsDir,
		dependencies: {
			getAgentDir: () => agentDir,
			getHomeDir: () => "/users/test",
			defaultsDir,
			withFileMutationQueue: async <T>(_path: string, mutation: () => Promise<T>): Promise<T> => mutation(),
		},
	};
}

const sessionStartEvent = { type: "session_start", reason: "startup" };
const turnStartEvent = { type: "turn_start", turnIndex: 0, timestamp: 0 };
const turnEndEvent = { type: "turn_end", turnIndex: 0, message: { role: "assistant" }, toolResults: [] };

function bashCall(command: string, id = "call-1"): Record<string, unknown> {
	return { type: "tool_call", toolCallId: id, toolName: "bash", input: { command } };
}

describe("bash-permissions extension lifecycle", () => {
	it("exports a Pi extension factory", () => {
		expect(bashPermissions).toBeTypeOf("function");
		expect(packageEntry).toBe(bashPermissions);
	});

	it("creates missing configuration and reports its paths once without a persistent enabled status", async () => {
		const { dependencies, agentDir } = await makeDependencies();
		const fake = createFakeExtension();
		const { context, ui } = createContext("/work/project");
		registerBashPermissions(fake.api, dependencies);

		await fake.invoke("session_start", sessionStartEvent, context);

		expect(ui.setStatus).not.toHaveBeenCalled();
		expect(ui.notify).toHaveBeenCalledOnce();
		expect(ui.notify.mock.calls[0]?.[0]).toContain(join(agentDir, "bash-permissions", "yellow.json"));
		expect(ui.notify.mock.calls[0]?.[0]).toContain(join(agentDir, "bash-permissions", "red.json"));

		await fake.invoke("session_start", { ...sessionStartEvent, reason: "reload" }, context);
		expect(ui.notify).toHaveBeenCalledOnce();
		expect(ui.setStatus).not.toHaveBeenCalled();
	});

	it("creates configuration without normal notifications in no-UI modes", async () => {
		const { dependencies } = await makeDependencies();
		const fake = createFakeExtension();
		const { context, ui } = createContext("/work/project", false);
		registerBashPermissions(fake.api, dependencies);

		await fake.invoke("session_start", sessionStartEvent, context);

		expect(ui.notify).not.toHaveBeenCalled();
		expect(ui.setStatus).not.toHaveBeenCalled();
	});

	it("leaves bash untouched before initialization and after a disabled initialization", async () => {
		const { dependencies, agentDir } = await makeDependencies();
		const fake = createFakeExtension();
		const { context, ui } = createContext("/work/project", false);
		registerBashPermissions(fake.api, dependencies);

		await expect(fake.invoke("tool_call", bashCall("danger"), context)).resolves.toBeUndefined();
		await mkdir(join(agentDir, "bash-permissions"), { recursive: true });
		await Promise.all([
			writeFile(join(agentDir, "bash-permissions", "yellow.json"), "not json"),
			writeFile(join(agentDir, "bash-permissions", "red.json"), JSON.stringify({ version: 1, rules: [] })),
		]);

		await expect(fake.invoke("session_start", sessionStartEvent, context)).rejects.toThrow(
			/extension 没有正常运行.*bash 调用不受其保护/s,
		);
		expect(ui.setStatus).toHaveBeenCalledWith("bash-permissions", "bash-permissions: disabled");
		expect(ui.notify).not.toHaveBeenCalled();
		await expect(fake.invoke("tool_call", bashCall("danger"), context)).resolves.toBeUndefined();
	});

	it("keeps the session snapshot until reload and disables instead of retaining it when reload is invalid", async () => {
		const yellowRule = { name: "危险", pattern: "danger", type: "review", message: "复审" };
		const { dependencies, agentDir } = await makeDependencies([yellowRule]);
		const fake = createFakeExtension();
		const { context } = createContext("/work/project");
		registerBashPermissions(fake.api, dependencies);
		await fake.invoke("session_start", sessionStartEvent, context);
		await fake.invoke("turn_start", turnStartEvent, context);

		await expect(fake.invoke("tool_call", bashCall("danger"), context)).resolves.toMatchObject({ block: true });
		await writeFile(join(agentDir, "bash-permissions", "yellow.json"), JSON.stringify({ version: 1, rules: [] }));
		await expect(fake.invoke("tool_call", bashCall("danger", "call-2"), context)).resolves.toMatchObject({
			block: true,
		});

		await fake.invoke("session_start", { ...sessionStartEvent, reason: "reload" }, context);
		await expect(fake.invoke("tool_call", bashCall("danger", "call-3"), context)).resolves.toBeUndefined();

		await writeFile(join(agentDir, "bash-permissions", "red.json"), "{");
		await expect(fake.invoke("session_start", { ...sessionStartEvent, reason: "reload" }, context)).rejects.toThrow(
			/red\.json.*JSON 语法错误/,
		);
		await expect(fake.invoke("tool_call", bashCall("danger", "call-4"), context)).resolves.toBeUndefined();
	});

	it("clears state and status on session shutdown", async () => {
		const { dependencies } = await makeDependencies([
			{ name: "危险", pattern: "danger", type: "review", message: "复审" },
		]);
		const fake = createFakeExtension();
		const { context, ui } = createContext("/work/project");
		registerBashPermissions(fake.api, dependencies);
		await fake.invoke("session_start", sessionStartEvent, context);

		await fake.invoke("session_shutdown", { type: "session_shutdown", reason: "reload" }, context);

		expect(ui.setStatus).toHaveBeenLastCalledWith("bash-permissions", undefined);
		await expect(fake.invoke("tool_call", bashCall("danger"), context)).resolves.toBeUndefined();
	});
});

describe("bash-permissions tool-call integration", () => {
	it("blocks yellow duplicates in one response and allows only one retry in the next response", async () => {
		const { dependencies } = await makeDependencies([
			{ name: "危险", pattern: "danger", type: "review", message: "复审" },
		]);
		const fake = createFakeExtension();
		const { context } = createContext("/work/project");
		registerBashPermissions(fake.api, dependencies);
		await fake.invoke("session_start", sessionStartEvent, context);
		await fake.invoke("turn_start", turnStartEvent, context);

		await expect(fake.invoke("tool_call", bashCall("danger", "call-1"), context)).resolves.toMatchObject({
			block: true,
			reason: expect.stringContaining("黄色风险"),
		});
		await expect(fake.invoke("tool_call", bashCall("danger", "call-2"), context)).resolves.toMatchObject({
			block: true,
		});
		await fake.invoke("turn_end", turnEndEvent, context);
		await fake.invoke("turn_start", { ...turnStartEvent, turnIndex: 1 }, context);
		await expect(fake.invoke("tool_call", bashCall("danger", "call-3"), context)).resolves.toBeUndefined();
		await expect(fake.invoke("tool_call", bashCall("danger", "call-4"), context)).resolves.toMatchObject({
			block: true,
		});
	});

	it("invalidates a grant when a user input or delivered user message arrives", async () => {
		const { dependencies } = await makeDependencies([
			{ name: "危险", pattern: "danger", type: "review", message: "复审" },
		]);
		const fake = createFakeExtension();
		const { context } = createContext("/work/project");
		registerBashPermissions(fake.api, dependencies);
		await fake.invoke("session_start", sessionStartEvent, context);
		await fake.invoke("turn_start", turnStartEvent, context);
		await fake.invoke("tool_call", bashCall("danger"), context);
		await fake.invoke("input", { type: "input", text: "new request", source: "interactive" }, context);
		await fake.invoke("turn_end", turnEndEvent, context);
		await fake.invoke("turn_start", { ...turnStartEvent, turnIndex: 1 }, context);
		await expect(fake.invoke("tool_call", bashCall("danger", "call-2"), context)).resolves.toMatchObject({
			block: true,
		});

		await fake.invoke("message_start", { type: "message_start", message: { role: "user", content: [] } }, context);
		await fake.invoke("turn_end", { ...turnEndEvent, turnIndex: 1 }, context);
		await fake.invoke("turn_start", { ...turnStartEvent, turnIndex: 2 }, context);
		await expect(fake.invoke("tool_call", bashCall("danger", "call-3"), context)).resolves.toMatchObject({
			block: true,
		});
	});

	it("invalidates a grant after session-tree navigation", async () => {
		const { dependencies } = await makeDependencies([
			{ name: "危险", pattern: "danger", type: "review", message: "复审" },
		]);
		const fake = createFakeExtension();
		const { context } = createContext("/work/project");
		registerBashPermissions(fake.api, dependencies);
		await fake.invoke("session_start", sessionStartEvent, context);
		await fake.invoke("turn_start", turnStartEvent, context);
		await fake.invoke("tool_call", bashCall("danger"), context);
		await fake.invoke("session_tree", { type: "session_tree", oldLeafId: "old", newLeafId: "new" }, context);
		await fake.invoke("turn_end", turnEndEvent, context);
		await fake.invoke("turn_start", { ...turnStartEvent, turnIndex: 1 }, context);

		await expect(fake.invoke("tool_call", bashCall("danger", "call-2"), context)).resolves.toMatchObject({
			block: true,
		});
	});

	it("returns every red match, never releases it, and ignores non-bash calls", async () => {
		const { dependencies } = await makeDependencies(
			[{ name: "黄色重叠", pattern: "danger", type: "review", message: "黄" }],
			[
				{ name: "红一", pattern: "danger", message: "红色一" },
				{ name: "红二", pattern: "danger|disaster", message: "红色二" },
			],
		);
		const fake = createFakeExtension();
		const { context } = createContext("/work/project");
		registerBashPermissions(fake.api, dependencies);
		await fake.invoke("session_start", sessionStartEvent, context);
		await fake.invoke("turn_start", turnStartEvent, context);

		const first = await fake.invoke("tool_call", bashCall("danger"), context);
		expect(first).toMatchObject({ block: true, reason: expect.stringContaining("红色风险") });
		expect(first).toMatchObject({ reason: expect.stringContaining("红一：红色一") });
		expect(first).toMatchObject({ reason: expect.stringContaining("红二：红色二") });
		await fake.invoke("turn_end", turnEndEvent, context);
		await fake.invoke("turn_start", { ...turnStartEvent, turnIndex: 1 }, context);
		await expect(fake.invoke("tool_call", bashCall("danger", "call-2"), context)).resolves.toMatchObject({
			block: true,
		});
		await expect(
			fake.invoke(
				"tool_call",
				{ type: "tool_call", toolCallId: "read-1", toolName: "read", input: { path: "danger" } },
				context,
			),
		).resolves.toBeUndefined();
	});
});
