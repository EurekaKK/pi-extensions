import { randomUUID } from "node:crypto";
import {
	type ChildRunAdmission,
	type ChildRuntime,
	ChildRuntimeError,
	type ChildRuntimeFactory,
	type ChildTerminalCandidate,
	PiChildRuntimeFactory,
} from "./child-runtime.js";
import {
	assertControlMessageWithinLimit,
	type BootstrapFrame,
	type CancelFrame,
	type ChildFrame,
	type KillFrame,
	type MailboxCommitAckFrame,
	matchesProtocolIdentity,
	type OperationNackFrame,
	type ParentFrame,
	type ProtocolEnvelope,
	type RunAcceptedFrame,
	type RunSettledFrame,
	type RunTerminalFrame,
	type SendFrame,
	type ShutdownFrame,
	type SpawnFrame,
	SUBAGENT_PROTOCOL_VERSION,
	type WorkerOperationErrorCode,
} from "./protocol.js";
import { removeResultSpoolFile, writeResultSpool } from "./spool-writer.js";

type WorkerAgentState = "STARTING" | "RUNNING" | "CANCELLING" | "IDLE" | "TERMINATING";
type MutationFrame = SpawnFrame | SendFrame | CancelFrame | KillFrame;

interface WorkerRun {
	readonly opId: string;
	readonly operation: "spawn" | "send";
	readonly runId: string;
	readonly deliveryId: string;
	terminalQueued: boolean;
	cancelAccepted: boolean;
	cancelReason?: string;
	terminalOpId?: string;
}

interface WorkerAgent {
	readonly agentId: string;
	child?: ChildRuntime;
	state: WorkerAgentState;
	currentRun?: WorkerRun;
	lastRunId?: string;
	model: { provider: string; id: string };
	thinkingLevel: SpawnFrame["thinkingLevel"];
	activeToolCount: number;
	capabilityToolCount: number;
}

interface PendingTerminal {
	readonly agentId: string;
	readonly runId: string;
	readonly deliveryId: string;
	acked: boolean;
	resolveAck(): void;
}

export interface WorkerRuntimeOptions {
	bootstrap: BootstrapFrame;
	factory: ChildRuntimeFactory;
	sendFrame(frame: ChildFrame): Promise<void>;
	writeSpool?: typeof writeResultSpool;
	removeSpool?: typeof removeResultSpoolFile;
	now?: () => number;
	createTerminalOpId?: () => string;
	onFatal?: (error: Error) => void;
	onShutdownComplete?: () => void;
}

function envelope(frame: ProtocolEnvelope): ProtocolEnvelope {
	return {
		protocolVersion: SUBAGENT_PROTOCOL_VERSION,
		sessionNonce: frame.sessionNonce,
		managerEpoch: frame.managerEpoch,
		workerGeneration: frame.workerGeneration,
	};
}

