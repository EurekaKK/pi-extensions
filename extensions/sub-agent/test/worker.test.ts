import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPackageDir, VERSION } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
	type ChildRunAdmission,
	type ChildRunCallbacks,
	type ChildRunRequest,
	type ChildRuntime,
	type ChildRuntimeFactory,
	type ChildRuntimeLifecycleHooks,
	type ChildTerminalCandidate,
	PiChildRuntimeFactory,
} from "../sidecar/child-runtime.js";
import { isStrictWorkerFrame } from "../sidecar/guardian-runtime.js";
import type {
	BootstrapFrame,
	ChildFrame,
	MailboxCommitAckFrame,
	ParentFrame,
	RunTerminalFrame,
	SpawnFrame,
} from "../sidecar/protocol.js";
import { writeResultSpool } from "../sidecar/spool-writer.js";
import { WorkerRuntime } from "../sidecar/worker-runtime.js";
import { SidecarClient } from "../src/sidecar-client.js";

const temporaryPaths: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function identity() {
	return {
		protocolVersion: 1 as const,
		sessionNonce: "session-test",
		managerEpoch: "epoch-test",
		workerGeneration: 1,
	};
}

function bootstrapFrame(overrides: Partial<BootstrapFrame> = {}): BootstrapFrame {
	return {
		type: "BOOTSTRAP",
		...identity(),
		parentPid: process.pid,
		cwd: process.cwd(),
		agentDir: process.cwd(),
		piPackageDir: getPackageDir(),
		spoolDir: process.cwd(),
		selfExtensionPath: fileURLToPath(new URL("../index.ts", import.meta.url)),
		settingsSnapshot: {},
		projectTrusted: true,
		...overrides,
	};
}

function spawnFrame(overrides: Partial<SpawnFrame> = {}): SpawnFrame {
	return {
		type: "SPAWN",
		...identity(),
		opId: "op-spawn",
		agentId: "agent-1",
		runId: "run-1",
		deliveryId: "delivery-1",
		task: "Do the fixture task.",
		model: { provider: "fixture", id: "fixture" },
		thinkingLevel: "off",
		projectContext: [],
		candidateExtensionPaths: [],
		requiredExtensionPaths: [],
		parentToolNames: ["read"],
		parentToolSources: [{ name: "read" }],
		parentActiveToolNames: ["read"],
		...overrides,
	};
}

async function waitUntil(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error("Timed out waiting for deterministic Worker test state.");
}

class FakeChildRuntime implements ChildRuntime {
	readonly model = { provider: "fixture", id: "fixture" };
	readonly thinkingLevel = "off" as const;
	readonly activeToolCount = 1;
	readonly capabilityToolCount = 1;
	readonly degradedExtensions = [];
	readonly unavailableTools = [];
	readonly closedRunIds: string[] = [];
	readonly abortedRunIds: string[] = [];
	shutdownCount = 0;
	private callbacks: ChildRunCallbacks | undefined;
	private admissionResolve?: (result: ChildRunAdmission) => void;
	private terminalStarted = false;

	constructor(private readonly admissionMode: "automatic" | "manual" | "handled") {}

	async startRun(_request: ChildRunRequest, callbacks: ChildRunCallbacks): Promise<ChildRunAdmission> {
		this.callbacks = callbacks;
		this.terminalStarted = false;
		if (this.admissionMode === "handled") {
			return { status: "rejected", code: "SUBAGENT_INPUT_HANDLED" };
		}
		if (this.admissionMode === "automatic") {
			await callbacks.onAccepted();
			return { status: "accepted" };
		}
		return await new Promise<ChildRunAdmission>((resolve) => {
			this.admissionResolve = resolve;
		});
	}

	async accept(): Promise<void> {
		if (!this.callbacks || !this.admissionResolve) throw new Error("Manual admission is not pending.");
		await this.callbacks.onAccepted();
		this.admissionResolve({ status: "accepted" });
		delete this.admissionResolve;
	}

	async finish(candidate: ChildTerminalCandidate): Promise<void> {
		if (!this.callbacks) throw new Error("No fake Child run is active.");
		this.terminalStarted = true;
		await this.callbacks.onTerminal(candidate);
	}

