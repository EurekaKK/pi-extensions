import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
	SourceInfo,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	EXTENSION_ID,
	LEDGER_ENTRY_TYPE,
	OPEN_DESCRIPTION,
	OPEN_PROMPT_GUIDELINES,
	OPEN_PROMPT_SNIPPET,
	OPEN_TOOL_NAME,
	SEARCH_DESCRIPTION,
	SEARCH_PROMPT_GUIDELINES,
	SEARCH_PROMPT_SNIPPET,
	SEARCH_TOOL_NAME,
	TAVILY_TOOL_NAMES,
} from "../src/constants.js";
import { registerTavilyWebSearch, type TavilyExtensionDependencies } from "../src/index.js";
import type { TavilyWebSearchConfig } from "../src/types.js";

const DEFAULTS_CONFIG_PATH = fileURLToPath(new URL("../defaults/config.json", import.meta.url));
const EXTENSION_SOURCE_PATH = "/virtual/tavily-web-search/src/index.ts";
const BASELINE_TOOL = "read";

type LifecycleHandler = (event: unknown, context: ExtensionContext) => unknown | Promise<unknown>;

interface CapturedToolDefinition {
	readonly name: string;
	readonly description: string;
	readonly promptSnippet?: string;
	readonly parameters: unknown;
	readonly promptGuidelines?: readonly string[];
	execute(
		toolCallId: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		context: ExtensionContext,
	): Promise<AgentToolResult<unknown>>;
}

interface FakePiOptions {
	readonly allowedCanonical?: ReadonlySet<string>;
	readonly initialActive?: readonly string[];
	readonly mutationThenThrow?: string;
}

interface AppendedEntry {
	readonly customType: string;
	readonly data: unknown;
}

class FakePiRuntime {
	readonly api: ExtensionAPI;
	readonly registeredDefinitions: CapturedToolDefinition[] = [];
	readonly setActiveToolsCalls: string[][] = [];
	readonly appendedEntries: AppendedEntry[] = [];
	readonly trace: string[] = [];
	#activeTools: string[];
	readonly #visibleTools = new Map<string, ToolInfo>();
	readonly #handlers = new Map<string, LifecycleHandler[]>();
	readonly #allowedCanonical: ReadonlySet<string>;
	readonly #mutationThenThrow: string | undefined;

