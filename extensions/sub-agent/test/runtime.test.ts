import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import type {
	ChildMessage,
	ChildSessionFactory,
	ChildSessionHandle,
	ChildSessionRequest,
	SubAgentConfigV2,
} from "../src/domain.js";
import { SubagentManager } from "../src/runtime.js";

class FakeChildHandle implements ChildSessionHandle {
	readonly #messages: ChildMessage[] = [];
	abortCalls = 0;
	disposeCalls = 0;
	promptCalls: string[] = [];
	readonly childId: string;
	readonly sessionFile?: string | undefined;
	readonly promptDelayMs: number;
	readonly disposeDelayMs: number;
	#respond = true;
	#disposing = false;
	#disposed = false;

	constructor(childId: string, sessionFile?: string | undefined, promptDelayMs = 0, disposeDelayMs = 0) {
		this.childId = childId;
		this.sessionFile = sessionFile;
		this.promptDelayMs = promptDelayMs;
		this.disposeDelayMs = disposeDelayMs;
	}

	async prompt(text: string): Promise<void> {
		if (this.#disposing || this.#disposed) throw new Error("prompt called on disposed handle");
		if (this.promptDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.promptDelayMs));
		this.promptCalls.push(text);
		this.#messages.push({ role: "user", text });
		if (this.#respond) this.#messages.push({ role: "assistant", text: `answer:${text}` });
	}

	async abort(): Promise<void> {
		this.abortCalls += 1;
		this.#respond = false;
	}

	async dispose(): Promise<void> {
		this.disposeCalls += 1;
		this.#disposing = true;
		if (this.disposeDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.disposeDelayMs));
		this.#disposing = false;
		this.#disposed = true;
	}

	messages(): readonly ChildMessage[] {
		return [...this.#messages];
	}
}

class FakeChildFactory implements ChildSessionFactory {
	readonly requests: ChildSessionRequest[] = [];
	readonly handles = new Map<string, FakeChildHandle>();
	readonly #nextHandles: FakeChildHandle[];

	constructor(nextHandle?: FakeChildHandle | readonly FakeChildHandle[]) {
		this.#nextHandles = nextHandle === undefined ? [] : Array.isArray(nextHandle) ? [...nextHandle] : [nextHandle];
	}

	async create(request: ChildSessionRequest): Promise<ChildSessionHandle> {
		this.requests.push(request);
		const handle =
			this.#nextHandles.shift() ??
			new FakeChildHandle(
				request.childId,
				request.sessionDir === undefined ? undefined : `${request.sessionDir}/${request.childId}.jsonl`,
			);
		this.handles.set(request.childId, handle);
		return handle;
	}