	closeRunAdmissionGate(runId: string): void {
		this.closedRunIds.push(runId);
	}

	async abort(runId: string): Promise<void> {
		this.abortedRunIds.push(runId);
		if (!this.terminalStarted) {
			await this.finish({ outcome: "FAILED", failureCode: "SUBAGENT_RUN_ABORTED" });
		}
	}

	async shutdown(): Promise<void> {
		this.shutdownCount++;
	}
}

class FakeChildRuntimeFactory implements ChildRuntimeFactory {
	readonly piVersion = "test-pi";
	readonly children: FakeChildRuntime[] = [];

	constructor(private readonly admissionMode: "automatic" | "manual" | "handled" = "automatic") {}

	async create(_frame: SpawnFrame, hooks: ChildRuntimeLifecycleHooks): Promise<ChildRuntime> {
		void hooks;
		const child = new FakeChildRuntime(this.admissionMode);
		this.children.push(child);
		return child;
	}
}

function createWorker(
	factory: ChildRuntimeFactory,
	options: {
		writeSpool?: typeof writeResultSpool;
		onShutdownComplete?: () => void;
	} = {},
): { runtime: WorkerRuntime; frames: ChildFrame[] } {
	const frames: ChildFrame[] = [];
	const runtime = new WorkerRuntime({
		bootstrap: bootstrapFrame(),
		factory,
		sendFrame: async (frame) => {
			frames.push(frame);
		},
		writeSpool:
			options.writeSpool ??
			(async (_spoolDir, deliveryId, report) => ({
				basename: `${deliveryId}.report`,
				byteSize: Buffer.byteLength(report),
				digest: createHash("sha256").update(report).digest("hex"),
			})),
		removeSpool: async () => undefined,
		createTerminalOpId: () => "terminal-1",
		now: () => 1_234,
		...(options.onShutdownComplete === undefined ? {} : { onShutdownComplete: options.onShutdownComplete }),
	});
	return { runtime, frames };
}

function terminalAck(terminal: RunTerminalFrame): MailboxCommitAckFrame {
	return {
		type: "MAILBOX_COMMIT_ACK",
		...identity(),
		terminalOpId: terminal.terminalOpId,
		agentId: terminal.agentId,
		runId: terminal.runId,
		deliveryId: terminal.deliveryId,
	};
}

function framesOfType<TType extends ChildFrame["type"]>(
	frames: readonly ChildFrame[],
	type: TType,
): Array<Extract<ChildFrame, { type: TType }>> {
	return frames.filter((frame): frame is Extract<ChildFrame, { type: TType }> => frame.type === type);
}