	constructor(options: FakePiOptions = {}) {
		this.#activeTools = [...(options.initialActive ?? [BASELINE_TOOL])];
		this.#allowedCanonical = options.allowedCanonical ?? new Set(TAVILY_TOOL_NAMES);
		this.#mutationThenThrow = options.mutationThenThrow;
		this.api = {
			on: (event: string, handler: LifecycleHandler) => {
				const handlers = this.#handlers.get(event) ?? [];
				handlers.push(handler);
				this.#handlers.set(event, handlers);
			},
			registerTool: (definition: CapturedToolDefinition) => this.#registerTool(definition),
			getActiveTools: () => [...this.#activeTools],
			getAllTools: () => [...this.#visibleTools.values()],
			setActiveTools: (names: string[]) => this.#setActiveTools(names),
			appendEntry: (customType: string, data?: unknown) => {
				this.appendedEntries.push({ customType, data });
			},
		} as unknown as ExtensionAPI;
	}

	get activeTools(): readonly string[] {
		return this.#activeTools;
	}

	get visibleTools(): readonly ToolInfo[] {
		return [...this.#visibleTools.values()];
	}

	providerSnapshot(): { readonly toolNames: readonly string[]; readonly promptText: string } {
		const active = new Set(this.#activeTools);
		const definitions = this.registeredDefinitions.filter((definition) => active.has(definition.name));
		return {
			toolNames: definitions.map((definition) => definition.name),
			promptText: definitions
				.flatMap((definition) => [
					definition.description,
					definition.promptSnippet ?? "",
					...(definition.promptGuidelines ?? []),
				])
				.join("\n"),
		};
	}

	forceActive(names: readonly string[]): void {
		this.#activeTools = [...names];
	}

	injectForeignCanonical(name: typeof SEARCH_TOOL_NAME | typeof OPEN_TOOL_NAME): void {
		this.#visibleTools.set(name, toolInfo(foreignDefinition(name), foreignSourceInfo()));
	}

	definition(name: string): CapturedToolDefinition {
		const definition = this.registeredDefinitions.find((candidate) => candidate.name === name);
		if (!definition) throw new Error(`Missing captured definition: ${name}`);
		return definition;
	}

	async trigger(event: string, context: ExtensionContext): Promise<unknown> {
		let result: unknown;
		for (const handler of this.#handlers.get(event) ?? []) result = await handler({}, context);
		return result;
	}

	#registerTool(definition: CapturedToolDefinition): void {
		this.trace.push(`register:${definition.name}`);
		this.registeredDefinitions.push(definition);
		if (this.#allowedCanonical.has(definition.name)) {
			this.#visibleTools.set(definition.name, toolInfo(definition, ownSourceInfo()));
			if (!this.#activeTools.includes(definition.name)) this.#activeTools.push(definition.name);
		}
		if (this.#mutationThenThrow === definition.name) throw new Error("host mutation-then-throw fault");
	}

	#setActiveTools(names: readonly string[]): void {
		const filtered = names.filter(
			(name) => !isCanonicalName(name) || (this.#allowedCanonical.has(name) && this.#visibleTools.has(name)),
		);
		this.#activeTools = [...new Set(filtered)];
		this.setActiveToolsCalls.push([...this.#activeTools]);
		this.trace.push(`active:${this.#activeTools.join(",")}`);
	}
}

interface ContextHarness {
	readonly context: ExtensionContext;
	readonly abort: ReturnType<typeof vi.fn>;
	readonly notify: ReturnType<typeof vi.fn>;
	readonly setStatus: ReturnType<typeof vi.fn>;
	setBranch(entries: readonly SessionEntry[]): void;
}

function createContext(
	runtime: FakePiRuntime,
	initialBranch: readonly SessionEntry[] = [],
	hasUI = false,
): ContextHarness {
	let branch = [...initialBranch];
	const abort = vi.fn();
	const notify = vi.fn();
	const setStatus = vi.fn();
	const context = {
		hasUI,
		mode: hasUI ? "tui" : "print",
		cwd: "/workspace",
		ui: { notify, setStatus },
		sessionManager: { getBranch: () => [...branch] },
		abort,
		getSystemPrompt: () => `system:${runtime.activeTools.join(",")}`,
	} as unknown as ExtensionContext;
	return {
		context,
		abort,
		notify,
		setStatus,
		setBranch(entries) {
			branch = [...entries];
		},
	};
}

interface DependencyCalls {
	getAgentDir: number;
	queue: number;
	fetch: number;
	now: number;
	randomId: number;
	readApiKey: number;
}

interface DependencyOptions {
	readonly fetch?: typeof globalThis.fetch;
	readonly readApiKey?: () => string | undefined;
}

function createDependencies(
	agentDir: string,
	options: DependencyOptions = {},
): { readonly dependencies: TavilyExtensionDependencies; readonly calls: DependencyCalls } {
	const calls: DependencyCalls = {
		getAgentDir: 0,
		queue: 0,
		fetch: 0,
		now: 0,
		randomId: 0,
		readApiKey: 0,
	};
	let id = 0;
	const fetchImplementation = options.fetch ?? (async () => jsonResponse({ results: [], usage: { credits: 0 } }));
	const readApiKey = options.readApiKey ?? (() => "test-api-key");
	async function mutationQueue<T>(_path: string, mutation: () => Promise<T>): Promise<T> {
		calls.queue += 1;
		return mutation();
	}
	const dependencies: TavilyExtensionDependencies = {
		getAgentDir: () => {
			calls.getAgentDir += 1;
			return agentDir;
		},
		defaultsConfigPath: DEFAULTS_CONFIG_PATH,
		withFileMutationQueue: mutationQueue,
		fetch: async (input, init) => {
			calls.fetch += 1;
			return fetchImplementation(input, init);
		},
		now: () => {
			calls.now += 1;
			return 1_000;
		},
		randomId: () => {
			calls.randomId += 1;
			id += 1;
			return `test_${id}`;
		},
		readApiKey: () => {
			calls.readApiKey += 1;
			return readApiKey();
		},
		retryEnabled: false,
		extensionSourcePath: EXTENSION_SOURCE_PATH,
	};
	return { dependencies, calls };
}

const temporaryDirectories: string[] = [];

async function freshAgentDir(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), "tavily-lifecycle-"));
	temporaryDirectories.push(path);
	return path;
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("extension factory and startup preflight", () => {
	it("registers lifecycle handlers while performing zero I/O, credential reads, network, or tool registration", async () => {
		const agentDir = await freshAgentDir();
		const runtime = new FakePiRuntime();
		const { dependencies, calls } = createDependencies(agentDir);

		registerTavilyWebSearch(runtime.api, dependencies);

		expect(runtime.registeredDefinitions).toHaveLength(0);
		expect(runtime.visibleTools).toHaveLength(0);
		expect(runtime.activeTools).toEqual([BASELINE_TOOL]);
		expect(calls).toEqual({
			getAgentDir: 0,
			queue: 0,
			fetch: 0,
			now: 0,
			randomId: 0,
			readApiKey: 0,
		});
	});

	it("fails a missing key before first registration and clears stale active names synchronously", async () => {
		const agentDir = await freshAgentDir();
		const runtime = new FakePiRuntime({ initialActive: [BASELINE_TOOL, ...TAVILY_TOOL_NAMES] });
		const context = createContext(runtime);
		const { dependencies, calls } = createDependencies(agentDir, { readApiKey: () => "  " });
		registerTavilyWebSearch(runtime.api, dependencies);

		const startup = runtime.trigger("session_start", context.context);
		expect(runtime.activeTools).toEqual([BASELINE_TOOL]);
		await expect(startup).rejects.toThrow("Tavily web search initialization failed:");

		expect(runtime.registeredDefinitions).toHaveLength(0);
		expect(runtime.visibleTools).toHaveLength(0);
		expect(calls.readApiKey).toBe(1);
		expect(calls.fetch).toBe(0);
		const callsAfterFailure = { ...calls };
		await runtime.trigger("session_tree", context.context);
		expect(calls).toEqual(callsAfterFailure);
		expect(runtime.registeredDefinitions).toHaveLength(0);
		expect(runtime.activeTools).toEqual([BASELINE_TOOL]);
		expect(runtime.providerSnapshot()).toEqual({ toolNames: [], promptText: "" });
		expect(context.notify).not.toHaveBeenCalled();
		expect(context.setStatus).not.toHaveBeenCalled();
	});

	it("reports config creation and a missing key only when UI is available", async () => {
		const createdHarness = await createStartedHarness({ hasUI: true });

		expect(createdHarness.context.notify).toHaveBeenCalledWith(
			expect.stringContaining("Created Tavily web search config at "),
			"info",
		);
		expect(createdHarness.context.setStatus).toHaveBeenLastCalledWith(EXTENSION_ID, undefined);

		const agentDir = await freshAgentDir();
		const runtime = new FakePiRuntime();
		const context = createContext(runtime, [], true);
		const { dependencies } = createDependencies(agentDir, { readApiKey: () => undefined });
		registerTavilyWebSearch(runtime.api, dependencies);

		await expect(runtime.trigger("session_start", context.context)).rejects.toThrow(
			"Tavily web search initialization failed:",
		);
		expect(context.setStatus).toHaveBeenLastCalledWith(EXTENSION_ID, `${EXTENSION_ID}: disabled`);
		expect(context.notify).toHaveBeenCalledWith(expect.stringContaining("TAVILY_API_KEY is missing or empty"), "error");
	});

	it("fails malformed config before reading the key or registering tools", async () => {
		const agentDir = await freshAgentDir();
		await writeRawConfig(agentDir, JSON.stringify({ version: 1 }));
		const runtime = new FakePiRuntime({ initialActive: [BASELINE_TOOL, ...TAVILY_TOOL_NAMES] });
		const context = createContext(runtime);
		const { dependencies, calls } = createDependencies(agentDir);
		registerTavilyWebSearch(runtime.api, dependencies);

		await expect(runtime.trigger("session_start", context.context)).rejects.toThrow(
			"Tavily web search initialization failed:",
		);

		expect(runtime.registeredDefinitions).toHaveLength(0);
		expect(runtime.visibleTools).toHaveLength(0);
		expect(runtime.activeTools).toEqual([BASELINE_TOOL]);
		expect(calls.readApiKey).toBe(0);
		expect(calls.fetch).toBe(0);
	});

	it("fails a corrupt ledger before first registration and does not leak ledger data", async () => {
		const agentDir = await freshAgentDir();
		const runtime = new FakePiRuntime({ initialActive: [BASELINE_TOOL, ...TAVILY_TOOL_NAMES] });
		const secretMarker = "SECRET_LEDGER_PAYLOAD";
		const context = createContext(runtime, [customEntry({ invalid: secretMarker })]);
		const { dependencies, calls } = createDependencies(agentDir);
		registerTavilyWebSearch(runtime.api, dependencies);

		const failure = await captureFailure(runtime.trigger("session_start", context.context));

		expect(failure.message).toContain("Tavily web search initialization failed:");
		expect(failure.message).not.toContain(secretMarker);
		expect(runtime.registeredDefinitions).toHaveLength(0);
		expect(runtime.visibleTools).toHaveLength(0);
		expect(runtime.activeTools).toEqual([BASELINE_TOOL]);
		expect(calls.fetch).toBe(0);
	});

	it("rejects a pre-registered canonical collision before registering either definition", async () => {
		const agentDir = await freshAgentDir();
		const runtime = new FakePiRuntime({ initialActive: [BASELINE_TOOL, ...TAVILY_TOOL_NAMES] });
		runtime.injectForeignCanonical(SEARCH_TOOL_NAME);
		const context = createContext(runtime);
		const { dependencies, calls } = createDependencies(agentDir);
		registerTavilyWebSearch(runtime.api, dependencies);

		await expect(runtime.trigger("session_start", context.context)).rejects.toThrow(
			"Tavily web search initialization failed:",
		);

		expect(runtime.registeredDefinitions).toHaveLength(0);
		expect(runtime.visibleTools.map((tool) => tool.name)).toEqual([SEARCH_TOOL_NAME]);
		expect(runtime.activeTools).toEqual([BASELINE_TOOL]);
		expect(calls.fetch).toBe(0);
	});
});

describe("dynamic registration commit", () => {
	it("registers the exact fixed descriptions and prompt metadata", async () => {
		const harness = await createStartedHarness();
		const search = harness.runtime.definition(SEARCH_TOOL_NAME);
		const open = harness.runtime.definition(OPEN_TOOL_NAME);

		expect(search.description).toBe(SEARCH_DESCRIPTION);
		expect(search.promptSnippet).toBe(SEARCH_PROMPT_SNIPPET);
		expect(search.promptGuidelines).toEqual(SEARCH_PROMPT_GUIDELINES);
		expect(open.description).toBe(OPEN_DESCRIPTION);
		expect(open.promptSnippet).toBe(OPEN_PROMPT_SNIPPET);
		expect(open.promptGuidelines).toEqual(OPEN_PROMPT_GUIDELINES);
	});

	it("registers exactly Search then Open and exposes only the complete pair", async () => {
		const harness = await createStartedHarness();

		expect(harness.runtime.registeredDefinitions.map((definition) => definition.name)).toEqual([
			SEARCH_TOOL_NAME,
			OPEN_TOOL_NAME,
		]);
		expect(harness.runtime.activeTools).toEqual([BASELINE_TOOL, ...TAVILY_TOOL_NAMES]);
		expect(
			harness.runtime.setActiveToolsCalls.every((tools) => {
				const visibleTavily = tools.filter(isCanonicalName);
				return visibleTavily.length === 0 || visibleTavily.length === 2;
			}),
		).toBe(true);
		expect(harness.runtime.trace).toEqual([
			`register:${SEARCH_TOOL_NAME}`,
			`active:${BASELINE_TOOL}`,
			`register:${OPEN_TOOL_NAME}`,
			`active:${BASELINE_TOOL}`,
			`active:${BASELINE_TOOL},${TAVILY_TOOL_NAMES.join(",")}`,
		]);
	});

	it("keeps both tools inactive when the host allows only one member of the pair", async () => {
		const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ results: [], usage: { credits: 0 } }));
		const harness = await createStartedHarness({
			runtime: { allowedCanonical: new Set([SEARCH_TOOL_NAME]) },
			dependencies: { fetch: fetchMock },
		});

		expect(harness.runtime.registeredDefinitions.map((definition) => definition.name)).toEqual([
			SEARCH_TOOL_NAME,
			OPEN_TOOL_NAME,
		]);
		expect(harness.runtime.activeTools).toEqual([BASELINE_TOOL]);
		await expect(execute(harness, SEARCH_TOOL_NAME, { query: "must not fetch" })).rejects.toMatchObject({
			code: "tavily_extension_disabled",
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("does not register definitions again on a repeated session_start in the same runtime", async () => {
		const harness = await createStartedHarness();

		await harness.runtime.trigger("session_start", harness.context.context);

		expect(harness.runtime.registeredDefinitions.map((definition) => definition.name)).toEqual([
			SEARCH_TOOL_NAME,
			OPEN_TOOL_NAME,
		]);
		expect(harness.runtime.activeTools).toEqual([BASELINE_TOOL, ...TAVILY_TOOL_NAMES]);
		expect(harness.dependencyCalls.readApiKey).toBe(2);
	});

	it("removes the old active pair when a repeated session_start fails before registration", async () => {
		const agentDir = await freshAgentDir();
		let key: string | undefined = "test-api-key";
		const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ results: [], usage: { credits: 0 } }));
		const runtime = new FakePiRuntime();
		const context = createContext(runtime);
		const { dependencies } = createDependencies(agentDir, { fetch: fetchMock, readApiKey: () => key });
		registerTavilyWebSearch(runtime.api, dependencies);
		await runtime.trigger("session_start", context.context);
		key = undefined;

		await expect(runtime.trigger("session_start", context.context)).rejects.toThrow(
			"Tavily web search initialization failed:",
		);

		expect(runtime.registeredDefinitions).toHaveLength(2);
		expect(runtime.activeTools).toEqual([BASELINE_TOOL]);
		await expect(
			runtime
				.definition(SEARCH_TOOL_NAME)
				.execute("disabled", { query: "no network" }, undefined, undefined, context.context),
		).rejects.toMatchObject({ code: "tavily_extension_disabled" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it.each([SEARCH_TOOL_NAME, OPEN_TOOL_NAME])(
		"contains a host mutation-then-throw at %s as inactive disabled residual metadata",
		async (faultingName) => {
			const agentDir = await freshAgentDir();
			const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
				jsonResponse({ results: [], usage: { credits: 0 } }),
			);
			const runtime = new FakePiRuntime({ mutationThenThrow: faultingName });
			const context = createContext(runtime);
			const { dependencies } = createDependencies(agentDir, { fetch: fetchMock });
			registerTavilyWebSearch(runtime.api, dependencies);

			await expect(runtime.trigger("session_start", context.context)).rejects.toThrow(
				"Tavily web search initialization failed:",
			);

			const expectedResiduals =
				faultingName === SEARCH_TOOL_NAME ? [SEARCH_TOOL_NAME] : [SEARCH_TOOL_NAME, OPEN_TOOL_NAME];
			expect(runtime.registeredDefinitions.map((definition) => definition.name)).toEqual(expectedResiduals);
			expect(runtime.visibleTools.map((tool) => tool.name)).toEqual(expectedResiduals);
			expect(runtime.activeTools).toEqual([BASELINE_TOOL]);
			for (const definition of runtime.registeredDefinitions) {
				const params = definition.name === SEARCH_TOOL_NAME ? { query: "no network" } : {};
				await expect(
					definition.execute("residual", params, undefined, undefined, context.context),
				).rejects.toMatchObject({ code: "tavily_extension_disabled" });
			}
			const registrationCount = runtime.registeredDefinitions.length;
			await expect(runtime.trigger("session_start", context.context)).rejects.toThrow(
				"Tavily web search initialization failed:",
			);
			expect(runtime.registeredDefinitions).toHaveLength(registrationCount);
			expect(runtime.activeTools).toEqual([BASELINE_TOOL]);
			runtime.forceActive([BASELINE_TOOL, ...expectedResiduals]);
			await runtime.trigger("input", context.context);
			expect(runtime.activeTools).toEqual([BASELINE_TOOL]);
			expect(runtime.providerSnapshot()).toEqual({ toolNames: [], promptText: "" });
			expect(runtime.appendedEntries).toHaveLength(0);
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);
});

describe("runtime pair and ownership guards", () => {
	it("notifies only once when a UI session discovers an incomplete active pair", async () => {
		const harness = await createStartedHarness({ hasUI: true });
		harness.runtime.forceActive([BASELINE_TOOL, SEARCH_TOOL_NAME]);

		await harness.runtime.trigger("input", harness.context.context);
		await harness.runtime.trigger("input", harness.context.context);

		expect(harness.runtime.activeTools).toEqual([BASELINE_TOOL]);
		expect(harness.context.notify).toHaveBeenCalledWith(
			"The Tavily tool pair was incomplete, so both tools were disabled.",
			"warning",
		);
		expect(
			harness.context.notify.mock.calls.filter(
				([message]) => message === "The Tavily tool pair was incomplete, so both tools were disabled.",
			),
		).toHaveLength(1);
	});

	it("shows an authentication circuit once and rejects later calls without another request", async () => {
		const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ usage: { credits: 0 } }, 401));
		const harness = await createStartedHarness({ hasUI: true, dependencies: { fetch: fetchMock } });

		await expect(execute(harness, SEARCH_TOOL_NAME, { query: "authentication failure" })).rejects.toMatchObject({
			code: "tavily_auth_failed",
		});
		await expect(execute(harness, SEARCH_TOOL_NAME, { query: "must remain local" })).rejects.toMatchObject({
			code: "tavily_auth_failed",
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(harness.context.setStatus).toHaveBeenLastCalledWith(EXTENSION_ID, `${EXTENSION_ID}: offline (auth)`);
		expect(
			harness.context.notify.mock.calls.filter(
				([message]) => message === "Tavily web search is offline for this session (auth).",
			),
		).toHaveLength(1);
	});

	it.each(["input", "before_agent_start", "agent_start", "turn_start"])(
		"removes an xor-active pair at the %s barrier without enabling its peer",
		async (event) => {
			const harness = await createStartedHarness();
			harness.runtime.forceActive([BASELINE_TOOL, SEARCH_TOOL_NAME]);

			const result = await harness.runtime.trigger(event, harness.context.context);

			expect(harness.runtime.activeTools).toEqual([BASELINE_TOOL]);
			if (event === "input") expect(result).toEqual({ action: "continue" });
			if (event === "before_agent_start") expect(result).toBeUndefined();
			if (event === "agent_start" || event === "turn_start") {
				expect(harness.context.abort).toHaveBeenCalled();
			} else {
				expect(harness.context.abort).not.toHaveBeenCalled();
			}
		},
	);

	it("continues a before_agent_start prompt after synchronously removing an xor-active pair", async () => {
		const harness = await createStartedHarness();
		harness.runtime.forceActive([BASELINE_TOOL, SEARCH_TOOL_NAME]);

		await harness.runtime.trigger("before_agent_start", harness.context.context);

		expect(harness.runtime.activeTools).toEqual([BASELINE_TOOL]);
		expect(harness.context.context.getSystemPrompt()).not.toContain("tavily_");
		expect(harness.context.abort).not.toHaveBeenCalled();

		await harness.runtime.trigger("agent_start", harness.context.context);
		expect(harness.context.abort).not.toHaveBeenCalled();
	});

	it.each(["input", "before_agent_start", "agent_start", "turn_start"])(
		"fails closed on a late ownership collision at the %s barrier",
		async (event) => {
			const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
				jsonResponse({ results: [], usage: { credits: 0 } }),
			);
			const harness = await createStartedHarness({ dependencies: { fetch: fetchMock } });
			harness.runtime.injectForeignCanonical(OPEN_TOOL_NAME);

			await harness.runtime.trigger(event, harness.context.context);

			expect(harness.runtime.activeTools).toEqual([BASELINE_TOOL]);
			expect(harness.context.abort).toHaveBeenCalled();
			await expect(execute(harness, SEARCH_TOOL_NAME, { query: "must remain disabled" })).rejects.toMatchObject({
				code: "tavily_extension_disabled",
			});
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it("latches an input-time ownership collision until agent_start can abort the provider run", async () => {
		const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ results: [], usage: { credits: 0 } }));
		const harness = await createStartedHarness({ dependencies: { fetch: fetchMock } });
		harness.runtime.injectForeignCanonical(OPEN_TOOL_NAME);

		expect(await harness.runtime.trigger("input", harness.context.context)).toEqual({ action: "continue" });
		expect(harness.runtime.activeTools).toEqual([BASELINE_TOOL]);
		expect(harness.context.abort).toHaveBeenCalledTimes(1);

		await harness.runtime.trigger("before_agent_start", harness.context.context);
		expect(harness.context.abort).toHaveBeenCalledTimes(1);

		await harness.runtime.trigger("agent_start", harness.context.context);
		expect(harness.context.abort).toHaveBeenCalledTimes(2);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("branch generation barriers and shutdown", () => {
	it("ignores a late old-generation auth response instead of opening the new branch circuit", async () => {
		const firstFetchStarted = deferred<void>();
		const lateResponse = deferred<Response>();
		let requestCount = 0;
		const fetchMock = vi.fn<typeof globalThis.fetch>(async () => {
			requestCount += 1;
			if (requestCount === 1) {
				firstFetchStarted.resolve();
				return lateResponse.promise;
			}
			return jsonResponse({ results: [], usage: { credits: 0 } });
		});
		const harness = await createStartedHarness({ dependencies: { fetch: fetchMock } });
		const oldExecution = execute(harness, SEARCH_TOOL_NAME, { query: "old branch auth" });
		const oldFailure = oldExecution.catch((error: unknown) => error);
		await firstFetchStarted.promise;

		await harness.runtime.trigger("session_tree", harness.context.context);
		lateResponse.resolve(
			new Response("{", {
				status: 401,
				headers: { "content-type": "application/json" },
			}),
		);
		expect(await oldFailure).toBeInstanceOf(Error);

		await expect(execute(harness, SEARCH_TOOL_NAME, { query: "new branch remains online" })).resolves.toBeDefined();
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("aborts an old-generation request and prevents it from appending after session_tree", async () => {
		const fetchStarted = deferred<AbortSignal>();
		const fetchMock = vi.fn<typeof globalThis.fetch>((_input, init) => {
			const signal = init?.signal;
			if (!(signal instanceof AbortSignal)) return Promise.reject(new Error("missing request signal"));
			fetchStarted.resolve(signal);
			return new Promise<Response>((_resolve, reject) => {
				if (signal.aborted) reject(signal.reason);
				else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		});
		const harness = await createStartedHarness({ dependencies: { fetch: fetchMock } });
		const oldExecution = execute(harness, SEARCH_TOOL_NAME, { query: "blocked old generation" });
		const oldFailure = oldExecution.catch((error: unknown) => error);
		const requestSignal = await fetchStarted.promise;
		const appendsBeforeTree = harness.runtime.appendedEntries.length;

		await harness.runtime.trigger("session_tree", harness.context.context);
		const failure = await oldFailure;

		expect(requestSignal.aborted).toBe(true);
		expect(failure).toBeInstanceOf(Error);
		expect(harness.runtime.appendedEntries).toHaveLength(appendsBeforeTree);
		expect(harness.runtime.activeTools).toEqual([BASELINE_TOOL, ...TAVILY_TOOL_NAMES]);
	});

	it("recovers refs and ledger state from the new branch during session_tree", async () => {
		const agentDir = await freshAgentDir();
		await writeConfig(agentDir, configWithBranchLimit(8));
		const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
			jsonResponse({
				results: [{ url: "https://example.com/source", raw_content: "Recovered branch evidence." }],
				usage: { credits: 1 },
			}),
		);
		const runtime = new FakePiRuntime();
		const context = createContext(runtime);
		const { dependencies, calls } = createDependencies(agentDir, { fetch: fetchMock });
		registerTavilyWebSearch(runtime.api, dependencies);
		await runtime.trigger("session_start", context.context);

		context.setBranch([...restoredOperationEntries(7), restoredRefEntry()]);
		await runtime.trigger("session_tree", context.context);
		const harness: StartedHarness = { runtime, context, dependencies, dependencyCalls: calls };

		await expect(execute(harness, OPEN_TOOL_NAME, { ref_id: "tavily_ref_7", mode: "focused" })).resolves.toMatchObject({
			details: { tavily_ref_id: "tavily_ref_7" },
		});
		await expect(execute(harness, SEARCH_TOOL_NAME, { query: "branch budget is already full" })).rejects.toMatchObject({
			code: "tavily_tool_budget_exhausted",
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(runtime.activeTools).toEqual([BASELINE_TOOL, ...TAVILY_TOOL_NAMES]);
	});

	it("preserves complete-pair activation intent across a failed then successful branch restore", async () => {
		const harness = await createStartedHarness();
		harness.context.setBranch([customEntry({ invalid: "corrupt branch" })]);

		await expect(harness.runtime.trigger("session_tree", harness.context.context)).rejects.toThrow(
			"Tavily web search initialization failed:",
		);
		expect(harness.runtime.activeTools).toEqual([BASELINE_TOOL]);

		harness.context.setBranch([]);
		await harness.runtime.trigger("session_tree", harness.context.context);

		expect(harness.runtime.activeTools).toEqual([BASELINE_TOOL, ...TAVILY_TOOL_NAMES]);
		expect(harness.runtime.registeredDefinitions).toHaveLength(2);
	});

	it("does not reactivate a pair that was inactive before session_tree", async () => {
		const harness = await createStartedHarness();
		harness.runtime.forceActive([BASELINE_TOOL]);

		await harness.runtime.trigger("session_tree", harness.context.context);

		expect(harness.runtime.activeTools).toEqual([BASELINE_TOOL]);
		expect(harness.runtime.registeredDefinitions).toHaveLength(2);
	});

	it("makes repeated shutdown and a later session_tree cleanup-only and keeps direct execute disabled", async () => {
		const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ results: [], usage: { credits: 0 } }));
		const harness = await createStartedHarness({ hasUI: true, dependencies: { fetch: fetchMock } });
		const registrations = harness.runtime.registeredDefinitions.length;

		await harness.runtime.trigger("session_shutdown", harness.context.context);
		await harness.runtime.trigger("session_shutdown", harness.context.context);
		await harness.runtime.trigger("session_tree", harness.context.context);

		expect(harness.runtime.activeTools).toEqual([BASELINE_TOOL]);
		expect(harness.runtime.registeredDefinitions).toHaveLength(registrations);
		await expect(execute(harness, OPEN_TOOL_NAME, { ref_id: "tavily_ref_1" })).rejects.toMatchObject({
			code: "tavily_extension_disabled",
		});
		expect(fetchMock).not.toHaveBeenCalled();
		expect(harness.context.setStatus).toHaveBeenLastCalledWith(EXTENSION_ID, undefined);
	});
});

interface StartedHarness {
	readonly runtime: FakePiRuntime;
	readonly context: ContextHarness;
	readonly dependencies: TavilyExtensionDependencies;
	readonly dependencyCalls: DependencyCalls;
}

interface StartedHarnessOptions {
	readonly runtime?: FakePiOptions;
	readonly dependencies?: DependencyOptions;
	readonly branch?: readonly SessionEntry[];
	readonly hasUI?: boolean;
}

async function createStartedHarness(options: StartedHarnessOptions = {}): Promise<StartedHarness> {
	const agentDir = await freshAgentDir();
	const runtime = new FakePiRuntime(options.runtime);
	const context = createContext(runtime, options.branch, options.hasUI);
	const { dependencies, calls } = createDependencies(agentDir, options.dependencies);
	registerTavilyWebSearch(runtime.api, dependencies);
	await runtime.trigger("session_start", context.context);
	return { runtime, context, dependencies, dependencyCalls: calls };
}

function execute(
	harness: Pick<StartedHarness, "runtime" | "context">,
	name: typeof SEARCH_TOOL_NAME | typeof OPEN_TOOL_NAME,
	params: unknown,
): Promise<AgentToolResult<unknown>> {
	return harness.runtime.definition(name).execute("test-call", params, undefined, undefined, harness.context.context);
}

function toolInfo(definition: CapturedToolDefinition, sourceInfo: SourceInfo): ToolInfo {
	return {
		name: definition.name,
		description: definition.description,
		parameters: definition.parameters,
		...(definition.promptGuidelines === undefined ? {} : { promptGuidelines: [...definition.promptGuidelines] }),
		sourceInfo,
	} as ToolInfo;
}

function foreignDefinition(name: string): CapturedToolDefinition {
	return {
		name,
		description: "foreign canonical definition",
		parameters: {},
		async execute() {
			throw new Error("foreign definition must never execute");
		},
	};
}

function ownSourceInfo(): SourceInfo {
	return {
		path: EXTENSION_SOURCE_PATH,
		source: "tavily-web-search",
		scope: "project",
		origin: "top-level",
		baseDir: dirname(EXTENSION_SOURCE_PATH),
	};
}

function foreignSourceInfo(): SourceInfo {
	return {
		path: "/virtual/foreign-extension/index.ts",
		source: "foreign-extension",
		scope: "project",
		origin: "top-level",
		baseDir: "/virtual/foreign-extension",
	};
}

function isCanonicalName(name: string): boolean {
	return name === SEARCH_TOOL_NAME || name === OPEN_TOOL_NAME;
}

async function writeRawConfig(agentDir: string, contents: string): Promise<void> {
	const path = join(agentDir, "tavily-web-search", "config.json");
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, contents, "utf8");
}

async function writeConfig(agentDir: string, config: TavilyWebSearchConfig): Promise<void> {
	await writeRawConfig(agentDir, JSON.stringify(config));
}

function configWithBranchLimit(maxToolCallsPerBranchLineage: number): TavilyWebSearchConfig {
	return {
		version: 1,
		domains: { allow: [], deny: [] },
		retrieval: {
			searchDepth: "basic",
			extractDepth: "basic",
			maxSearchResults: 5,
			maxOutputCharacters: 12_000,
			maxDocumentBytes: 256 * 1_024,
		},
		budgets: {
			maxToolCallsPerTurn: 4,
			maxToolCallsPerAgentRun: 8,
			maxToolCallsPerBranchLineage,
			maxTavilyCreditsPerAgentRun: 10,
			maxTavilyCreditsPerBranchLineage: 20,
			maxConcurrency: 2,
		},
		cache: { searchTtlSeconds: 300, extractTtlSeconds: 900, maxBytes: 4 * 1_024 * 1_024 },
	};
}

function customEntry(data: unknown): SessionEntry {
	return { type: "custom", customType: LEDGER_ENTRY_TYPE, data } as unknown as SessionEntry;
}

function restoredOperationEntries(count: number): SessionEntry[] {
	return Array.from({ length: count }, (_value, index) => {
		const suffix = `restored_${index + 1}`;
		return customEntry({
			tavily_ledger_version: 1,
			tavily_event: "tool_call_committed",
			tavily_operation_id: `tavily_operation_${suffix}`,
			tavily_turn_operation_id: `tavily_turn_operation_${suffix}`,
			tavily_agent_run_operation_id: `tavily_agent_run_operation_${suffix}`,
			tavily_operation: "search",
			tavily_tool_calls: 1,
		});
	});
}

function restoredRefEntry(): SessionEntry {
	return {
		type: "message",
		message: {
			role: "toolResult",
			toolName: SEARCH_TOOL_NAME,
			details: {
				tavily_details_version: 1,
				tavily_query: "restored query",
				tavily_retrieved_at: "2026-07-20T00:00:00.000Z",
				tavily_refs: [
					{
						tavily_details_version: 1,
						tavily_ref_id: "tavily_ref_7",
						tavily_rank: 1,
						tavily_title: "Recovered source",
						tavily_title_truncated: false,
						tavily_url: "https://example.com/source",
						tavily_hostname: "example.com",
						tavily_snippet: "Recovered candidate.",
						tavily_snippet_truncated: false,
						tavily_content_truncated: false,
						tavily_originating_query: "restored query",
						tavily_retrieved_at: "2026-07-20T00:00:00.000Z",
						tavily_freshness: "cache_ok",
						tavily_policy_allow: [],
						tavily_policy_deny: [],
					},
				],
			},
		},
	} as unknown as SessionEntry;
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

async function captureFailure(promise: Promise<unknown>): Promise<Error> {
	try {
		await promise;
		throw new Error("Expected promise to reject");
	} catch (error) {
		if (error instanceof Error) return error;
		throw new Error("Promise rejected with a non-Error value");
	}
}

interface Deferred<Value> {
	readonly promise: Promise<Value>;
	resolve(value: Value): void;
}

function deferred<Value>(): Deferred<Value> {
	let resolvePromise: ((value: Value) => void) | undefined;
	const promise = new Promise<Value>((resolve) => {
		resolvePromise = resolve;
	});
	return {
		promise,
		resolve(value) {
			if (!resolvePromise) throw new Error("Deferred promise was not initialized");
			resolvePromise(value);
		},
	};
}