function errorValue(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function operationOf(frame: MutationFrame): OperationNackFrame["operation"] {
	switch (frame.type) {
		case "SPAWN":
			return "spawn";
		case "SEND":
			return "send";
		case "CANCEL":
			return "cancel";
		case "KILL":
			return "kill";
	}
}

function publicFailureMessage(code: WorkerOperationErrorCode): string {
	switch (code) {
		case "SUBAGENT_INPUT_HANDLED":
			return "A Child input hook handled the delegation before an agent run started.";
		case "SUBAGENT_RUN_START_FAILED":
			return "The Child run failed before agent_start admission.";
		case "SUBAGENT_REQUIRED_EXTENSION_FAILED":
			return "A required Child extension could not be initialized.";
		case "SUBAGENT_EXPLICIT_TOOL_MISSING":
			return "A requested Child tool is unavailable.";
		case "SUBAGENT_TOOL_FORBIDDEN":
			return "Sub-agent management tools cannot be exposed to a Child agent.";
		case "SUBAGENT_EXTENSION_REHYDRATION_UNSTABLE":
			return "Child extension rehydration remained unstable after one rebuild.";
		case "SUBAGENT_MODEL_NOT_FOUND":
			return "The selected Child model is unavailable.";
		case "SUBAGENT_MODEL_AUTH_REQUIRED":
			return "The selected Child model has no configured authentication.";
		case "SUBAGENT_THINKING_UNSUPPORTED":
			return "The selected Child model does not support the requested thinking level.";
		case "SUBAGENT_PI_API_UNSUPPORTED":
			return "The installed Pi public API is incompatible with the Worker.";
		case "SUBAGENT_PROTOCOL_MISMATCH":
			return "The Worker control protocol is incompatible.";
		case "SUBAGENT_AGENT_NOT_FOUND":
			return "The Child agent does not exist in this Worker generation.";
		case "SUBAGENT_AGENT_TERMINATING":
			return "The Child agent is terminating.";
		case "SUBAGENT_AGENT_LOST":
			return "The Child agent runtime has been lost.";
		case "SUBAGENT_BUSY":
			return "The Child agent already has an active run.";
		case "SUBAGENT_RUN_ALREADY_TERMINAL":
			return "The requested Child run is already terminal.";
		case "SUBAGENT_CANCEL_STALE":
			return "The cancellation run id does not match the active Child run.";
		case "SUBAGENT_CANCEL_ALREADY_REQUESTED":
			return "Cancellation was already requested for this Child run.";
		case "SUBAGENT_KILL_BLOCKED":
			return "Only an idle Child agent can be terminated.";
		case "SUBAGENT_KILL_STALE":
			return "The termination run id does not match the Child agent's last run.";
		case "SUBAGENT_IPC_LOST":
			return "The Worker control channel is unavailable.";
	}
}

function truncateUtf8(value: string, maxBytes: number): string {
	const bytes = Buffer.from(value, "utf8");
	if (bytes.byteLength <= maxBytes) return value;
	let end = maxBytes;
	while (end > 0 && (bytes[end] ?? 0) >= 0x80 && (bytes[end] ?? 0) < 0xc0) end--;
	return bytes.subarray(0, end).toString("utf8");
}

export class WorkerRuntime {
	readonly piVersion: string;
	private readonly bootstrapFrame: BootstrapFrame;
	private readonly identity: ProtocolEnvelope;
	private readonly factory: ChildRuntimeFactory;
	private readonly rawSendFrame: (frame: ChildFrame) => Promise<void>;
	private readonly writeSpool: typeof writeResultSpool;
	private readonly removeSpool: typeof removeResultSpoolFile;
	private readonly now: () => number;
	private readonly createTerminalOpId: () => string;
	private readonly onFatal: (error: Error) => void;
	private readonly onShutdownComplete: () => void;
	private readonly agents = new Map<string, WorkerAgent>();
	private readonly operationResponses = new Map<string, ChildFrame>();
	private readonly pendingTerminals = new Map<string, PendingTerminal>();
	private readonly settledTerminals = new Map<string, RunSettledFrame>();
	private outbound = Promise.resolve();
	private shuttingDown = false;
	private shutdownPromise: Promise<void> | undefined;

	constructor(options: WorkerRuntimeOptions) {
		this.bootstrapFrame = options.bootstrap;
		this.identity = envelope(options.bootstrap);
		this.factory = options.factory;
		this.piVersion = options.factory.piVersion;
		this.rawSendFrame = options.sendFrame;
		this.writeSpool = options.writeSpool ?? writeResultSpool;
		this.removeSpool = options.removeSpool ?? removeResultSpoolFile;
		this.now = options.now ?? Date.now;
		this.createTerminalOpId = options.createTerminalOpId ?? (() => randomUUID());
		this.onFatal = options.onFatal ?? (() => undefined);
		this.onShutdownComplete = options.onShutdownComplete ?? (() => undefined);
	}

	static async bootstrap(
		frame: BootstrapFrame,
		options: Omit<WorkerRuntimeOptions, "bootstrap" | "factory">,
	): Promise<WorkerRuntime> {
		const factory = await PiChildRuntimeFactory.bootstrap(frame);
		return new WorkerRuntime({ ...options, bootstrap: frame, factory });
	}

	readyFrame(): ChildFrame {
		return {
			type: "WORKER_READY",
			...this.identity,
			workerPid: process.pid,
			workerPgid: process.pid,
			piVersion: this.piVersion,
		};
	}

	async sendReady(): Promise<void> {
		await this.queueFrame(this.readyFrame());
	}

	async handle(frame: ParentFrame): Promise<void> {
		if (!matchesProtocolIdentity(frame, this.identity) || frame.type === "BOOTSTRAP") {
			await this.protocolFailure();
			return;
		}
		if (this.shuttingDown) return;
		if ("opId" in frame) {
			const prior = this.operationResponses.get(frame.opId);
			if (prior) {
				await this.queueFrame(prior);
				return;
			}
		}
		switch (frame.type) {
			case "SPAWN":
				await this.handleSpawn(frame);
				break;
			case "SEND":
				await this.handleSend(frame);
				break;
			case "CANCEL":
				await this.handleCancel(frame);
				break;
			case "KILL":
				await this.handleKill(frame);
				break;
			case "MAILBOX_COMMIT_ACK":
				this.handleMailboxCommitAck(frame);
				break;
			case "SHUTDOWN":
				await this.shutdown(frame);
				break;
		}
	}

	async shutdown(_frame?: ShutdownFrame): Promise<void> {
		if (this.shutdownPromise) return await this.shutdownPromise;
		this.shuttingDown = true;
		for (const pending of this.pendingTerminals.values()) {
			pending.acked = true;
			pending.resolveAck();
		}
		this.shutdownPromise = (async () => {
			const agents = [...this.agents.values()];
			for (const agent of agents) {
				const run = agent.currentRun;
				if (run && agent.child) {
					agent.child.closeRunAdmissionGate(run.runId);
				}
			}
			await Promise.all(
				agents.map(async (agent) => {
					await agent.child?.shutdown().catch(() => undefined);
				}),
			);
			this.agents.clear();
			this.pendingTerminals.clear();
			this.onShutdownComplete();
		})();
		return await this.shutdownPromise;
	}

	private async handleSpawn(frame: SpawnFrame): Promise<void> {
		if (this.agents.has(frame.agentId)) {
			await this.nack(frame, "SUBAGENT_BUSY", {
				agentId: frame.agentId,
				runId: frame.runId,
			});
			return;
		}
		const agent: WorkerAgent = {
			agentId: frame.agentId,
			state: "STARTING",
			model: { ...frame.model },
			thinkingLevel: frame.thinkingLevel,
			activeToolCount: 0,
			capabilityToolCount: 0,
		};
		this.agents.set(agent.agentId, agent);
		try {
			agent.child = await this.factory.create(frame, {
				onToolStateChanged: (activeToolCount, capabilityToolCount) => {
					agent.activeToolCount = activeToolCount;
					agent.capabilityToolCount = capabilityToolCount;
					if (agent.state !== "STARTING" && agent.state !== "TERMINATING") {
						void this.queueFrame({
							type: "AGENT_TOOL_STATE",
							...this.identity,
							agentId: agent.agentId,
							activeToolCount,
							capabilityToolCount,
						}).catch((error: unknown) => this.onFatal(errorValue(error)));
					}
				},
				onWarning: (code, runId) => {
					void this.queueFrame({
						type: "WORKER_WARNING",
						...this.identity,
						code,
						agentId: agent.agentId,
						...(runId === undefined ? {} : { runId }),
					}).catch((error: unknown) => this.onFatal(errorValue(error)));
				},
			});
			agent.activeToolCount = agent.child.activeToolCount;
			agent.capabilityToolCount = agent.child.capabilityToolCount;
			const run: WorkerRun = {
				opId: frame.opId,
				operation: "spawn",
				runId: frame.runId,
				deliveryId: frame.deliveryId,
				terminalQueued: false,
				cancelAccepted: false,
			};
			agent.currentRun = run;
			agent.lastRunId = run.runId;
			const admission = await agent.child.startRun(
				{ runId: run.runId, deliveryId: run.deliveryId, text: frame.task },
				{
					onAccepted: async () => {
						agent.state = "RUNNING";
						const response = this.runAccepted(frame, agent, run);
						this.operationResponses.set(frame.opId, response);
						await this.queueFrame(response);
					},
					onTerminal: async (candidate) => {
						await this.publishTerminal(agent, run, candidate);
					},
				},
			);
			if (admission.status === "rejected") {
				await agent.child.shutdown();
				this.agents.delete(agent.agentId);
				await this.nack(frame, admission.code, {
					agentId: frame.agentId,
					runId: frame.runId,
				});
			}
		} catch (error) {
			await agent.child?.shutdown().catch(() => undefined);
			this.agents.delete(agent.agentId);
			const code = error instanceof ChildRuntimeError ? error.code : "SUBAGENT_PI_API_UNSUPPORTED";
			await this.nack(frame, code, { agentId: frame.agentId, runId: frame.runId });
		}
	}

	private async handleSend(frame: SendFrame): Promise<void> {
		const agent = this.agents.get(frame.agentId);
		if (!agent?.child) {
			await this.nack(frame, "SUBAGENT_AGENT_NOT_FOUND", {
				agentId: frame.agentId,
				runId: frame.runId,
			});
			return;
		}
		if (agent.state === "TERMINATING") {
			await this.nack(frame, "SUBAGENT_AGENT_TERMINATING", {
				agentId: frame.agentId,
				runId: frame.runId,
			});
			return;
		}
		if (agent.state !== "IDLE") {
			await this.nack(frame, "SUBAGENT_BUSY", {
				agentId: frame.agentId,
				runId: frame.runId,
				...(agent.currentRun === undefined ? {} : { currentRunId: agent.currentRun.runId }),
			});
			return;
		}

		const previousLastRunId = agent.lastRunId;
		const run: WorkerRun = {
			opId: frame.opId,
			operation: "send",
			runId: frame.runId,
			deliveryId: frame.deliveryId,
			terminalQueued: false,
			cancelAccepted: false,
		};
		agent.state = "STARTING";
		agent.currentRun = run;
		agent.lastRunId = run.runId;
		let admission: ChildRunAdmission;
		try {
			admission = await agent.child.startRun(
				{ runId: run.runId, deliveryId: run.deliveryId, text: frame.message },
				{
					onAccepted: async () => {
						agent.state = "RUNNING";
						const response = this.runAccepted(frame, agent, run);
						this.operationResponses.set(frame.opId, response);
						await this.queueFrame(response);
					},
					onTerminal: async (candidate) => {
						await this.publishTerminal(agent, run, candidate);
					},
				},
			);
		} catch {
			admission = { status: "rejected", code: "SUBAGENT_RUN_START_FAILED" };
		}
		if (admission.status === "rejected") {
			agent.state = "IDLE";
			delete agent.currentRun;
			if (previousLastRunId === undefined) delete agent.lastRunId;
			else agent.lastRunId = previousLastRunId;
			await this.nack(frame, admission.code, {
				agentId: frame.agentId,
				runId: frame.runId,
			});
		}
	}

	private async handleCancel(frame: CancelFrame): Promise<void> {
		const agent = this.agents.get(frame.agentId);
		if (!agent?.child) {
			await this.nack(frame, "SUBAGENT_AGENT_NOT_FOUND", {
				agentId: frame.agentId,
				runId: frame.runId,
			});
			return;
		}
		if (agent.state === "TERMINATING") {
			await this.nack(frame, "SUBAGENT_AGENT_TERMINATING", {
				agentId: frame.agentId,
				runId: frame.runId,
			});
			return;
		}
		const run = agent.currentRun;
		if (!run) {
			await this.nack(
				frame,
				agent.lastRunId === frame.runId ? "SUBAGENT_RUN_ALREADY_TERMINAL" : "SUBAGENT_CANCEL_STALE",
				{
					agentId: frame.agentId,
					runId: frame.runId,
					...(agent.lastRunId === undefined ? {} : { lastRunId: agent.lastRunId }),
				},
			);
			return;
		}
		if (run.runId !== frame.runId) {
			await this.nack(frame, "SUBAGENT_CANCEL_STALE", {
				agentId: frame.agentId,
				runId: frame.runId,
				currentRunId: run.runId,
			});
			return;
		}
		if (run.terminalQueued) {
			await this.nack(frame, "SUBAGENT_RUN_ALREADY_TERMINAL", {
				agentId: frame.agentId,
				runId: frame.runId,
			});
			return;
		}
		if (agent.state === "CANCELLING" || run.cancelAccepted) {
			await this.nack(frame, "SUBAGENT_CANCEL_ALREADY_REQUESTED", {
				agentId: frame.agentId,
				runId: frame.runId,
			});
			return;
		}
		if (agent.state !== "RUNNING") {
			await this.nack(frame, "SUBAGENT_BUSY", {
				agentId: frame.agentId,
				runId: frame.runId,
				currentRunId: run.runId,
			});
			return;
		}

		run.cancelAccepted = true;
		run.cancelReason = truncateUtf8(frame.reason, 2 * 1024);
		agent.state = "CANCELLING";
		agent.child.closeRunAdmissionGate(run.runId);
		const accepted: ChildFrame = {
			type: "CANCEL_ACCEPTED",
			...this.identity,
			opId: frame.opId,
			agentId: frame.agentId,
			runId: frame.runId,
		};
		this.operationResponses.set(frame.opId, accepted);
		const sent = this.queueFrame(accepted);
		void agent.child.abort(run.runId).catch(() => {
			void this.queueFrame({
				type: "WORKER_WARNING",
				...this.identity,
				code: "SUBAGENT_CANCEL_ABORT_FAILED",
				agentId: agent.agentId,
				runId: run.runId,
			}).catch((error: unknown) => this.onFatal(errorValue(error)));
		});
		await sent;
	}

	private async handleKill(frame: KillFrame): Promise<void> {
		const agent = this.agents.get(frame.agentId);
		if (!agent?.child) {
			await this.nack(frame, "SUBAGENT_AGENT_NOT_FOUND", { agentId: frame.agentId });
			return;
		}
		if (agent.state === "TERMINATING") {
			await this.nack(frame, "SUBAGENT_AGENT_TERMINATING", { agentId: frame.agentId });
			return;
		}
		if (agent.state !== "IDLE") {
			await this.nack(frame, "SUBAGENT_KILL_BLOCKED", {
				agentId: frame.agentId,
				...(agent.currentRun === undefined ? {} : { currentRunId: agent.currentRun.runId }),
			});
			return;
		}
		if (agent.lastRunId !== frame.lastRunId) {
			await this.nack(frame, "SUBAGENT_KILL_STALE", {
				agentId: frame.agentId,
				...(agent.lastRunId === undefined ? {} : { lastRunId: agent.lastRunId }),
			});
			return;
		}
		agent.state = "TERMINATING";
		const accepted: ChildFrame = {
			type: "KILL_ACCEPTED",
			...this.identity,
			opId: frame.opId,
			agentId: frame.agentId,
			lastRunId: frame.lastRunId,
		};
		this.operationResponses.set(frame.opId, accepted);
		const sent = this.queueFrame(accepted);
		void this.cleanupKilledAgent(agent, frame);
		await sent;
	}

	private async cleanupKilledAgent(agent: WorkerAgent, frame: KillFrame): Promise<void> {
		await agent.child?.shutdown().catch(() => {
			void this.queueFrame({
				type: "WORKER_WARNING",
				...this.identity,
				code: "SUBAGENT_SESSION_SHUTDOWN_FAILED",
				agentId: agent.agentId,
			}).catch((error: unknown) => this.onFatal(errorValue(error)));
		});
		if (this.shuttingDown) return;
		this.agents.delete(agent.agentId);
		await this.queueFrame({
			type: "KILL_SETTLED",
			...this.identity,
			opId: frame.opId,
			agentId: frame.agentId,
			lastRunId: frame.lastRunId,
		}).catch((error: unknown) => this.onFatal(errorValue(error)));
	}

	private runAccepted(frame: SpawnFrame | SendFrame, agent: WorkerAgent, run: WorkerRun): RunAcceptedFrame {
		const child = agent.child;
		if (!child) throw new Error("Child runtime is unavailable at admission.");
		return {
			type: "RUN_ACCEPTED",
			...this.identity,
			opId: frame.opId,
			operation: run.operation,
			agentId: agent.agentId,
			runId: run.runId,
			model: { ...agent.model },
			thinkingLevel: agent.thinkingLevel,
			activeToolCount: agent.activeToolCount,
			capabilityToolCount: agent.capabilityToolCount,
			degradedExtensions: child.degradedExtensions.map((item) => ({ ...item })),
			unavailableTools: child.unavailableTools.map((item) => ({ ...item })),
		};
	}

	private async publishTerminal(
		agent: WorkerAgent,
		run: WorkerRun,
		initialCandidate: ChildTerminalCandidate,
	): Promise<void> {
		if (this.shuttingDown || agent.currentRun !== run || run.terminalQueued) return;
		let candidate = initialCandidate;
		let spool:
			| {
					basename: string;
					byteSize: number;
					digest: string;
			  }
			| undefined;
		if (candidate.outcome === "RESULT" && !run.cancelAccepted) {
			try {
				spool = await this.writeSpool(this.bootstrapFrame.spoolDir, run.deliveryId, candidate.report);
			} catch {
				candidate = {
					outcome: "FAILED",
					failureCode: "SUBAGENT_DELIVERY_STORAGE_FAILED",
				};
			}
		}
		if (this.shuttingDown || agent.currentRun !== run || run.terminalQueued) return;

		const cancelled = run.cancelAccepted;
		run.terminalQueued = true;
		const terminalOpId = this.createTerminalOpId();
		run.terminalOpId = terminalOpId;
		let resolveAck!: () => void;
		const ack = new Promise<void>((resolve) => {
			resolveAck = resolve;
		});
		this.pendingTerminals.set(terminalOpId, {
			agentId: agent.agentId,
			runId: run.runId,
			deliveryId: run.deliveryId,
			acked: false,
			resolveAck,
		});

		let terminal: RunTerminalFrame;
		if (cancelled) {
			if (spool) {
				await this.removeSpool(this.bootstrapFrame.spoolDir, run.deliveryId).catch(() => undefined);
			}
			terminal = {
				type: "RUN_TERMINAL",
				...this.identity,
				terminalOpId,
				agentId: agent.agentId,
				runId: run.runId,
				deliveryId: run.deliveryId,
				completedAt: this.now(),
				outcome: "CANCELLED",
				cancelReason: run.cancelReason ?? "Cancellation was requested by the parent.",
			};
		} else if (candidate.outcome === "RESULT" && spool) {
			terminal = {
				type: "RUN_TERMINAL",
				...this.identity,
				terminalOpId,
				agentId: agent.agentId,
				runId: run.runId,
				deliveryId: run.deliveryId,
				completedAt: this.now(),
				outcome: "RESULT",
				spool,
			};
		} else {
			terminal = {
				type: "RUN_TERMINAL",
				...this.identity,
				terminalOpId,
				agentId: agent.agentId,
				runId: run.runId,
				deliveryId: run.deliveryId,
				completedAt: this.now(),
				outcome: "FAILED",
				failureCode: candidate.outcome === "FAILED" ? candidate.failureCode : "SUBAGENT_DELIVERY_STORAGE_FAILED",
			};
		}

		await this.queueFrame(terminal);
		await ack;
		this.pendingTerminals.delete(terminalOpId);
		if (this.shuttingDown) return;
		const settled: RunSettledFrame = {
			type: "RUN_SETTLED",
			...this.identity,
			terminalOpId,
			agentId: agent.agentId,
			runId: run.runId,
			deliveryId: run.deliveryId,
		};
		this.settledTerminals.set(terminalOpId, settled);
		if (agent.currentRun === run && !this.shuttingDown) {
			delete agent.currentRun;
			agent.state = "IDLE";
		}
		await this.queueFrame(settled);
	}

	private handleMailboxCommitAck(frame: MailboxCommitAckFrame): void {
		const settled = this.settledTerminals.get(frame.terminalOpId);
		if (
			settled &&
			settled.agentId === frame.agentId &&
			settled.runId === frame.runId &&
			settled.deliveryId === frame.deliveryId
		) {
			void this.queueFrame(settled).catch((error: unknown) => this.onFatal(errorValue(error)));
			return;
		}
		const pending = this.pendingTerminals.get(frame.terminalOpId);
		if (
			!pending ||
			pending.agentId !== frame.agentId ||
			pending.runId !== frame.runId ||
			pending.deliveryId !== frame.deliveryId ||
			pending.acked
		) {
			return;
		}
		pending.acked = true;
		pending.resolveAck();
	}

	private async nack(
		frame: MutationFrame,
		code: WorkerOperationErrorCode,
		metadata: {
			agentId?: string;
			runId?: string;
			currentRunId?: string;
			lastRunId?: string;
		} = {},
	): Promise<void> {
		const response: OperationNackFrame = {
			type: "OP_NACK",
			...this.identity,
			opId: frame.opId,
			operation: operationOf(frame),
			code,
			...metadata,
			message: publicFailureMessage(code),
		};
		this.operationResponses.set(frame.opId, response);
		await this.queueFrame(response);
	}

	private queueFrame(frame: ChildFrame): Promise<void> {
		assertControlMessageWithinLimit(frame);
		const operation = this.outbound.then(async () => {
			await this.rawSendFrame(frame);
		});
		this.outbound = operation.catch((error: unknown) => {
			this.onFatal(errorValue(error));
		});
		return operation;
	}

	private async protocolFailure(): Promise<void> {
		await this.queueFrame({
			type: "PROTOCOL_ERROR",
			...this.identity,
			code: "SUBAGENT_PROTOCOL_MISMATCH",
		});
		this.onFatal(new Error("SUBAGENT_PROTOCOL_MISMATCH"));
	}
}