describe("Worker run admission and settlement", () => {
	it("emits an exact strict WORKER_READY handshake with the factory Pi version", () => {
		const { runtime } = createWorker(new FakeChildRuntimeFactory());
		const ready = runtime.readyFrame();
		expect(ready).toEqual({
			type: "WORKER_READY",
			...identity(),
			workerPid: process.pid,
			workerPgid: process.pid,
			piVersion: "test-pi",
		});
		expect(isStrictWorkerFrame(ready)).toBe(true);
	});

	it("does not emit RUN_ACCEPTED before the Child observes agent_start", async () => {
		const factory = new FakeChildRuntimeFactory("manual");
		const { runtime, frames } = createWorker(factory);
		const spawn = runtime.handle(spawnFrame());
		await waitUntil(() => factory.children.length === 1);
		expect(framesOfType(frames, "RUN_ACCEPTED")).toHaveLength(0);

		await factory.children[0]?.accept();
		await spawn;
		expect(framesOfType(frames, "RUN_ACCEPTED")).toMatchObject([
			{
				opId: "op-spawn",
				operation: "spawn",
				agentId: "agent-1",
				runId: "run-1",
			},
		]);
	});

	it("turns an input-hook handled prompt into a NACK and disposes the provisional Child", async () => {
		const factory = new FakeChildRuntimeFactory("handled");
		const { runtime, frames } = createWorker(factory);
		await runtime.handle(spawnFrame());

		expect(framesOfType(frames, "RUN_ACCEPTED")).toHaveLength(0);
		expect(framesOfType(frames, "OP_NACK")).toMatchObject([{ opId: "op-spawn", code: "SUBAGENT_INPUT_HANDLED" }]);
		expect(factory.children[0]?.shutdownCount).toBe(1);
	});

	it("waits for MAILBOX_COMMIT_ACK before emitting RUN_SETTLED", async () => {
		const factory = new FakeChildRuntimeFactory();
		const { runtime, frames } = createWorker(factory);
		await runtime.handle(spawnFrame());

		const finish = factory.children[0]?.finish({ outcome: "RESULT", report: "done" });
		await waitUntil(() => framesOfType(frames, "RUN_TERMINAL").length === 1);
		expect(framesOfType(frames, "RUN_SETTLED")).toHaveLength(0);
		const terminal = framesOfType(frames, "RUN_TERMINAL")[0];
		expect(terminal).toMatchObject({
			outcome: "RESULT",
			terminalOpId: "terminal-1",
			spool: { basename: "delivery-1.report", byteSize: 4 },
		});

		if (!terminal) throw new Error("Missing terminal frame.");
		await runtime.handle(terminalAck(terminal));
		await finish;
		expect(frames.map((frame) => frame.type)).toEqual(["RUN_ACCEPTED", "RUN_TERMINAL", "RUN_SETTLED"]);
	});

	it("makes the Child IDLE before exposing RUN_SETTLED to a reentrant parent send", async () => {
		const factory = new FakeChildRuntimeFactory();
		const frames: ChildFrame[] = [];
		let reentrantSend: Promise<void> | undefined;
		let runtime!: WorkerRuntime;
		runtime = new WorkerRuntime({
			bootstrap: bootstrapFrame(),
			factory,
			sendFrame: async (frame) => {
				frames.push(frame);
				if (frame.type === "RUN_SETTLED" && !reentrantSend) {
					const next: ParentFrame = {
						type: "SEND",
						...identity(),
						opId: "op-send-2",
						agentId: "agent-1",
						runId: "run-2",
						deliveryId: "delivery-2",
						message: "Continue with the same private context.",
					};
					reentrantSend = runtime.handle(next);
				}
			},
			writeSpool: async (_spoolDir, deliveryId, report) => ({
				basename: `${deliveryId}.report`,
				byteSize: Buffer.byteLength(report),
				digest: createHash("sha256").update(report).digest("hex"),
			}),
			removeSpool: async () => undefined,
			createTerminalOpId: () => "terminal-1",
			now: () => 1_234,
		});
		await runtime.handle(spawnFrame());
		const finish = factory.children[0]?.finish({
			outcome: "FAILED",
			failureCode: "SUBAGENT_MODEL_RUN_FAILED",
		});
		await waitUntil(() => framesOfType(frames, "RUN_TERMINAL").length === 1);
		const terminal = framesOfType(frames, "RUN_TERMINAL")[0];
		if (!terminal) throw new Error("Missing terminal frame.");

		await runtime.handle(terminalAck(terminal));
		await finish;
		await reentrantSend;
		expect(framesOfType(frames, "RUN_ACCEPTED")).toEqual([
			expect.objectContaining({ operation: "spawn", runId: "run-1" }),
			expect.objectContaining({ operation: "send", runId: "run-2" }),
		]);
		expect(framesOfType(frames, "OP_NACK").find((frame) => frame.opId === "op-send-2")).toBeUndefined();
		await runtime.shutdown();
	});

	it("linearizes cancel before abort and classifies the terminal delivery as CANCELLED", async () => {
		const factory = new FakeChildRuntimeFactory();
		const { runtime, frames } = createWorker(factory);
		await runtime.handle(spawnFrame());
		await runtime.handle({
			type: "CANCEL",
			...identity(),
			opId: "op-cancel",
			agentId: "agent-1",
			runId: "run-1",
			reason: "No longer needed.",
		});
		await waitUntil(() => framesOfType(frames, "RUN_TERMINAL").length === 1);

		const terminal = framesOfType(frames, "RUN_TERMINAL")[0];
		expect(frames.slice(1, 3).map((frame) => frame.type)).toEqual(["CANCEL_ACCEPTED", "RUN_TERMINAL"]);
		expect(terminal).toMatchObject({
			outcome: "CANCELLED",
			cancelReason: "No longer needed.",
		});
		expect(factory.children[0]?.closedRunIds).toEqual(["run-1"]);
		expect(factory.children[0]?.abortedRunIds).toEqual(["run-1"]);

		if (!terminal) throw new Error("Missing terminal frame.");
		await runtime.handle(terminalAck(terminal));
		await waitUntil(() => framesOfType(frames, "RUN_SETTLED").length === 1);
	});

	it("rejects a cancel that arrives after terminal metadata entered the FIFO", async () => {
		const factory = new FakeChildRuntimeFactory();
		const { runtime, frames } = createWorker(factory);
		await runtime.handle(spawnFrame());
		const finish = factory.children[0]?.finish({
			outcome: "FAILED",
			failureCode: "SUBAGENT_MODEL_RUN_FAILED",
		});
		await waitUntil(() => framesOfType(frames, "RUN_TERMINAL").length === 1);

		await runtime.handle({
			type: "CANCEL",
			...identity(),
			opId: "op-late-cancel",
			agentId: "agent-1",
			runId: "run-1",
			reason: "too late",
		});
		expect(framesOfType(frames, "OP_NACK").at(-1)).toMatchObject({
			opId: "op-late-cancel",
			code: "SUBAGENT_RUN_ALREADY_TERMINAL",
		});

		const terminal = framesOfType(frames, "RUN_TERMINAL")[0];
		if (!terminal) throw new Error("Missing terminal frame.");
		await runtime.handle(terminalAck(terminal));
		await finish;
	});

	it("routes storage failures through the same terminal ACK barrier", async () => {
		const factory = new FakeChildRuntimeFactory();
		const { runtime, frames } = createWorker(factory, {
			writeSpool: async () => {
				throw new Error("disk full");
			},
		});
		await runtime.handle(spawnFrame());
		const finish = factory.children[0]?.finish({ outcome: "RESULT", report: "report" });
		await waitUntil(() => framesOfType(frames, "RUN_TERMINAL").length === 1);
		const terminal = framesOfType(frames, "RUN_TERMINAL")[0];
		expect(terminal).toMatchObject({
			outcome: "FAILED",
			failureCode: "SUBAGENT_DELIVERY_STORAGE_FAILED",
		});
		expect(framesOfType(frames, "RUN_SETTLED")).toHaveLength(0);

		if (!terminal) throw new Error("Missing terminal frame.");
		await runtime.handle(terminalAck(terminal));
		await finish;
		expect(framesOfType(frames, "RUN_SETTLED")).toHaveLength(1);
	});

	it("replays an idempotent operation response without creating another Child", async () => {
		const factory = new FakeChildRuntimeFactory();
		const { runtime, frames } = createWorker(factory);
		const frame = spawnFrame();
		await runtime.handle(frame);
		await runtime.handle(frame);
		expect(factory.children).toHaveLength(1);
		expect(framesOfType(frames, "RUN_ACCEPTED")).toHaveLength(2);
	});
});

