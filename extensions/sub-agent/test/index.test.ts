import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SUBAGENT_TOOL_NAMES, TOOL_DESCRIPTIONS } from "../src/contracts.js";

interface Reconciliation {
	toolCallId: string;
	persisted: boolean;
}

const mockedRuntime = vi.hoisted(() => ({
	agentDir: "",
	managerCreations: 0,
	pendingPersistenceIds: [] as string[],
	reconciliations: [] as Reconciliation[],
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
	DefaultPackageManager: class {
		async resolve(): Promise<{ extensions: [] }> {
			return { extensions: [] };
		}
	},
	SettingsManager: {
		create: () => ({
			getGlobalSettings: () => ({}),
			getProjectSettings: () => ({}),
		}),
	},
	getAgentDir: () => mockedRuntime.agentDir,
	getPackageDir: () => "/test/pi-package",
	withFileMutationQueue: async <T>(_filePath: string, mutation: () => Promise<T>): Promise<T> => await mutation(),
}));

vi.mock("../src/manager.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/manager.js")>();
	return {
		...actual,
		canonicalizeCandidateExtensionPaths: async () => [],
		SubagentManager: class {
			constructor() {
				mockedRuntime.managerCreations++;
			}

			updateParentSnapshot(): void {}

			parentTransientSnapshot(): { agents: []; readyDeliveries: [] } {
				return { agents: [], readyDeliveries: [] };
			}

			pendingPersistenceToolCallIds(): string[] {
				return [...mockedRuntime.pendingPersistenceIds];
			}

			async reconcileWait(toolCallId: string, persisted: boolean): Promise<void> {
				mockedRuntime.reconciliations.push({ toolCallId, persisted });
			}

			rollbackWait(): void {}

			async shutdown(): Promise<void> {}
		},
	};
});

import { registerSubagent } from "../src/index.js";

type Hook = (event: unknown, context: ExtensionContext) => unknown | Promise<unknown>;

interface RegisteredTool {
	name: string;
	label: string;
	description: string;
	executionMode?: string;
	parameters: unknown;
	prepareArguments?: (argumentsValue: unknown) => unknown;
	execute(
		toolCallId: string,
		parameters: unknown,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		context: ExtensionContext,
	): Promise<{
		content: unknown;
		details: unknown;
		isError?: boolean;
	}>;
}

class FakeExtensionApi {
	readonly tools: RegisteredTool[] = [];
	readonly #hooks = new Map<string, Hook[]>();

	asExtensionApi(): ExtensionAPI {
		return this as unknown as ExtensionAPI;
	}

	on(event: string, handler: Hook): void {
		const handlers = this.#hooks.get(event) ?? [];
		handlers.push(handler);
		this.#hooks.set(event, handlers);
	}

	registerTool(tool: RegisteredTool): void {
		this.tools.push(tool);
	}

	registerCommand(): void {}

	getAllTools(): Array<{ name: string; sourceInfo: { path: string } }> {
		return this.tools.map((tool) => ({
			name: tool.name,
			sourceInfo: { path: `/test/extensions/${tool.name}.ts` },
		}));
	}

	getCommands(): [] {
		return [];
	}

	getActiveTools(): string[] {
		return this.tools.map((tool) => tool.name);
	}

	getThinkingLevel(): "off" {
		return "off";
	}

	tool(name: string): RegisteredTool {
		const tool = this.tools.find((candidate) => candidate.name === name);
		if (!tool) throw new Error(`tool ${name} was not registered`);
		return tool;
	}

