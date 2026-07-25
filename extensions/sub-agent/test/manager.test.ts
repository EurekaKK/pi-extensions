import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
	CancelFrame,
	ChildFrame,
	ParentFrame,
	ProtocolEnvelope,
	RunTerminalFrame,
	SpawnFrame,
} from "../sidecar/protocol.js";
import {
	ManagerOperationError,
	type ManagerToolResult,
	type SidecarTransport,
	SubagentManager,
} from "../src/manager.js";

type AgentListDetails = Extract<ManagerToolResult["details"], { operation: "list"; view: "agents" | "direct" }>;
type DeliveryListDetails = Extract<ManagerToolResult["details"], { operation: "list"; view: "deliveries" }>;

interface AcceptedRunOptions {
	activeToolCount?: number;
	capabilityToolCount?: number;
	degradedExtensions?: Array<{
		path: string;
		code:
			| "factory_failed"
			| "loader_failed"
			| "provider_registration_failed"
			| "session_start_failed"
			| "resources_discover_failed"
			| "run_admission_gate_failed";
	}>;
	unavailableTools?: Array<{
		name: string;
		reason: "unlocatable" | "extension_failed" | "not_registered";
	}>;
}

class FakeSidecar implements SidecarTransport {
	readonly processInfo = {
		guardianPid: 10_001,
		workerPid: 10_002,
		workerPgid: 10_002,
		piVersion: "test-pi",
	};
	readonly sent: ParentFrame[] = [];
	autoAcceptRuns: boolean;
	shutdownRequests = 0;
	waitForExitCalls = 0;
	forceCleanupCalls = 0;
	readonly shutdownDeadlines: number[] = [];
	readonly waitForExitDeadlines: number[] = [];
	readonly forceCleanupDeadlines: Array<number | undefined> = [];
	readonly #identity: ProtocolEnvelope;
	readonly #frameListeners = new Set<(frame: ChildFrame) => void | Promise<void>>();
	readonly #exitListeners = new Set<
		(exit: { code: number | null; signal: NodeJS.Signals | null }) => void | Promise<void>
	>();

	constructor(identity: ProtocolEnvelope, autoAcceptRuns: boolean) {
		this.#identity = { ...identity };
		this.autoAcceptRuns = autoAcceptRuns;
	}

