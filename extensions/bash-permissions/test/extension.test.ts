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

async function startSession(
	yellowRules: readonly Record<string, unknown>[] = [],
	redRules: readonly Record<string, unknown>[] = [],
): Promise<{ readonly fake: FakeExtension; readonly context: ExtensionContext }> {
	const { dependencies } = await makeDependencies(yellowRules, redRules);
	const fake = createFakeExtension();
	const { context } = createContext("/work/project");
	registerBashPermissions(fake.api, dependencies);
	await fake.invoke("session_start", sessionStartEvent, context);
	await fake.invoke("turn_start", turnStartEvent, context);
	return { fake, context };
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

		expect(ui.setStatus).toHaveBeenCalledWith("bash-permissions", undefined);
		expect(ui.notify).toHaveBeenCalledOnce();
		expect(ui.notify.mock.calls[0]?.[0]).toContain(join(agentDir, "bash-permissions", "yellow.json"));
		expect(ui.notify.mock.calls[0]?.[0]).toContain(join(agentDir, "bash-permissions", "red.json"));

		await fake.invoke("session_start", { ...sessionStartEvent, reason: "reload" }, context);
		expect(ui.notify).toHaveBeenCalledOnce();
		expect(ui.setStatus).toHaveBeenLastCalledWith("bash-permissions", undefined);
	});

	it("creates configuration without normal notifications in no-UI modes", async () => {
		const { dependencies } = await makeDependencies();
		const fake = createFakeExtension();
		const { context, ui } = createContext("/work/project", false);
		registerBashPermissions(fake.api, dependencies);

		await fake.invoke("session_start", sessionStartEvent, context);

		expect(ui.notify).not.toHaveBeenCalled();
		expect(ui.setStatus).toHaveBeenCalledWith("bash-permissions", undefined);
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

		await expect(fake.invoke("session_start", sessionStartEvent, context)).resolves.toBeUndefined();
		expect(ui.setStatus).toHaveBeenCalledWith("bash-permissions", "bash-permissions: disabled");
		expect(ui.notify).not.toHaveBeenCalled();
		await expect(fake.invoke("tool_call", bashCall("danger"), context)).resolves.toBeUndefined();
	});

	it("keeps the session snapshot until reload and disables instead of retaining it when reload is invalid", async () => {
		const yellowRule = { name: "危险", pattern: "danger", type: "review", message: "复审" };
		const { dependencies, agentDir } = await makeDependencies([yellowRule]);
		const fake = createFakeExtension();
		const { context, ui } = createContext("/work/project");
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
		await expect(
			fake.invoke("session_start", { ...sessionStartEvent, reason: "reload" }, context),
		).resolves.toBeUndefined();
		expect(ui.setStatus).toHaveBeenCalledWith("bash-permissions", "bash-permissions: disabled");
		expect(ui.notify).toHaveBeenLastCalledWith(expect.stringMatching(/red\.json.*JSON 语法错误/s), "error");
		await expect(fake.invoke("tool_call", bashCall("danger", "call-4"), context)).resolves.toBeUndefined();

		await writeFile(join(agentDir, "bash-permissions", "red.json"), JSON.stringify({ version: 1, rules: [] }));
		await writeFile(
			join(agentDir, "bash-permissions", "yellow.json"),
			JSON.stringify({ version: 1, rules: [yellowRule] }),
		);
		await fake.invoke("session_start", { ...sessionStartEvent, reason: "reload" }, context);
		expect(ui.setStatus).toHaveBeenLastCalledWith("bash-permissions", undefined);
		await fake.invoke("turn_start", { ...turnStartEvent, turnIndex: 1 }, context);
		await expect(fake.invoke("tool_call", bashCall("danger", "call-5"), context)).resolves.toMatchObject({
			block: true,
		});
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

	it("blocks a wrapped Command when the Policy pattern matches only the Matching View", async () => {
		const { fake, context } = await startSession([
			{ name: "删除", pattern: "^rm -rf", type: "review", message: "复审删除" },
		]);

		await expect(fake.invoke("tool_call", bashCall("sudo rm -rf /tmp/x"), context)).resolves.toMatchObject({
			block: true,
			reason: expect.stringContaining("黄色风险"),
		});
	});

	it("peels env, assignments, bang, and path-prefixed wrappers from the start only", async () => {
		const { fake, context } = await startSession([
			{ name: "删除", pattern: "^rm -rf", type: "review", message: "复审删除" },
		]);

		for (const command of [
			"env FOO=1 rm -rf /tmp/x",
			"FOO=1 rm -rf /tmp/x",
			"! rm -rf /tmp/x",
			"/usr/bin/sudo -n rm -rf /tmp/x",
			"/bin/sudo rm -rf /tmp/x",
			"/sbin/doas rm -rf /tmp/x",
			"/usr/sbin/doas rm -rf /tmp/x",
			"sudo -- rm -rf /tmp/x",
			"command rm -rf /tmp/x",
			"time -p rm -rf /tmp/x",
			"nohup rm -rf /tmp/x",
			"exec -c rm -rf /tmp/x",
			"sudo rm -rf \\\n/tmp/x",
		]) {
			await expect(fake.invoke("tool_call", bashCall(command), context), command).resolves.toMatchObject({
				block: true,
			});
		}

		await expect(fake.invoke("tool_call", bashCall("true; rm -rf /tmp/x"), context)).resolves.toBeUndefined();
		await expect(
			fake.invoke("tool_call", bashCall("if rm -rf /tmp/x; then true; fi"), context),
		).resolves.toBeUndefined();
		await expect(fake.invoke("tool_call", bashCall("sudo -x rm -rf /tmp/x"), context)).resolves.toBeUndefined();
	});

	it("keeps the remaining command path after peeling a wrapper", async () => {
		const anchoredName = await startSession([
			{ name: "删除", pattern: "^rm -rf", type: "review", message: "复审删除" },
		]);
		await expect(
			anchoredName.fake.invoke("tool_call", bashCall("sudo /bin/rm -rf /tmp/x"), anchoredName.context),
		).resolves.toBeUndefined();

		const anchoredPath = await startSession([
			{ name: "删除", pattern: "^/bin/rm -rf", type: "review", message: "复审删除" },
		]);
		await expect(
			anchoredPath.fake.invoke("tool_call", bashCall("sudo /bin/rm -rf /tmp/x"), anchoredPath.context),
		).resolves.toMatchObject({ block: true });
	});

	it("still matches quoted literals and bash -c payloads that remain in the view", async () => {
		const { fake, context } = await startSession([
			{ name: "删除", pattern: "rm -rf", type: "review", message: "复审删除" },
		]);

		await expect(fake.invoke("tool_call", bashCall("echo 'rm -rf /tmp/x'"), context)).resolves.toMatchObject({
			block: true,
		});
		await expect(fake.invoke("tool_call", bashCall("bash -c 'rm -rf /tmp/x'"), context)).resolves.toMatchObject({
			block: true,
		});
	});

	it("stops peeling after 12 wrapper layers", async () => {
		const { fake, context } = await startSession([
			{ name: "删除", pattern: "^rm -rf", type: "review", message: "复审删除" },
		]);
		const twelve = `${"sudo ".repeat(12)}rm -rf /tmp/x`;
		const thirteen = `${"sudo ".repeat(13)}rm -rf /tmp/x`;

		await expect(fake.invoke("tool_call", bashCall(twelve), context)).resolves.toMatchObject({ block: true });
		await expect(fake.invoke("tool_call", bashCall(thirteen), context)).resolves.toBeUndefined();
	});

	it("uses Command text, not the Matching View, as yellow retry identity", async () => {
		const { fake, context } = await startSession([
			{ name: "删除", pattern: "^rm -rf", type: "review", message: "复审删除" },
		]);

		await expect(fake.invoke("tool_call", bashCall("  sudo rm -rf /tmp/x  "), context)).resolves.toMatchObject({
			block: true,
		});
		await fake.invoke("turn_end", turnEndEvent, context);
		await fake.invoke("turn_start", { ...turnStartEvent, turnIndex: 1 }, context);
		await expect(fake.invoke("tool_call", bashCall("sudo rm -rf /tmp/x"), context)).resolves.toBeUndefined();
		await expect(fake.invoke("tool_call", bashCall("env rm -rf /tmp/x", "call-2"), context)).resolves.toMatchObject({
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