describe("Worker cleanup", () => {
	it("runs Child shutdown once and signals cooperative completion idempotently", async () => {
		const factory = new FakeChildRuntimeFactory();
		let completed = 0;
		const { runtime } = createWorker(factory, {
			onShutdownComplete: () => {
				completed++;
			},
		});
		await runtime.handle(spawnFrame());
		const shutdownFrame: ParentFrame = {
			type: "SHUTDOWN",
			...identity(),
			deadlineAt: Date.now() + 1_000,
		};
		await runtime.handle(shutdownFrame);
		await runtime.shutdown();

		expect(factory.children[0]?.shutdownCount).toBe(1);
		expect(factory.children[0]?.closedRunIds).toEqual(["run-1"]);
		expect(completed).toBe(1);
	});

	it("emits KILL_SETTLED only after an idle Child has been disposed", async () => {
		const factory = new FakeChildRuntimeFactory();
		const { runtime, frames } = createWorker(factory);
		await runtime.handle(spawnFrame());
		const finish = factory.children[0]?.finish({
			outcome: "FAILED",
			failureCode: "SUBAGENT_MODEL_RUN_FAILED",
		});
		await waitUntil(() => framesOfType(frames, "RUN_TERMINAL").length === 1);
		const terminal = framesOfType(frames, "RUN_TERMINAL")[0];
		if (!terminal) throw new Error("Missing terminal frame.");
		await runtime.handle(terminalAck(terminal));
		await finish;

		await runtime.handle({
			type: "KILL",
			...identity(),
			opId: "op-kill",
			agentId: "agent-1",
			lastRunId: "run-1",
		});
		await waitUntil(() => framesOfType(frames, "KILL_SETTLED").length === 1);
		expect(frames.slice(-2).map((frame) => frame.type)).toEqual(["KILL_ACCEPTED", "KILL_SETTLED"]);
		expect(factory.children[0]?.shutdownCount).toBe(1);
	});
});