	async emit(event: string, payload: unknown, context: ExtensionContext): Promise<unknown[]> {
		const results: unknown[] = [];
		for (const hook of this.#hooks.get(event) ?? []) results.push(await hook(payload, context));
		return results;
	}
}

let caseRoot = "";

beforeEach(async () => {
	caseRoot = await mkdtemp(join(tmpdir(), "sub-agent-index-test-"));
	mockedRuntime.agentDir = join(caseRoot, "agent");
	mockedRuntime.managerCreations = 0;
	mockedRuntime.pendingPersistenceIds = [];
	mockedRuntime.reconciliations = [];
});

afterEach(async () => {
	if (caseRoot.length > 0) await rm(caseRoot, { recursive: true, force: true });
});

function createContext(mode: ExtensionContext["mode"], branch: unknown[] = []): ExtensionContext {
	return {
		mode,
		hasUI: false,
		cwd: join(caseRoot, "project"),
		ui: {
			setStatus: vi.fn(),
			notify: vi.fn(),
		},
		sessionManager: {
			getBranch: () => branch,
		},
		model: { provider: "fixture", id: "model" },
		isProjectTrusted: () => true,
	} as unknown as ExtensionContext;
}

function register(): FakeExtensionApi {
	const api = new FakeExtensionApi();
	registerSubagent(api.asExtensionApi());
	return api;
}

function toolResultEvent(toolName: string, details: unknown, isError: boolean): Record<string, unknown> {
	return {
		type: "tool_result",
		toolCallId: "tool-call",
		toolName,
		input: {},
		content: [],
		details,
		isError,
	};
}

describe("public registration", () => {
	it("registers exactly six fixed-description tools for parallel execution", () => {
		const api = register();
		expect(api.tools.map((tool) => tool.name)).toEqual(SUBAGENT_TOOL_NAMES);

		for (const name of SUBAGENT_TOOL_NAMES) {
			const tool = api.tool(name);
			expect(tool.description).toBe(TOOL_DESCRIPTIONS[name]);
			expect(tool.executionMode).toBe("parallel");
			expect(tool.parameters).toBeDefined();
			expect(tool.prepareArguments).toBeTypeOf("function");
		}
	});

	it("returns unsupported immediately for every tool outside TUI mode without initializing local state", async () => {
		const api = register();
		const context = createContext("print");
		await api.emit("session_start", { type: "session_start", reason: "startup" }, context);

		for (const name of SUBAGENT_TOOL_NAMES) {
			const result = await api.tool(name).execute("call", {}, undefined, undefined, context);
			expect(result.isError).toBe(true);
			expect(result.details).toMatchObject({
				schemaVersion: 1,
				operation: name.slice("subagent_".length),
				code: "SUBAGENT_UNSUPPORTED_MODE",
				sideEffects: "none",
				retry: "never",
			});
		}
		expect(mockedRuntime.managerCreations).toBe(0);
		await expect(lstat(join(mockedRuntime.agentDir, "sub-agent", "config.json"))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});
});

describe("public lifecycle hooks", () => {
	it("repairs tool_result isError from stable sub-agent details only", async () => {
		const api = register();
		const context = createContext("print");
		const cases: Array<{
			event: Record<string, unknown>;
			expected: unknown;
		}> = [
			{
				event: toolResultEvent(
					"subagent_spawn",
					{
						schemaVersion: 1,
						operation: "spawn",
						code: "SUBAGENT_CONCURRENCY_LIMIT",
					},
					false,
				),
				expected: { isError: true },
			},
			{
				event: toolResultEvent("subagent_spawn", { schemaVersion: 1, operation: "spawn", state: "RUNNING" }, true),
				expected: { isError: false },
			},
			{
				event: toolResultEvent(
					"subagent_wait",
					{
						schemaVersion: 1,
						operation: "wait",
						status: "DELIVERED",
						deliveries: [{ outcome: "RESULT" }, { outcome: "FAILED" }],
					},
					false,
				),
				expected: { isError: true },
			},
			{
				event: toolResultEvent("read", { schemaVersion: 1, operation: "spawn" }, true),
				expected: undefined,
			},
			{
				event: toolResultEvent("subagent_list", { operation: "list" }, true),
				expected: undefined,
			},
		];

		for (const testCase of cases) {
			const [result] = await api.emit("tool_result", testCase.event, context);
			expect(result).toEqual(testCase.expected);
		}
	});

	it("reconciles only in-turn pending waits and requires a persisted branch tool result", async () => {
		const api = register();
		const context = createContext("tui", [
			{
				type: "message",
				message: { role: "toolResult", toolCallId: "persisted" },
			},
			{
				type: "message",
				message: { role: "assistant", toolCallId: "not-persisted" },
			},
		]);
		await api.emit("session_start", { type: "session_start", reason: "startup" }, context);
		expect(mockedRuntime.managerCreations).toBe(1);
		mockedRuntime.pendingPersistenceIds = ["persisted", "not-persisted", "other-turn"];

		await api.emit(
			"turn_end",
			{
				type: "turn_end",
				turnIndex: 1,
				message: { role: "assistant", content: [] },
				toolResults: [{ toolCallId: "persisted" }, { toolCallId: "not-persisted" }],
			},
			context,
		);

		expect(mockedRuntime.reconciliations).toEqual([
			{ toolCallId: "persisted", persisted: true },
			{ toolCallId: "not-persisted", persisted: false },
		]);
	});
});