	handleFor(childId: string): FakeChildHandle {
		const handle = this.handles.get(childId);
		if (handle === undefined) throw new Error(`missing handle ${childId}`);
		return handle;
	}
}

const CONFIG: SubAgentConfigV2 = {
	version: 2,
	delegationTools: DEFAULT_CONFIG.delegationTools,
	reportDelivery: "wakeup",
};

const SPAWN_TOOL = DEFAULT_CONFIG.delegationTools[0];
const FORK_TOOL = DEFAULT_CONFIG.delegationTools[1];
if (SPAWN_TOOL === undefined || FORK_TOOL === undefined) throw new Error("missing default delegation tools");

const testManagers: SubagentManager[] = [];
afterEach(async () => {
	await Promise.all(testManagers.splice(0).map((manager) => manager.shutdown()));
});

function makeManager(overrides: Partial<ConstructorParameters<typeof SubagentManager>[0]> = {}) {
	const pi = { sendMessage: vi.fn() };
	const childFactory = (overrides.childFactory ?? new FakeChildFactory()) as ChildSessionFactory;
	const manager = new SubagentManager({
		config: CONFIG,
		pi,
		childFactory,
		ownerSessionId: "root",
		cwd: "/tmp/project",
		depth: 0,
		parentModel: { provider: "faux", id: "faux-model" },
		parentThinkingLevel: "minimal",
		parentToolNames: ["read", "subagent"],
		childSessionDir: "/tmp/sub-agent-sessions/root",
		...overrides,
	});
	testManagers.push(manager);
	return { manager, pi, childFactory };
}

async function flush(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
	await new Promise((resolve) => setTimeout(resolve, 0));
}

function blockingHandle(childId: string): ChildSessionHandle {
	let release: (() => void) | undefined;
	return {
		childId,
		prompt: vi.fn(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		),
		abort: vi.fn(async () => {
			release?.();
		}),
		dispose: vi.fn(async () => {}),
		messages: () => [],
	};
}

describe("SubagentManager v2", () => {
	it("recursively shuts down active descendants and is idempotent", async () => {
		const handles = [blockingHandle("a"), blockingHandle("b"), blockingHandle("c")];
		const managers: SubagentManager[] = [];
		const notifications: ReturnType<typeof vi.fn>[] = [];
		let ownerSessionId = "shutdown-tree-root";
		let parentSessionId: string | undefined;
		try {
			for (const [depth, handle] of handles.entries()) {
				const { manager, pi } = makeManager({
					ownerSessionId,
					parentSessionId,
					depth,
					childFactory: { create: async () => handle },
				});
				managers.push(manager);
				notifications.push(pi.sendMessage);
				parentSessionId = ownerSessionId;
				// Native fork sessions may have a different session ID from the logical child ID.
				ownerSessionId = `pi-${(await manager.start(SPAWN_TOOL, "nested", "wait", true)).childId}`;
			}
			const root = managers[0];
			if (root === undefined) throw new Error("missing root");
			await Promise.all([root.shutdown(), root.shutdown()]);
			for (const handle of [...handles].reverse()) {
				expect(handle.abort).toHaveBeenCalledTimes(1);
				expect(handle.dispose).toHaveBeenCalledTimes(1);
			}
			for (const manager of managers) expect(manager.listChildren()).toEqual([]);
			for (const notify of notifications) expect(notify).not.toHaveBeenCalled();
		} finally {
			for (const manager of managers) await manager.shutdown();
		}
	});

	it("finds descendants even after the owning one-shot record was removed", async () => {
		const root = makeManager({ ownerSessionId: "settled-root" });
		const started = await root.manager.start(SPAWN_TOOL, "one-shot", "done", false);
		expect(root.manager.listUiAgents()).toEqual([]);
		const handle = blockingHandle("grandchild");
		const child = makeManager({
			ownerSessionId: started.childId,
			parentSessionId: "settled-root",
			depth: 1,
			childFactory: { create: async () => handle },
		});
		await child.manager.start(SPAWN_TOOL, "descendant", "wait", true);
		await root.manager.shutdown();
		expect(handle.abort).toHaveBeenCalledOnce();
		expect(handle.dispose).toHaveBeenCalledOnce();
		await expect(child.manager.sendMessage("missing", "continue")).rejects.toThrow("shut down");
	});

	it.each([false, true])("waits for late creation and prevents startup during shutdown (cold=%s)", async (cold) => {
		let resolveCreate: ((handle: ChildSessionHandle) => void) | undefined;
		let lateRequest: ChildSessionRequest | undefined;
		const lateHandle = blockingHandle("late-child");
		let calls = 0;
		const childFactory: ChildSessionFactory = {
			async create(request) {
				if (cold && calls++ === 0) return new FakeChildHandle(request.childId, "/tmp/fake-session.jsonl");
				lateRequest = request;
				return new Promise((resolve) => {
					resolveCreate = resolve;
				});
			},
		};
		const { manager, pi } = makeManager({ ownerSessionId: "late-root", childFactory });
		let starting: Promise<unknown>;
		if (cold) {
			const child = await manager.start(SPAWN_TOOL, "worker", "first", true);
			await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledOnce());
			pi.sendMessage.mockClear();
			starting = manager.sendMessage(child.childId, "second");
		} else {
			starting = expect(manager.start(SPAWN_TOOL, "worker", "first", true)).rejects.toThrow("shut down");
		}
		const closed = vi.fn();
		const closing = manager.shutdown().then(closed);
		await flush();
		expect(closed).not.toHaveBeenCalled();
		expect(lateRequest?.signal?.aborted).toBe(true);
		// A factory can register its child extension while its caller is closing.
		const nested = makeManager({ ownerSessionId: "late-native-session", parentSessionId: "late-root" });
		if (resolveCreate === undefined) throw new Error("factory was not called");
		resolveCreate(lateHandle);
		await starting;
		await closing;
		expect(lateHandle.prompt).not.toHaveBeenCalled();
		expect(lateHandle.abort).toHaveBeenCalledOnce();
		expect(lateHandle.dispose).toHaveBeenCalledOnce();
		expect(pi.sendMessage).not.toHaveBeenCalled();
		await expect(nested.manager.sendMessage("missing", "continue")).rejects.toThrow("shut down");
	});

	it("drops queued turns on shutdown but interruption alone preserves descendants", async () => {
		const parentHandle = blockingHandle("parent");
		const childHandle = blockingHandle("child");
		const factory = { create: vi.fn(async () => parentHandle) };
		const root = makeManager({ ownerSessionId: "interrupt-root", childFactory: factory });
		const started = await root.manager.start(SPAWN_TOOL, "parent", "wait", true);
		const child = makeManager({
			ownerSessionId: started.childId,
			parentSessionId: "interrupt-root",
			childFactory: { create: async () => childHandle },
		});
		await child.manager.start(SPAWN_TOOL, "child", "wait", true);
		await root.manager.sendMessage(started.childId, "queued");
		root.manager.interrupt(started.childId);
		await vi.waitFor(() => expect(root.manager.listChildren()[0]?.status).toBe("ready"));
		expect(childHandle.abort).not.toHaveBeenCalled();
		expect(childHandle.dispose).not.toHaveBeenCalled();
		await root.manager.shutdown();
		expect(childHandle.abort).toHaveBeenCalledOnce();
		expect(childHandle.dispose).toHaveBeenCalledOnce();
		expect(factory.create).toHaveBeenCalledOnce();
	});
	it("runs spawn foreground, returns final output, and disposes the child", async () => {
		const { manager, childFactory } = makeManager();
		const result = await manager.start(SPAWN_TOOL, "review", "please review", false, undefined);

		expect(result.foreground).toBe(true);
		expect(result.output).toBe("answer:please review");
		const handle = (childFactory as FakeChildFactory).handleFor(result.childId);
		expect(handle.disposeCalls).toBe(1);
		expect(manager.listChildren()).toHaveLength(0);
		expect(manager.listUiAgents()).toHaveLength(0);
	});

	it("passes fork boundary to the child factory", async () => {
		const childFactory = new FakeChildFactory();
		const { manager } = makeManager({
			childFactory,
			getForkBoundary: () => "entry-before-user",
		});

		await manager.start(FORK_TOOL, "fork", "continue", false, undefined);

		expect(childFactory.requests[0]).toMatchObject({
			provider: "fork",
			forkBeforeEntryId: "entry-before-user",
		});
	});

	it("rejects delegation above maxDepth before creating a child", async () => {
		const childFactory = new FakeChildFactory();
		const { manager } = makeManager({ childFactory });
		const cappedTool = { ...SPAWN_TOOL, maxDepth: 0 };

		await expect(manager.start(cappedTool, "x", "y", false, undefined)).rejects.toThrow(
			"subagent depth 1 exceeds maxDepth 0",
		);
		expect(childFactory.requests).toHaveLength(0);
	});

	it("sends a top-level child's settlement to the owning parent session", async () => {
		const root = makeManager({ ownerSessionId: "root" });

		const started = await root.manager.start(SPAWN_TOOL, "worker", "do work", true, undefined);
		expect(started.foreground).toBe(false);
		await flush();

		expect(root.pi.sendMessage).toHaveBeenCalledOnce();
		const call = root.pi.sendMessage.mock.calls[0] as [Record<string, unknown>, { triggerTurn: boolean }];
		expect(call[0].customType).toBe("subagent:settlement");
		expect(String(call[0].content)).toContain(`Background subagent ${started.childId} finished`);
		expect(call[1].triggerTurn).toBe(true);
	});

	it("does not skip the owning parent session for a nested child's settlement", async () => {
		const root = makeManager({ ownerSessionId: "root" });
		const child = makeManager({
			ownerSessionId: "child",
			depth: 1,
			parentToolNames: ["read"],
		});

		const started = await child.manager.start(SPAWN_TOOL, "worker", "do work", true, undefined);
		await flush();

		expect(child.pi.sendMessage).toHaveBeenCalledOnce();
		const call = child.pi.sendMessage.mock.calls[0] as [Record<string, unknown>, { triggerTurn: boolean }];
		expect(call[0].customType).toBe("subagent:settlement");
		expect(call[0].details).toMatchObject({
			version: 1,
			childId: started.childId,
			label: "worker",
			outcome: "completed",
		});
		expect(call[0].details).toHaveProperty("runId");
		expect(root.pi.sendMessage).not.toHaveBeenCalled();
	});

	it("routes child reports to the owning parent session with the child's identity", async () => {
		const root = makeManager({ ownerSessionId: "root" });
		const started = await root.manager.start(SPAWN_TOOL, "worker", "do work", true, undefined);
		const request = (root.childFactory as FakeChildFactory).requests[0];
		if (request === undefined) throw new Error("missing child request");

		await expect(request.onReport("progress")).resolves.toBe("message queued for parent");
		await flush();

		const reportCall = root.pi.sendMessage.mock.calls.find(
			([message]) => (message as Record<string, unknown>).customType === "subagent:report",
		) as [Record<string, unknown>, { triggerTurn: boolean }] | undefined;
		expect(reportCall).toBeDefined();
		expect(String(reportCall?.[0].content)).toContain(`Background subagent ${started.childId} reported:\nprogress`);
		expect(reportCall?.[0].details).toMatchObject({ version: 1, childId: started.childId, label: "worker" });
		expect(reportCall?.[0].details).toHaveProperty("runId");
		expect(reportCall?.[1].triggerTurn).toBe(true);
	});

	it("queues send_message while active and sends one settlement after the queued turn", async () => {
		const childFactory = new FakeChildFactory(new FakeChildHandle("", undefined, 30));
		const { manager, pi } = makeManager({ childFactory });
		const started = await manager.start(SPAWN_TOOL, "worker", "first", true, undefined);
		await new Promise((resolve) => setTimeout(resolve, 5));
		await manager.sendMessage(started.childId, "second");
		await new Promise((resolve) => setTimeout(resolve, 100));
		await flush();

		const handle = childFactory.handleFor(started.childId);
		expect(handle.promptCalls).toEqual(["first", "second"]);
		expect(pi.sendMessage).toHaveBeenCalledOnce();
		const call = pi.sendMessage.mock.calls[0] as [Record<string, unknown>, { triggerTurn: boolean }];
		expect(call[0].customType).toBe("subagent:settlement");
		expect(String(call[0].content)).toContain("answer:second");
		expect(call[1].triggerTurn).toBe(true);
		expect(manager.listChildren()[0]?.status).toBe("ready");
	});

	it("starts a message queued during disposal only after a fresh handle is ready", async () => {
		const first = new FakeChildHandle("first", undefined, 0, 50);
		const second = new FakeChildHandle("second");
		const childFactory = new FakeChildFactory([first, second]);
		const { manager } = makeManager({ childFactory });
		const started = await manager.start(SPAWN_TOOL, "worker", "first", true, undefined);
		await new Promise((resolve) => setTimeout(resolve, 5));

		await manager.sendMessage(started.childId, "second");
		await new Promise((resolve) => setTimeout(resolve, 100));
		await flush();

		expect(first.promptCalls).toEqual(["first"]);
		expect(second.promptCalls).toEqual(["second"]);
		expect(childFactory.requests).toHaveLength(2);
	});

	it("interrupts a run while its child session is still being created", async () => {
		let resolveCreate: ((handle: ChildSessionHandle) => void) | undefined;
		const handle = new FakeChildHandle("child-pending");
		const childFactory: ChildSessionFactory = {
			create: async () =>
				await new Promise<ChildSessionHandle>((resolve) => {
					resolveCreate = resolve;
				}),
		};
		const states: Array<readonly { childId: string; status: string }[]> = [];
		const { manager, pi } = makeManager({ childFactory, onStateChanged: (agents) => states.push(agents) });

		const starting = manager.start(SPAWN_TOOL, "worker", "run", true, undefined);
		const childId = states.at(-1)?.[0]?.childId;
		if (childId === undefined || resolveCreate === undefined) throw new Error("child was not registered before create");
		manager.interrupt(childId);
		resolveCreate(handle);
		await starting;
		await flush();

		expect(handle.promptCalls).toEqual([]);
		expect(handle.abortCalls).toBe(1);
		expect(manager.listUiAgents()[0]?.status).toBe("interrupted");
		const settlement = pi.sendMessage.mock.calls.at(-1)?.[0] as Record<string, unknown> | undefined;
		expect(settlement?.details).toMatchObject({ outcome: "interrupted" });
	});

	it("tracks interrupting and interrupted as structured run outcomes", async () => {
		const childFactory = new FakeChildFactory(new FakeChildHandle("", undefined, 50));
		const states: Array<readonly { status: string }[]> = [];
		const { manager, pi } = makeManager({
			childFactory,
			onStateChanged: (agents) => states.push(agents),
		});
		const started = await manager.start(SPAWN_TOOL, "worker", "run", true, undefined);
		await new Promise((resolve) => setTimeout(resolve, 5));

		const handle = childFactory.handleFor(started.childId);
		manager.interrupt(started.childId);
		expect(handle.abortCalls).toBe(1);
		expect(states.at(-1)?.[0]?.status).toBe("interrupting");

		await new Promise((resolve) => setTimeout(resolve, 70));
		await flush();
		expect(manager.listUiAgents()[0]?.status).toBe("interrupted");
		const settlement = pi.sendMessage.mock.calls.find(
			([message]) => (message as Record<string, unknown>).customType === "subagent:settlement",
		)?.[0] as Record<string, unknown> | undefined;
		expect(settlement?.details).toMatchObject({ outcome: "interrupted" });
	});

	it("removes a child record when session creation fails", async () => {
		const childFactory: ChildSessionFactory = {
			create: async () => {
				throw new Error("create failed");
			},
		};
		const { manager } = makeManager({ childFactory });

		await expect(manager.start(SPAWN_TOOL, "worker", "run", true, undefined)).rejects.toThrow("create failed");
		expect(manager.listChildren()).toEqual([]);
		expect(manager.listUiAgents()).toEqual([]);
	});

	it("rejects send_message for unknown or one-shot children", async () => {
		const childFactory = new FakeChildFactory();
		const { manager } = makeManager({ childFactory });
		await manager.start(SPAWN_TOOL, "one", "task", false, undefined);

		await expect(manager.sendMessage("missing", "hello")).rejects.toThrow("was not found");
	});
});