describe("Worker result spool", () => {
	it("fsyncs an atomic 0600 report into a private 0700 spool directory", async () => {
		const root = await mkdtemp(join(tmpdir(), "sub-agent-worker-spool-"));
		temporaryPaths.push(root);
		await chmod(root, 0o700);

		const metadata = await writeResultSpool(root, "delivery-safe", "hello, worker");
		const path = join(root, metadata.basename);
		const info = await lstat(path);
		expect(info.mode & 0o777).toBe(0o600);
		expect(await readdir(root)).toEqual(["delivery-safe.report"]);
		expect(await readFile(path, "utf8")).toBe("hello, worker");
		expect(metadata).toEqual({
			basename: "delivery-safe.report",
			byteSize: 13,
			digest: createHash("sha256").update("hello, worker").digest("hex"),
		});
	});

	it("rejects a delivery id that could escape the spool root", async () => {
		const root = await mkdtemp(join(tmpdir(), "sub-agent-worker-spool-"));
		temporaryPaths.push(root);
		await chmod(root, 0o700);
		await expect(writeResultSpool(root, "../escape", "bad")).rejects.toThrow("Invalid delivery id");
		expect(await readdir(root)).toEqual([]);
	});
});

describe("real Pi Child runtime", () => {
	it("loads the faux provider through public staged APIs and settles only at agent_settled", async () => {
		const root = await mkdtemp(join(tmpdir(), "sub-agent-worker-pi-"));
		temporaryPaths.push(root);
		const cwd = join(root, "cwd");
		const agentDir = join(root, "agent");
		const spoolDir = join(root, "spool");
		await Promise.all([mkdir(cwd), mkdir(agentDir), mkdir(spoolDir)]);
		await chmod(spoolDir, 0o700);
		const bootstrap = bootstrapFrame({
			cwd,
			agentDir,
			spoolDir,
			piPackageDir: getPackageDir(),
		});
		const factory = await PiChildRuntimeFactory.bootstrap(bootstrap);
		const fauxProviderPath = fileURLToPath(new URL("./fixtures/faux-provider-extension.ts", import.meta.url));
		const workerExtensionPath = fileURLToPath(new URL("./fixtures/worker-extension.ts", import.meta.url));
		const frame = spawnFrame({
			model: { provider: "sub-agent-faux", id: "fixture-model" },
			candidateExtensionPaths: [fauxProviderPath, workerExtensionPath],
			parentToolNames: [],
			parentToolSources: [],
			parentActiveToolNames: [],
			explicitTools: [],
			projectContext: [{ path: "AGENTS.md", content: "fixture project context" }],
		});
		const child = await factory.create(frame, {
			onToolStateChanged: () => undefined,
			onWarning: () => undefined,
		});
		let terminal: ChildTerminalCandidate | undefined;
		let resolveTerminal!: () => void;
		const terminalSeen = new Promise<void>((resolve) => {
			resolveTerminal = resolve;
		});
		const admission = await child.startRun(
			{ runId: frame.runId, deliveryId: frame.deliveryId, text: frame.task },
			{
				onAccepted: async () => undefined,
				onTerminal: async (candidate) => {
					terminal = candidate;
					resolveTerminal();
				},
			},
		);
		expect(admission).toEqual({ status: "accepted" });
		await terminalSeen;
		expect(terminal).toEqual({ outcome: "RESULT", report: "fixture child report" });

		const handled = await child.startRun(
			{ runId: "run-handled", deliveryId: "delivery-handled", text: "fixture:handled" },
			{
				onAccepted: async () => undefined,
				onTerminal: async () => undefined,
			},
		);
		expect(handled).toEqual({ status: "rejected", code: "SUBAGENT_INPUT_HANDLED" });
		await child.shutdown();

		const missingExtensionPath = join(root, "missing-extension.ts");
		const degradedFrame = spawnFrame({
			agentId: "agent-degraded",
			runId: "run-degraded",
			deliveryId: "delivery-degraded",
			model: { provider: "sub-agent-faux", id: "fixture-model" },
			candidateExtensionPaths: [fauxProviderPath, workerExtensionPath, missingExtensionPath],
			parentToolNames: ["unlocatable_tool", "failed_tool", "not_registered_tool"],
			parentToolSources: [
				{ name: "unlocatable_tool" },
				{ name: "failed_tool", path: missingExtensionPath },
				{ name: "not_registered_tool", path: workerExtensionPath },
			],
			parentActiveToolNames: [],
		});
		const degradedChild = await factory.create(degradedFrame, {
			onToolStateChanged: () => undefined,
			onWarning: () => undefined,
		});
		expect(degradedChild.degradedExtensions).toEqual([{ path: missingExtensionPath, code: "loader_failed" }]);
		expect(degradedChild.unavailableTools).toEqual([
			{ name: "unlocatable_tool", reason: "unlocatable" },
			{ name: "failed_tool", reason: "extension_failed" },
			{ name: "not_registered_tool", reason: "not_registered" },
		]);
		await degradedChild.shutdown();

		await expect(
			factory.create(
				spawnFrame({
					model: { provider: "sub-agent-faux", id: "fixture-model" },
					candidateExtensionPaths: [fauxProviderPath],
					explicitTools: ["subagent_spawn"],
				}),
				{
					onToolStateChanged: () => undefined,
					onWarning: () => undefined,
				},
			),
		).rejects.toMatchObject({ code: "SUBAGENT_TOOL_FORBIDDEN" });
	});
});

