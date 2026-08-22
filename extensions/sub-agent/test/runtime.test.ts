import { describe, expect, it, vi } from "vitest";
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
	#respond = true;

	constructor(childId: string, sessionFile?: string | undefined, promptDelayMs = 0) {
		this.childId = childId;
		this.sessionFile = sessionFile;
		this.promptDelayMs = promptDelayMs;
	}

	async prompt(text: string): Promise<void> {
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
	}

	messages(): readonly ChildMessage[] {
		return [...this.#messages];
	}
}

class FakeChildFactory implements ChildSessionFactory {
	readonly requests: ChildSessionRequest[] = [];
	readonly handles = new Map<string, FakeChildHandle>();
	#nextHandle: FakeChildHandle | undefined;

	constructor(nextHandle?: FakeChildHandle) {
		this.#nextHandle = nextHandle;
	}

	async create(request: ChildSessionRequest): Promise<ChildSessionHandle> {
		this.requests.push(request);
		const handle =
			this.#nextHandle ??
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
	return { manager, pi, childFactory };
}

async function flush(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("SubagentManager v2", () => {
	it("runs spawn foreground, returns final output, and disposes the child", async () => {
		const { manager, childFactory } = makeManager();
		const result = await manager.start(SPAWN_TOOL, "review", "please review", false, undefined);

		expect(result.foreground).toBe(true);
		expect(result.output).toBe("answer:please review");
		const handle = (childFactory as FakeChildFactory).handleFor(result.childId);
		expect(handle.disposeCalls).toBe(1);
		expect(manager.listChildren()).toHaveLength(0);
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
		expect(call[0].details).toEqual({ childId: started.childId });
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
		expect(reportCall?.[0].details).toEqual({ childId: started.childId });
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

	it("interrupts only the current active child", async () => {
		const childFactory = new FakeChildFactory(new FakeChildHandle("", undefined, 50));
		const { manager } = makeManager({ childFactory });
		const started = await manager.start(SPAWN_TOOL, "worker", "run", true, undefined);
		await new Promise((resolve) => setTimeout(resolve, 5));

		const handle = childFactory.handleFor(started.childId);
		manager.interrupt(started.childId);
		expect(handle.abortCalls).toBe(1);
	});

	it("rejects send_message for unknown or one-shot children", async () => {
		const childFactory = new FakeChildFactory();
		const { manager } = makeManager({ childFactory });
		await manager.start(SPAWN_TOOL, "one", "task", false, undefined);

		await expect(manager.sendMessage("missing", "hello")).rejects.toThrow("was not found");
	});
});