	envelope(): ProtocolEnvelope {
		return { ...this.#identity };
	}

	onFrame(listener: (frame: ChildFrame) => void | Promise<void>): () => void {
		this.#frameListeners.add(listener);
		return () => this.#frameListeners.delete(listener);
	}

	onExit(listener: (exit: { code: number | null; signal: NodeJS.Signals | null }) => void | Promise<void>): () => void {
		this.#exitListeners.add(listener);
		return () => this.#exitListeners.delete(listener);
	}

	async send(frame: ParentFrame): Promise<void> {
		this.sent.push(frame);
		if (this.autoAcceptRuns && (frame.type === "SPAWN" || frame.type === "SEND")) {
			await this.acceptRun(frame);
		}
	}

	async requestShutdown(deadlineAt: number): Promise<void> {
		this.shutdownRequests++;
		this.shutdownDeadlines.push(deadlineAt);
	}

	async waitForExit(deadlineAt: number): Promise<boolean> {
		this.waitForExitCalls++;
		this.waitForExitDeadlines.push(deadlineAt);
		return true;
	}

	async forceCleanup(deadlineAt?: number): Promise<void> {
		this.forceCleanupCalls++;
		this.forceCleanupDeadlines.push(deadlineAt);
	}

	async emit(frame: ChildFrame): Promise<void> {
		for (const listener of [...this.#frameListeners]) await listener(frame);
	}

	async acceptRun(
		frame: Extract<ParentFrame, { type: "SPAWN" | "SEND" }>,
		options: AcceptedRunOptions = {},
	): Promise<void> {
		await this.emit({
			type: "RUN_ACCEPTED",
			...this.envelope(),
			opId: frame.opId,
			operation: frame.type === "SPAWN" ? "spawn" : "send",
			agentId: frame.agentId,
			runId: frame.runId,
			model: frame.type === "SPAWN" ? { ...frame.model } : { provider: "fixture", id: "model" },
			thinkingLevel: frame.type === "SPAWN" ? frame.thinkingLevel : "off",
			activeToolCount: options.activeToolCount ?? 0,
			capabilityToolCount: options.capabilityToolCount ?? 1,
			degradedExtensions: options.degradedExtensions?.map((item) => ({ ...item })) ?? [],
			unavailableTools: options.unavailableTools?.map((item) => ({ ...item })) ?? [],
		});
	}
}

interface ManagerHarness {
	manager: SubagentManager;
	sidecars: FakeSidecar[];
}

let spoolRoot = "";
let managers: SubagentManager[] = [];

beforeEach(async () => {
	spoolRoot = await mkdtemp(join(tmpdir(), "sub-agent-manager-test-"));
	await chmod(spoolRoot, 0o700);
	managers = [];
});

afterEach(async () => {
	await Promise.all(managers.map(async (manager) => manager.shutdown()));
	if (spoolRoot.length > 0) await rm(spoolRoot, { recursive: true, force: true });
});

function createHarness(autoAcceptRuns = true): ManagerHarness {
	const sidecars: FakeSidecar[] = [];
	const manager = new SubagentManager({
		cwd: "/test/project",
		agentDir: "/test/agent",
		piPackageDir: "/test/pi",
		selfExtensionPath: "/test/sub-agent/index.ts",
		settingsSnapshot: {},
		projectTrusted: true,
		config: {
			version: 1,
			model: "inherit",
			thinkingLevel: "inherit",
			requiredExtensionPaths: [],
		},
		parent: {
			model: { provider: "fixture", id: "model" },
			thinkingLevel: "off",
			projectContext: [{ path: "/test/project/AGENTS.md", content: "test context" }],
			candidateExtensionPaths: ["/test/optional.ts"],
			parentToolNames: ["read", "write"],
			parentToolSources: [{ name: "read" }, { name: "write", path: "/test/write.ts" }],
			parentActiveToolNames: ["read"],
		},
		createSpoolRoot: async () => spoolRoot,
		launchSidecar: async ({ identity }) => {
			const sidecar = new FakeSidecar({ protocolVersion: 1, ...identity }, autoAcceptRuns);
			sidecars.push(sidecar);
			return sidecar;
		},
		now: () => 1_000,
	});
	managers.push(manager);
	return { manager, sidecars };
}

function spawnFrames(sidecar: FakeSidecar): SpawnFrame[] {
	return sidecar.sent.filter((frame): frame is SpawnFrame => frame.type === "SPAWN");
}

function cancelFrames(sidecar: FakeSidecar): CancelFrame[] {
	return sidecar.sent.filter((frame): frame is CancelFrame => frame.type === "CANCEL");
}

function sendFrames(sidecar: FakeSidecar): Array<Extract<ParentFrame, { type: "SEND" }>> {
	return sidecar.sent.filter((frame): frame is Extract<ParentFrame, { type: "SEND" }> => frame.type === "SEND");
}

function requireSingleSidecar(harness: ManagerHarness): FakeSidecar {
	const sidecar = harness.sidecars[0];
	if (!sidecar) throw new Error("expected the manager to launch a sidecar");
	return sidecar;
}

function requireSpawnDetails(result: ManagerToolResult): Extract<ManagerToolResult["details"], { operation: "spawn" }> {
	if (result.details.operation !== "spawn") throw new Error("expected spawn details");
	return result.details;
}

function requireAgentListDetails(result: ManagerToolResult): AgentListDetails {
	if (result.details.operation !== "list" || (result.details.view !== "agents" && result.details.view !== "direct")) {
		throw new Error("expected an agent list");
	}
	return result.details;
}

function requireDeliveryListDetails(result: ManagerToolResult): DeliveryListDetails {
	if (result.details.operation !== "list" || result.details.view !== "deliveries") {
		throw new Error("expected a delivery list");
	}
	return result.details;
}

async function nextTurn(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitUntil(predicate: () => boolean, description: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
		if (predicate()) return;
		await nextTurn();
	}
	throw new Error(`timed out waiting for ${description}`);
}

async function spawnAccepted(
	harness: ManagerHarness,
	label: string,
): Promise<{ result: ManagerToolResult; frame: SpawnFrame; sidecar: FakeSidecar }> {
	const result = await harness.manager.spawn({
		task: `task for ${label}`,
		label,
		projectContext: "inherit",
	});
	const details = requireSpawnDetails(result);
	const sidecar = harness.sidecars.find((candidate) =>
		spawnFrames(candidate).some((frame) => frame.runId === details.runId),
	);
	if (!sidecar) throw new Error("expected the accepted spawn frame");
	const frame = spawnFrames(sidecar).find((candidate) => candidate.runId === details.runId);
	if (!frame) throw new Error("expected the accepted spawn frame");
	return { result, frame, sidecar };
}

function failedTerminal(sidecar: FakeSidecar, frame: SpawnFrame, terminalOpId: string): RunTerminalFrame {
	return {
		type: "RUN_TERMINAL",
		...sidecar.envelope(),
		terminalOpId,
		agentId: frame.agentId,
		runId: frame.runId,
		deliveryId: frame.deliveryId,
		completedAt: 900,
		outcome: "FAILED",
		failureCode: "SUBAGENT_MODEL_RUN_FAILED",
	};
}

async function emitSettled(sidecar: FakeSidecar, frame: SpawnFrame, terminalOpId: string): Promise<void> {
	await sidecar.emit({
		type: "RUN_SETTLED",
		...sidecar.envelope(),
		terminalOpId,
		agentId: frame.agentId,
		runId: frame.runId,
		deliveryId: frame.deliveryId,
	});
}

async function settleFailedRun(sidecar: FakeSidecar, frame: SpawnFrame, terminalOpId: string): Promise<void> {
	await sidecar.emit(failedTerminal(sidecar, frame, terminalOpId));
	await emitSettled(sidecar, frame, terminalOpId);
}

async function spawnRunningAgents(
	harness: ManagerHarness,
	count: number,
	labelPrefix: string,
): Promise<Array<Awaited<ReturnType<typeof spawnAccepted>>>> {
	const runs: Array<Awaited<ReturnType<typeof spawnAccepted>>> = [];
	for (let index = 0; index < count; index++) {
		runs.push(await spawnAccepted(harness, `${labelPrefix}-${index}`));
	}
	return runs;
}

function parseJson<T>(value: string): T {
	return JSON.parse(value) as T;
}

function modelVisibleAgent(item: AgentListDetails["items"][number]) {
	return {
		agentId: item.agentId,
		state: item.state,
		...(item.label === undefined ? {} : { label: item.label }),
		...(item.currentRunId === undefined ? {} : { currentRunId: item.currentRunId }),
		...(item.lastRunId === undefined ? {} : { lastRunId: item.lastRunId }),
		activeToolCount: item.activeToolCount,
		capabilityToolCount: item.capabilityToolCount,
		readyDeliveryCount: item.readyDeliveryCount,
		degradedExtensionCount: item.degradedExtensions.length,
		unavailableToolCount: item.unavailableToolCount,
	};
}

describe("run admission and terminal settlement", () => {
	it("publishes an agent only after the matching RUN_ACCEPTED and copies admitted capabilities", async () => {
		const harness = createHarness(false);
		const pending = harness.manager.spawn({
			task: "inspect the repository",
			label: "inspector",
			projectContext: "inherit",
			tools: ["read"],
		});
		await waitUntil(() => harness.sidecars.some((sidecar) => spawnFrames(sidecar).length === 1), "the SPAWN frame");
		const sidecar = requireSingleSidecar(harness);
		const frame = spawnFrames(sidecar)[0];
		if (!frame) throw new Error("expected a SPAWN frame");

		expect(requireAgentListDetails(harness.manager.list({ view: "agents", limit: 16 })).items).toEqual([]);
		expect(frame).toMatchObject({
			task: "inspect the repository",
			projectContext: [{ path: "/test/project/AGENTS.md", content: "test context" }],
			explicitTools: ["read"],
		});

		await sidecar.acceptRun(frame, {
			activeToolCount: 2,
			capabilityToolCount: 3,
			degradedExtensions: [{ path: "/test/optional.ts", code: "factory_failed" }],
			unavailableTools: [{ name: "write", reason: "extension_failed" }],
		});
		const result = await pending;
		expect(result.content).toBe(
			`Spawned sub-agent ${frame.agentId} with run ${frame.runId}.\n${JSON.stringify({
				capabilityWarnings: {
					degradedExtensionCount: 1,
					degradedExtensions: [{ pathDisplay: "/test/optional.ts", code: "factory_failed" }],
					omittedDegradedExtensionCount: 0,
					unavailableTools: [{ nameDisplay: "write", reason: "extension_failed" }],
					omittedUnavailableToolCount: 0,
				},
			})}`,
		);
		expect(requireSpawnDetails(result)).toMatchObject({
			agentId: frame.agentId,
			runId: frame.runId,
			state: "RUNNING",
			label: "inspector",
			degradedExtensions: [{ path: "/test/optional.ts", code: "factory_failed" }],
			unavailableTools: [{ name: "write", reason: "extension_failed" }],
		});
		const directResult = harness.manager.list({ agentIds: [frame.agentId] });
		const directDetails = requireAgentListDetails(directResult);
		expect(directDetails.items[0]).toMatchObject({
			agentId: frame.agentId,
			state: "RUNNING",
			currentRunId: frame.runId,
			lastRunId: frame.runId,
			activeToolCount: 2,
			capabilityToolCount: 3,
			degradedExtensions: ["/test/optional.ts"],
			unavailableToolCount: 1,
		});
		expect(parseJson(directResult.content)).toEqual({
			schemaVersion: 1,
			operation: "list",
			view: "direct",
			items: [
				expect.objectContaining({
					agentId: frame.agentId,
					degradedExtensionCount: 1,
					unavailableToolCount: 1,
				}),
			],
		});
	});

	it("ACKs a committed terminal before accepting RUN_SETTLED as the slot release", async () => {
		const harness = createHarness();
		const { frame, sidecar } = await spawnAccepted(harness, "lifecycle");

		await emitSettled(sidecar, frame, "terminal-lifecycle");
		expect(requireAgentListDetails(harness.manager.list({ agentIds: [frame.agentId] })).items[0]).toMatchObject({
			state: "RUNNING",
			currentRunId: frame.runId,
		});

		await sidecar.emit(failedTerminal(sidecar, frame, "terminal-lifecycle"));
		expect(sidecar.sent).toContainEqual({
			type: "MAILBOX_COMMIT_ACK",
			...sidecar.envelope(),
			terminalOpId: "terminal-lifecycle",
			agentId: frame.agentId,
			runId: frame.runId,
			deliveryId: frame.deliveryId,
		});
		expect(requireAgentListDetails(harness.manager.list({ agentIds: [frame.agentId] })).items[0]).toMatchObject({
			state: "RUNNING",
			currentRunId: frame.runId,
			readyDeliveryCount: 1,
		});
		expect(requireDeliveryListDetails(harness.manager.list({ view: "deliveries", limit: 16 })).items).toEqual([
			expect.objectContaining({
				deliveryId: frame.deliveryId,
				runId: frame.runId,
				state: "READY",
				outcome: "FAILED",
				failureCode: "SUBAGENT_MODEL_RUN_FAILED",
			}),
		]);

		await emitSettled(sidecar, frame, "terminal-lifecycle");
		const settled = requireAgentListDetails(harness.manager.list({ agentIds: [frame.agentId] })).items[0];
		expect(settled).toMatchObject({
			state: "IDLE",
			lastRunId: frame.runId,
			readyDeliveryCount: 1,
		});
		expect(settled).not.toHaveProperty("currentRunId");
	});
});

describe("model-visible spawn capability warnings", () => {
	it("keeps the existing one-line spawn content when no capability warning exists", async () => {
		const harness = createHarness();
		const { result, frame } = await spawnAccepted(harness, "no-warnings");

		expect(result.content).toBe(`Spawned sub-agent ${frame.agentId} with run ${frame.runId}.`);
		expect(result.content).not.toContain("\n");
	});

	it("caps warning arrays, safely truncates multibyte displays, and preserves full details", async () => {
		const harness = createHarness(false);
		const longPath = `/test/${"路径😀".repeat(200)}`;
		const longToolName = `tool-${"工具😀".repeat(100)}`;
		const degradedExtensions: NonNullable<AcceptedRunOptions["degradedExtensions"]> = Array.from(
			{ length: 10 },
			(_, index) => ({
				path: index === 0 ? longPath : `/test/extension-${index}.ts`,
				code: "factory_failed" as const,
			}),
		);
		const unavailableTools: NonNullable<AcceptedRunOptions["unavailableTools"]> = Array.from(
			{ length: 18 },
			(_, index) => ({
				name: index === 0 ? longToolName : `tool-${index}`,
				reason: "extension_failed" as const,
			}),
		);
		const pending = harness.manager.spawn({
			task: "exercise capability warning projection",
			projectContext: "none",
		});
		await waitUntil(() => harness.sidecars.some((sidecar) => spawnFrames(sidecar).length === 1), "the SPAWN frame");
		const sidecar = requireSingleSidecar(harness);
		const frame = spawnFrames(sidecar)[0];
		if (!frame) throw new Error("expected a SPAWN frame");
		await sidecar.acceptRun(frame, { degradedExtensions, unavailableTools });

		const result = await pending;
		const [baseLine, warningLine, extraLine] = result.content.split("\n");
		expect(baseLine).toBe(`Spawned sub-agent ${frame.agentId} with run ${frame.runId}.`);
		expect(extraLine).toBeUndefined();
		if (!warningLine) throw new Error("expected a model-visible capability warning");
		const warning = parseJson<{
			capabilityWarnings: {
				degradedExtensionCount: number;
				degradedExtensions: Array<{ pathDisplay: string; code: string }>;
				omittedDegradedExtensionCount: number;
				unavailableTools: Array<{ nameDisplay: string; reason: string }>;
				omittedUnavailableToolCount: number;
			};
		}>(warningLine).capabilityWarnings;

		expect(warning.degradedExtensionCount).toBe(10);
		expect(warning.degradedExtensions).toHaveLength(8);
		expect(warning.degradedExtensions.map((item) => item.code)).toEqual(Array(8).fill("factory_failed"));
		expect(warning.omittedDegradedExtensionCount).toBe(2);
		expect(warning.unavailableTools).toHaveLength(16);
		expect(warning.unavailableTools.map((item) => item.reason)).toEqual(Array(16).fill("extension_failed"));
		expect(warning.omittedUnavailableToolCount).toBe(2);
		const pathDisplay = warning.degradedExtensions[0]?.pathDisplay;
		const nameDisplay = warning.unavailableTools[0]?.nameDisplay;
		if (!pathDisplay || !nameDisplay) throw new Error("expected truncated display values");
		expect(Buffer.byteLength(pathDisplay, "utf8")).toBeLessThanOrEqual(512);
		expect(Buffer.byteLength(nameDisplay, "utf8")).toBeLessThanOrEqual(256);
		expect(pathDisplay.endsWith("…")).toBe(true);
		expect(nameDisplay.endsWith("…")).toBe(true);
		expect(pathDisplay).not.toContain("�");
		expect(nameDisplay).not.toContain("�");
		expect(Buffer.byteLength(result.content, "utf8")).toBeLessThan(16 * 1024);

		const details = requireSpawnDetails(result);
		expect(details.degradedExtensions).toEqual(degradedExtensions);
		expect(details.unavailableTools).toEqual(unavailableTools);
	});
});

describe("cancel/terminal arbitration", () => {
	it("commits CANCELLED when CANCEL_ACCEPTED wins the arbitration", async () => {
		const harness = createHarness();
		const { frame, sidecar } = await spawnAccepted(harness, "cancel-first");
		const pendingCancel = harness.manager.cancel({
			agentId: frame.agentId,
			expectedRunId: frame.runId,
			reason: "the parent no longer needs this work",
		});
		await waitUntil(() => cancelFrames(sidecar).length === 1, "the CANCEL frame");
		const cancel = cancelFrames(sidecar)[0];
		if (!cancel) throw new Error("expected a CANCEL frame");
		await sidecar.emit({
			type: "CANCEL_ACCEPTED",
			...sidecar.envelope(),
			opId: cancel.opId,
			agentId: cancel.agentId,
			runId: cancel.runId,
		});

		expect((await pendingCancel).details).toMatchObject({
			operation: "cancel",
			state: "CANCELLING",
		});
		expect(requireAgentListDetails(harness.manager.list({ agentIds: [frame.agentId] })).items[0]).toMatchObject({
			state: "CANCELLING",
			currentRunId: frame.runId,
		});

		await sidecar.emit(failedTerminal(sidecar, frame, "terminal-cancelled"));
		expect(requireDeliveryListDetails(harness.manager.list({ view: "deliveries", limit: 16 })).items[0]).toMatchObject({
			runId: frame.runId,
			outcome: "CANCELLED",
			state: "READY",
		});
		await emitSettled(sidecar, frame, "terminal-cancelled");
		expect(requireAgentListDetails(harness.manager.list({ agentIds: [frame.agentId] })).items[0]).toMatchObject({
			state: "IDLE",
		});
	});

	it("keeps the worker terminal outcome when it commits before the cancel NACK", async () => {
		const harness = createHarness();
		const { frame, sidecar } = await spawnAccepted(harness, "terminal-first");
		const pendingCancel = harness.manager.cancel({
			agentId: frame.agentId,
			expectedRunId: frame.runId,
			reason: "too late",
		});
		await waitUntil(() => cancelFrames(sidecar).length === 1, "the CANCEL frame");
		const cancel = cancelFrames(sidecar)[0];
		if (!cancel) throw new Error("expected a CANCEL frame");

		await sidecar.emit(failedTerminal(sidecar, frame, "terminal-failed"));
		await sidecar.emit({
			type: "OP_NACK",
			...sidecar.envelope(),
			opId: cancel.opId,
			operation: "cancel",
			code: "SUBAGENT_RUN_ALREADY_TERMINAL",
			agentId: frame.agentId,
			runId: frame.runId,
			message: "the run is already terminal",
		});
		await expect(pendingCancel).rejects.toMatchObject({
			name: "ManagerOperationError",
			code: "SUBAGENT_RUN_ALREADY_TERMINAL",
		});
		expect(requireDeliveryListDetails(harness.manager.list({ view: "deliveries", limit: 16 })).items[0]).toMatchObject({
			runId: frame.runId,
			outcome: "FAILED",
			failureCode: "SUBAGENT_MODEL_RUN_FAILED",
		});

		await emitSettled(sidecar, frame, "terminal-failed");
		expect(requireAgentListDetails(harness.manager.list({ agentIds: [frame.agentId] })).items[0]).toMatchObject({
			state: "IDLE",
		});
	});
});

describe("generation loss", () => {
	it("marks active agents and undelivered runs LOST, then ignores stale-generation terminals", async () => {
		const harness = createHarness();
		const { frame, sidecar } = await spawnAccepted(harness, "lost");

		await sidecar.emit({
			type: "WORKER_EXITED",
			...sidecar.envelope(),
			exitCode: 17,
			signal: null,
		});
		expect(requireAgentListDetails(harness.manager.list({ agentIds: [frame.agentId] })).items[0]).toMatchObject({
			state: "TERMINATING",
			currentRunId: frame.runId,
		});

		await sidecar.emit({
			type: "LOSS_CLEANED",
			...sidecar.envelope(),
			workerPid: sidecar.processInfo.workerPid,
			workerPgid: sidecar.processInfo.workerPgid,
		});
		const lostAgent = requireAgentListDetails(harness.manager.list({ agentIds: [frame.agentId] })).items[0];
		expect(lostAgent).toMatchObject({
			state: "LOST",
			lastRunId: frame.runId,
			readyDeliveryCount: 1,
			workerGeneration: 1,
		});
		expect(lostAgent).not.toHaveProperty("currentRunId");
		expect(requireDeliveryListDetails(harness.manager.list({ view: "deliveries", limit: 16 })).items[0]).toMatchObject({
			deliveryId: frame.deliveryId,
			runId: frame.runId,
			outcome: "LOST",
			state: "READY",
		});

		const replacement = await spawnAccepted(harness, "replacement");
		expect(replacement.sidecar).not.toBe(sidecar);
		expect(replacement.sidecar.envelope().workerGeneration).toBe(2);
		await sidecar.emit(failedTerminal(sidecar, frame, "stale-terminal"));
		expect(
			requireDeliveryListDetails(harness.manager.list({ view: "deliveries", limit: 16 })).items.find(
				(item) => item.runId === frame.runId,
			),
		).toMatchObject({ outcome: "LOST" });
	});
});

describe("concurrency and list snapshots", () => {
	it("atomically admits at most eight concurrent runs", async () => {
		const harness = createHarness();
		const seed = await spawnAccepted(harness, "seed");
		await seed.sidecar.emit(failedTerminal(seed.sidecar, seed.frame, "terminal-seed"));
		await emitSettled(seed.sidecar, seed.frame, "terminal-seed");
		seed.sidecar.autoAcceptRuns = false;
		const initialFrameCount = spawnFrames(seed.sidecar).length;

		const attempts = Array.from({ length: 9 }, (_, index) =>
			harness.manager
				.spawn({
					task: `concurrent task ${index}`,
					label: `concurrent-${index}`,
					projectContext: "none",
				})
				.then(
					(value) => ({ status: "fulfilled" as const, value }),
					(reason: unknown) => ({ status: "rejected" as const, reason }),
				),
		);
		await waitUntil(() => spawnFrames(seed.sidecar).length - initialFrameCount >= 8, "eight admitted SPAWN frames");
		await nextTurn();
		const admittedFrames = spawnFrames(seed.sidecar).slice(initialFrameCount);
		for (const frame of admittedFrames) await seed.sidecar.acceptRun(frame);
		const outcomes = await Promise.all(attempts);
		const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
		const rejected = outcomes.filter((outcome) => outcome.status === "rejected");

		expect(admittedFrames).toHaveLength(8);
		expect(fulfilled).toHaveLength(8);
		expect(rejected).toHaveLength(1);
		expect(rejected[0]?.reason).toBeInstanceOf(ManagerOperationError);
		expect(rejected[0]?.reason).toMatchObject({ code: "SUBAGENT_CONCURRENCY_LIMIT" });
		expect(
			requireAgentListDetails(harness.manager.list({ view: "agents", limit: 16 })).items.filter(
				(item) => item.state === "RUNNING",
			),
		).toHaveLength(8);
	});

	it("keeps cursor pagination on a high-water snapshot and preserves direct lookup order", async () => {
		const harness = createHarness();
		const first = await spawnAccepted(harness, "first");
		const second = await spawnAccepted(harness, "second");
		const third = await spawnAccepted(harness, "third");
		const pageOneResult = harness.manager.list({ view: "agents", limit: 2 });
		const pageOne = requireAgentListDetails(pageOneResult);
		if (pageOne.view !== "agents" || !pageOne.nextCursor) {
			throw new Error("expected a paginated agent list");
		}
		expect(pageOne.items.map((item) => item.agentId)).toEqual([first.frame.agentId, second.frame.agentId]);
		expect(parseJson(pageOneResult.content)).toEqual({
			schemaVersion: 1,
			operation: "list",
			view: "agents",
			items: pageOne.items.map(modelVisibleAgent),
			nextCursor: pageOne.nextCursor,
		});

		const fourth = await spawnAccepted(harness, "fourth");
		const pageTwoResult = harness.manager.list({
			view: "agents",
			cursor: pageOne.nextCursor,
			limit: 2,
		});
		const pageTwo = requireAgentListDetails(pageTwoResult);
		expect(pageTwo.items.map((item) => item.agentId)).toEqual([third.frame.agentId]);
		expect(pageTwo.items.map((item) => item.agentId)).not.toContain(fourth.frame.agentId);
		expect(parseJson(pageTwoResult.content)).toEqual({
			schemaVersion: 1,
			operation: "list",
			view: "agents",
			items: pageTwo.items.map(modelVisibleAgent),
		});

		const directResult = harness.manager.list({
			agentIds: [third.frame.agentId, first.frame.agentId],
		});
		const direct = requireAgentListDetails(directResult);
		expect(direct.items.map((item) => item.agentId)).toEqual([third.frame.agentId, first.frame.agentId]);
		expect(parseJson(directResult.content)).toEqual({
			schemaVersion: 1,
			operation: "list",
			view: "direct",
			items: direct.items.map(modelVisibleAgent),
		});
	});

	it("rejects a non-canonical base64url cursor signature even when it decodes to the same bytes", async () => {
		const harness = createHarness();
		await spawnAccepted(harness, "first");
		await spawnAccepted(harness, "second");
		await spawnAccepted(harness, "third");
		const firstPage = requireAgentListDetails(harness.manager.list({ view: "agents", limit: 2 }));
		if (firstPage.view !== "agents" || !firstPage.nextCursor) {
			throw new Error("expected a paginated agent list");
		}

		const [payload, signature] = firstPage.nextCursor.split(".");
		if (!payload || !signature) throw new Error("expected a signed cursor");
		const base64urlAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
		const lastCharacter = signature.at(-1);
		if (!lastCharacter) throw new Error("expected a cursor signature");
		const lastIndex = base64urlAlphabet.indexOf(lastCharacter);
		if (lastIndex < 0 || lastIndex % 4 !== 0 || lastIndex + 1 >= base64urlAlphabet.length) {
			throw new Error("expected a canonical unpadded SHA-256 signature");
		}
		const aliasedSignature = `${signature.slice(0, -1)}${base64urlAlphabet[lastIndex + 1]}`;
		expect(Buffer.from(aliasedSignature, "base64url")).toEqual(Buffer.from(signature, "base64url"));

		expect(() =>
			harness.manager.list({
				view: "agents",
				cursor: `${payload}.${aliasedSignature}`,
				limit: 2,
			}),
		).toThrowError(
			expect.objectContaining({
				name: "ManagerOperationError",
				code: "SUBAGENT_CURSOR_STALE",
			}),
		);
	});
});

describe("send error priority", () => {
	it("returns BUSY with the current run when slots are full and the target is RUNNING", async () => {
		const harness = createHarness();
		const runs = await spawnRunningAgents(harness, 8, "running-priority");
		const target = runs[0];
		if (!target) throw new Error("expected a running target");

		await expect(harness.manager.send({ agentId: target.frame.agentId, message: "second task" })).rejects.toMatchObject(
			{
				code: "SUBAGENT_BUSY",
				metadata: {
					agentId: target.frame.agentId,
					currentRunId: target.frame.runId,
				},
			},
		);
		expect(sendFrames(target.sidecar)).toHaveLength(0);
	});

	it("returns BUSY when the eighth slot is reserved for an IDLE target", async () => {
		const harness = createHarness();
		const target = await spawnAccepted(harness, "reserved-target");
		await settleFailedRun(target.sidecar, target.frame, "terminal-reserved-target");
		await spawnRunningAgents(harness, 7, "reserved-fill");
		target.sidecar.autoAcceptRuns = false;

		const acceptedSend = harness.manager.send({
			agentId: target.frame.agentId,
			message: "reserved task",
		});
		await waitUntil(() => sendFrames(target.sidecar).length === 1, "the reserved SEND frame");
		await expect(
			harness.manager.send({ agentId: target.frame.agentId, message: "competing task" }),
		).rejects.toMatchObject({
			code: "SUBAGENT_BUSY",
			metadata: { agentId: target.frame.agentId },
		});

		const frame = sendFrames(target.sidecar)[0];
		if (!frame) throw new Error("expected a SEND frame");
		await target.sidecar.acceptRun(frame);
		await expect(acceptedSend).resolves.toMatchObject({
			details: { operation: "send", agentId: target.frame.agentId, state: "RUNNING" },
		});
	});

	it("returns AGENT_LOST before the slot limit", async () => {
		const harness = createHarness();
		const target = await spawnAccepted(harness, "lost-priority");
		await target.sidecar.emit({
			type: "WORKER_EXITED",
			...target.sidecar.envelope(),
			exitCode: 17,
			signal: null,
		});
		await target.sidecar.emit({
			type: "LOSS_CLEANED",
			...target.sidecar.envelope(),
			workerPid: target.sidecar.processInfo.workerPid,
			workerPgid: target.sidecar.processInfo.workerPgid,
		});
		await spawnRunningAgents(harness, 8, "lost-fill");

		await expect(
			harness.manager.send({ agentId: target.frame.agentId, message: "cannot reuse lost agent" }),
		).rejects.toMatchObject({
			code: "SUBAGENT_AGENT_LOST",
			metadata: { agentId: target.frame.agentId },
		});
	});

	it("returns AGENT_TERMINATING before the slot limit", async () => {
		const harness = createHarness();
		const runs = await spawnRunningAgents(harness, 8, "terminating-priority");
		const target = runs[0];
		if (!target) throw new Error("expected a terminating target");
		await target.sidecar.emit({
			type: "WORKER_EXITED",
			...target.sidecar.envelope(),
			exitCode: 17,
			signal: null,
		});

		await expect(
			harness.manager.send({ agentId: target.frame.agentId, message: "cannot reuse terminating agent" }),
		).rejects.toMatchObject({
			code: "SUBAGENT_AGENT_TERMINATING",
			metadata: { agentId: target.frame.agentId },
		});
	});

	it("returns AGENT_NOT_FOUND before the slot limit", async () => {
		const harness = createHarness();
		await spawnRunningAgents(harness, 8, "missing-priority");

		await expect(
			harness.manager.send({ agentId: "agent_missing", message: "cannot find target" }),
		).rejects.toMatchObject({
			code: "SUBAGENT_AGENT_NOT_FOUND",
			metadata: { agentId: "agent_missing" },
		});
	});

	it("returns CONCURRENCY_LIMIT only for a reusable IDLE target", async () => {
		const harness = createHarness();
		const target = await spawnAccepted(harness, "idle-priority");
		await settleFailedRun(target.sidecar, target.frame, "terminal-idle-priority");
		await spawnRunningAgents(harness, 8, "idle-fill");

		await expect(
			harness.manager.send({ agentId: target.frame.agentId, message: "no global slot" }),
		).rejects.toMatchObject({
			code: "SUBAGENT_CONCURRENCY_LIMIT",
			metadata: {},
		});
	});

	it("admits exactly one of two parallel sends to the same IDLE target", async () => {
		const harness = createHarness();
		const target = await spawnAccepted(harness, "parallel-send-target");
		await settleFailedRun(target.sidecar, target.frame, "terminal-parallel-send-target");
		target.sidecar.autoAcceptRuns = false;

		const attempts = ["first", "second"].map((message) =>
			harness.manager.send({ agentId: target.frame.agentId, message }).then(
				(value) => ({ status: "fulfilled" as const, value }),
				(reason: unknown) => ({ status: "rejected" as const, reason }),
			),
		);
		await waitUntil(() => sendFrames(target.sidecar).length === 1, "one admitted SEND frame");
		const frame = sendFrames(target.sidecar)[0];
		if (!frame) throw new Error("expected an admitted SEND frame");
		await target.sidecar.acceptRun(frame);

		const outcomes = await Promise.all(attempts);
		const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
		const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
		expect(sendFrames(target.sidecar)).toHaveLength(1);
		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(1);
		expect(rejected[0]?.reason).toMatchObject({
			code: "SUBAGENT_BUSY",
			metadata: { agentId: target.frame.agentId },
		});
	});
});

describe("model-visible list projections", () => {
	it("renders empty paginated views as compact JSON", () => {
		const harness = createHarness();
		const agents = harness.manager.list({ view: "agents", limit: 16 });
		const deliveries = harness.manager.list({ view: "deliveries", limit: 16 });

		expect(agents.content).toBe(JSON.stringify({ schemaVersion: 1, operation: "list", view: "agents", items: [] }));
		expect(deliveries.content).toBe(
			JSON.stringify({ schemaVersion: 1, operation: "list", view: "deliveries", items: [] }),
		);
	});

	it("projects delivery pages in details order with a byte-identical cursor", async () => {
		const harness = createHarness();
		const runs = [
			await spawnAccepted(harness, "delivery-first"),
			await spawnAccepted(harness, "delivery-second"),
			await spawnAccepted(harness, "delivery-third"),
		];
		for (const [index, run] of runs.entries()) {
			await run.sidecar.emit(failedTerminal(run.sidecar, run.frame, `terminal-delivery-${index}`));
		}

		const firstResult = harness.manager.list({ view: "deliveries", limit: 2 });
		const firstDetails = requireDeliveryListDetails(firstResult);
		if (!firstDetails.nextCursor) throw new Error("expected a delivery cursor");
		expect(parseJson(firstResult.content)).toEqual({
			schemaVersion: 1,
			operation: "list",
			view: "deliveries",
			items: firstDetails.items,
			nextCursor: firstDetails.nextCursor,
		});

		const secondResult = harness.manager.list({
			view: "deliveries",
			cursor: firstDetails.nextCursor,
			limit: 2,
		});
		const secondDetails = requireDeliveryListDetails(secondResult);
		expect(parseJson(secondResult.content)).toEqual({
			schemaVersion: 1,
			operation: "list",
			view: "deliveries",
			items: secondDetails.items,
		});
		expect([...firstDetails.items, ...secondDetails.items].map((item) => item.runId)).toEqual(
			runs.map((run) => run.frame.runId),
		);
	});

	it("keeps a 16-item maximum-label agent projection below 64 KiB", async () => {
		const harness = createHarness();
		const maximumLabel = "😀".repeat(80);
		for (let index = 0; index < 16; index++) {
			const run = await spawnAccepted(harness, maximumLabel);
			await settleFailedRun(run.sidecar, run.frame, `terminal-max-label-${index}`);
		}

		const result = harness.manager.list({ view: "agents", limit: 16 });
		const details = requireAgentListDetails(result);
		expect(details.items).toHaveLength(16);
		expect(details.items.every((item) => item.label === maximumLabel)).toBe(true);
		expect(parseJson(result.content)).toEqual({
			schemaVersion: 1,
			operation: "list",
			view: "agents",
			items: details.items.map(modelVisibleAgent),
		});
		expect(Buffer.byteLength(result.content, "utf8")).toBeLessThan(64 * 1024);
	});
});

describe("shutdown and caller-abort races", () => {
	it("maps an aborted wait to the stable operation error and releases its reservation", async () => {
		const harness = createHarness();
		const { frame } = await spawnAccepted(harness, "wait-abort");
		const controller = new AbortController();
		const waitOutcome = harness.manager
			.wait({ runIds: [frame.runId], mode: "all" }, "wait-aborted", controller.signal)
			.then(
				(value) => value,
				(error: unknown) => error,
			);

		controller.abort();
		expect(await waitOutcome).toMatchObject({
			name: "ManagerOperationError",
			code: "SUBAGENT_OPERATION_INVALIDATED",
			metadata: { runId: frame.runId },
		});
		const timeout = await harness.manager.wait(
			{ runIds: [frame.runId], mode: "all", timeoutMs: 0 },
			"wait-after-abort",
		);
		expect(timeout.details).toEqual({
			schemaVersion: 1,
			operation: "wait",
			status: "TIMEOUT",
			mode: "all",
			timeoutMs: 0,
			pending: [{ runId: frame.runId, state: "RUNNING" }],
		});
		const [message, modelVisibleTimeout, extraLine] = timeout.content.split("\n");
		expect(message).toBe("No requested sub-agent delivery became available before the wait deadline.");
		expect(extraLine).toBeUndefined();
		if (!modelVisibleTimeout) throw new Error("expected a model-visible timeout summary");
		expect(parseJson(modelVisibleTimeout)).toEqual(timeout.details);
	});

	it("invalidates a pre-dispatch caller without cancelling or duplicating the shared cold launch", async () => {
		let launchCount = 0;
		let launchIdentity: ProtocolEnvelope | undefined;
		let resolveLaunch: ((sidecar: SidecarTransport) => void) | undefined;
		const deferredLaunch = new Promise<SidecarTransport>((resolve) => {
			resolveLaunch = resolve;
		});
		const manager = new SubagentManager({
			cwd: "/test/project",
			agentDir: "/test/agent",
			piPackageDir: "/test/pi",
			selfExtensionPath: "/test/sub-agent/index.ts",
			settingsSnapshot: {},
			projectTrusted: true,
			config: {
				version: 1,
				model: "inherit",
				thinkingLevel: "inherit",
				requiredExtensionPaths: [],
			},
			parent: {
				model: { provider: "fixture", id: "model" },
				thinkingLevel: "off",
				projectContext: [],
				candidateExtensionPaths: [],
				parentToolNames: [],
				parentToolSources: [],
				parentActiveToolNames: [],
			},
			createSpoolRoot: async () => spoolRoot,
			launchSidecar: async ({ identity }) => {
				launchCount++;
				launchIdentity = { protocolVersion: 1, ...identity };
				return await deferredLaunch;
			},
			now: () => 1_000,
		});
		managers.push(manager);
		const controller = new AbortController();
		const firstSpawn = manager.spawn({ task: "abort before dispatch", projectContext: "none" }, controller.signal).then(
			(value) => value,
			(error: unknown) => error,
		);
		await waitUntil(() => launchIdentity !== undefined, "the shared cold launch");

		controller.abort();
		expect(await firstSpawn).toMatchObject({
			name: "ManagerOperationError",
			code: "SUBAGENT_OPERATION_INVALIDATED",
		});
		expect(launchCount).toBe(1);

		const identity = launchIdentity;
		if (!identity || !resolveLaunch) throw new Error("expected a deferred launch identity");
		const sidecar = new FakeSidecar(identity, true);
		resolveLaunch(sidecar);
		const secondSpawn = await manager.spawn({ task: "reuse shared launch", projectContext: "none" });
		expect(requireSpawnDetails(secondSpawn)).toMatchObject({ state: "RUNNING" });
		expect(launchCount).toBe(1);
		expect(spawnFrames(sidecar)).toHaveLength(1);
	});

	it("reaps a sidecar whose cold launch completes during session shutdown", async () => {
		let launchIdentity: ProtocolEnvelope | undefined;
		let resolveLaunch: ((sidecar: SidecarTransport) => void) | undefined;
		const deferredLaunch = new Promise<SidecarTransport>((resolve) => {
			resolveLaunch = resolve;
		});
		const manager = new SubagentManager({
			cwd: "/test/project",
			agentDir: "/test/agent",
			piPackageDir: "/test/pi",
			selfExtensionPath: "/test/sub-agent/index.ts",
			settingsSnapshot: {},
			projectTrusted: true,
			config: {
				version: 1,
				model: "inherit",
				thinkingLevel: "inherit",
				requiredExtensionPaths: [],
			},
			parent: {
				model: { provider: "fixture", id: "model" },
				thinkingLevel: "off",
				projectContext: [],
				candidateExtensionPaths: [],
				parentToolNames: [],
				parentToolSources: [],
				parentActiveToolNames: [],
			},
			createSpoolRoot: async () => spoolRoot,
			launchSidecar: async ({ identity }) => {
				launchIdentity = { protocolVersion: 1, ...identity };
				return await deferredLaunch;
			},
			now: () => 1_000,
		});
		managers.push(manager);
		const spawnOutcome = manager.spawn({ task: "race shutdown", projectContext: "none" }).then(
			(value) => value,
			(error: unknown) => error,
		);
		await waitUntil(() => launchIdentity !== undefined, "the deferred sidecar launch");

		const shutdown = manager.shutdown();
		const identity = launchIdentity;
		if (!identity || !resolveLaunch) throw new Error("expected a deferred launch identity");
		const sidecar = new FakeSidecar(identity, false);
		resolveLaunch(sidecar);

		await shutdown;
		expect(await spawnOutcome).toMatchObject({
			name: "ManagerOperationError",
			code: "SUBAGENT_SHUTTING_DOWN",
		});
		expect(sidecar.shutdownRequests).toBe(1);
		expect(sidecar.waitForExitCalls).toBe(1);
		expect(sidecar.forceCleanupCalls).toBe(0);
		expect(sidecar.shutdownDeadlines).toEqual([5_000]);
		expect(sidecar.waitForExitDeadlines).toEqual([3_000]);
	});

	it("returns promptly when abort fires during frame write and still reconciles a late ACK", async () => {
		let sidecar: FakeSidecar | undefined;
		let releaseSend: (() => void) | undefined;
		let sendEntered = false;
		const sendGate = new Promise<void>((resolve) => {
			releaseSend = resolve;
		});
		const manager = new SubagentManager({
			cwd: "/test/project",
			agentDir: "/test/agent",
			piPackageDir: "/test/pi",
			selfExtensionPath: "/test/sub-agent/index.ts",
			settingsSnapshot: {},
			projectTrusted: true,
			config: {
				version: 1,
				model: "inherit",
				thinkingLevel: "inherit",
				requiredExtensionPaths: [],
			},
			parent: {
				model: { provider: "fixture", id: "model" },
				thinkingLevel: "off",
				projectContext: [],
				candidateExtensionPaths: [],
				parentToolNames: [],
				parentToolSources: [],
				parentActiveToolNames: [],
			},
			createSpoolRoot: async () => spoolRoot,
			launchSidecar: async ({ identity }) => {
				const launched = new FakeSidecar({ protocolVersion: 1, ...identity }, false);
				launched.send = async (frame) => {
					launched.sent.push(frame);
					sendEntered = true;
					await sendGate;
				};
				sidecar = launched;
				return launched;
			},
			now: () => 1_000,
		});
		managers.push(manager);
		const controller = new AbortController();
		const spawnOutcome = manager.spawn({ task: "race abort", projectContext: "none" }, controller.signal).then(
			(value) => value,
			(error: unknown) => error,
		);
		await waitUntil(() => sendEntered, "the blocked SPAWN write");

		controller.abort();
		if (!releaseSend) throw new Error("expected the send gate");
		releaseSend();
		const outcome = await spawnOutcome;
		const launched = sidecar;
		if (!launched) throw new Error("expected a launched sidecar");
		const frame = spawnFrames(launched)[0];
		if (!frame) throw new Error("expected a SPAWN frame");
		expect(outcome).toMatchObject({
			name: "ManagerOperationError",
			code: "SUBAGENT_START_UNCERTAIN",
			metadata: { agentId: frame.agentId, runId: frame.runId },
		});
		expect(requireAgentListDetails(manager.list({ view: "agents", limit: 16 })).items).toEqual([]);

		await launched.acceptRun(frame);
		expect(requireAgentListDetails(manager.list({ agentIds: [frame.agentId] })).items).toEqual([
			expect.objectContaining({
				agentId: frame.agentId,
				currentRunId: frame.runId,
				state: "RUNNING",
			}),
		]);
	});
});