const describePosix = process.platform === "win32" ? describe.skip : describe;

describePosix.sequential("real Guardian and Worker handshake", () => {
	it("accepts the Worker's exact READY frame and reports the loaded Pi package version", async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), "sub-agent-worker-handshake-")));
		temporaryPaths.push(root);
		const cwd = join(root, "cwd");
		const agentDir = join(root, "agent");
		const spoolDir = join(root, "spool");
		await Promise.all([mkdir(cwd), mkdir(agentDir), mkdir(spoolDir)]);
		await chmod(spoolDir, 0o700);
		const sidecarIdentity = {
			sessionNonce: randomUUID(),
			managerEpoch: randomUUID(),
			workerGeneration: 1,
		};
		const bootstrap: BootstrapFrame = {
			...bootstrapFrame({
				cwd,
				agentDir,
				spoolDir,
				piPackageDir: getPackageDir(),
			}),
			...sidecarIdentity,
		};
		const client = await SidecarClient.launch({
			identity: sidecarIdentity,
			bootstrap,
		});
		try {
			expect(client.processInfo.piVersion).toBe(VERSION);
			expect(client.processInfo.workerPid).toBeGreaterThan(0);
			expect(client.processInfo.workerPgid).toBe(client.processInfo.workerPid);
			const deadlineAt = Date.now() + 4_000;
			await client.requestShutdown(deadlineAt);
			expect(await client.waitForExit(deadlineAt)).toBe(true);
		} finally {
			await client.forceCleanup(Date.now() + 2_000).catch(() => undefined);
		}
	});
});
