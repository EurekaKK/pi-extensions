import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { realpath } from "node:fs/promises";
import type {
	BootstrapFrame,
	ChildFrame,
	ChildModelSelection,
	DegradedExtensionV1,
	JsonObject,
	ParentFrame,
	RunTerminalFrame,
	SpawnFrame,
	ThinkingLevelV1,
	UnavailableToolV1,
} from "../sidecar/protocol.js";
import { assertControlMessageWithinLimit } from "../sidecar/protocol.js";
import type { SubagentConfigV1 } from "./config.js";
import type {
	AgentListItemV1,
	AgentStateV1,
	CancelInputV1,
	DeliveryListItemV1,
	DeliveryResultV1,
	ErrorMetadataV1,
	KillInputV1,
	ListInputV1,
	ManagementErrorCodeV1,
	SendInputV1,
	SpawnInputV1,
	SuccessDetailsV1,
	WaitInputV1,
} from "./contracts.js";
import { type ClaimedDelivery, type DeliveryRecord, Mailbox, MailboxError, type WaitResolution } from "./mailbox.js";
import { buildDeliveryEnvelope, type DeliveryEnvelopeInputV1, type ParentTransientSnapshotV1 } from "./prompts.js";
import { SidecarClient, type SidecarLaunchOptions } from "./sidecar-client.js";
import {
	cleanupOrphanSpools,
	createSessionSpoolDirectory,
	removeSessionSpoolDirectory,
	verifyResultSpoolCommit,
} from "./spool.js";

const MAX_RUNNING_RUNS = 8;
const MAX_SPAWN_WARNING_CONTENT_BYTES = 16 * 1024;
const MAX_VISIBLE_DEGRADED_EXTENSIONS = 8;
const MAX_VISIBLE_UNAVAILABLE_TOOLS = 16;
const MAX_PATH_DISPLAY_BYTES = 512;
const MAX_TOOL_NAME_DISPLAY_BYTES = 256;
const FORBIDDEN_CHILD_TOOLS = new Set([
	"subagent_spawn",
	"subagent_send",
	"subagent_wait",
	"subagent_list",
	"subagent_cancel",
	"subagent_kill",
]);

export interface ParentRuntimeSnapshot {
	model: ChildModelSelection;
	thinkingLevel: ThinkingLevelV1;
	projectContext: Array<{ path: string; content: string }>;
	candidateExtensionPaths: string[];
	parentToolNames: string[];
	parentToolSources: Array<{ name: string; path?: string }>;
	parentActiveToolNames: string[];
}

export interface ManagerOptions {
	cwd: string;
	agentDir: string;
	piPackageDir: string;
	selfExtensionPath: string;
	settingsSnapshot: JsonObject;
	projectTrusted: boolean;
	config: SubagentConfigV1;
	parent: ParentRuntimeSnapshot;
	launchSidecar?: (options: SidecarLaunchOptions) => Promise<SidecarTransport>;
	createSpoolRoot?: () => Promise<string>;
	now?: () => number;
}

export interface SidecarTransport {
	readonly processInfo: {
		guardianPid: number;
		workerPid: number;
		workerPgid: number;
		piVersion: string;
	};
	onFrame(listener: (frame: ChildFrame) => void | Promise<void>): () => void;
	onExit(listener: (exit: { code: number | null; signal: NodeJS.Signals | null }) => void | Promise<void>): () => void;
	send(frame: ParentFrame): Promise<void>;
	requestShutdown(deadlineAt: number): Promise<void>;
	waitForExit(deadlineAt: number): Promise<boolean>;
	forceCleanup(deadlineAt?: number): Promise<void>;
	envelope(): {
		protocolVersion: 1;
		sessionNonce: string;
		managerEpoch: string;
		workerGeneration: number;
	};
}

export class ManagerOperationError extends Error {
	constructor(
		readonly code: ManagementErrorCodeV1,
		readonly metadata: ErrorMetadataV1 = {},
		message: string = code,
	) {
		super(message);
		this.name = "ManagerOperationError";
	}
}

interface AgentRecord {
	agentId: string;
	sequence: number;
	label?: string;
	state: AgentStateV1;
	currentRunId: string | undefined;
	lastRunId: string | undefined;
	model: ChildModelSelection;
	thinkingLevel: ThinkingLevelV1;
	activeToolCount: number;
	capabilityToolCount: number;
	degradedExtensions: DegradedExtensionV1[];
	unavailableTools: UnavailableToolV1[];
	workerGeneration: number;
	provisional: boolean;
}

interface RunRecord {
	runId: string;
	deliveryId: string;
	agentId: string;
	workerGeneration: number;
	accepted: boolean;
	terminalCommitted: boolean;
	terminalOpId: string | undefined;
	settled: boolean;
	cancelCommitted: boolean;
}

type OperationKind = "spawn" | "send" | "cancel" | "kill";

interface PendingOperation {
	opId: string;
	kind: OperationKind;
	agentId: string;
	runId: string | undefined;
	resolve: (frame: ChildFrame) => void;
	reject: (error: Error) => void;
}

interface AcceptedKill {
	opId: string;
	lastRunId: string;
	workerGeneration: number;
}

interface CursorPayload {
	version: 1;
	epoch: string;
	view: "agents" | "deliveries";
	highWater: number;
	lastSequence: number;
	states: string[];
}

interface ModelVisibleAgentV1 {
	agentId: string;
	state: AgentStateV1;
	label?: string;
	currentRunId?: string;
	lastRunId?: string;
	activeToolCount: number;
	capabilityToolCount: number;
	readyDeliveryCount: number;
	degradedExtensionCount: number;
	unavailableToolCount: number;
}

interface ModelVisibleSpawnWarningsV1 {
	capabilityWarnings: {
		degradedExtensionCount: number;
		degradedExtensions: Array<{
			pathDisplay: string;
			code: DegradedExtensionV1["code"];
		}>;
		omittedDegradedExtensionCount: number;
		unavailableTools: Array<{
			nameDisplay: string;
			reason: UnavailableToolV1["reason"];
		}>;
		omittedUnavailableToolCount: number;
	};
}

export interface ManagerToolResult {
	content: string;
	details: SuccessDetailsV1;
	isError: boolean;
}

function opaqueId(prefix: string): string {
	return `${prefix}_${randomBytes(18).toString("base64url")}`;
}

function errorMetadata(values: {
	agentId?: string | undefined;
	runId?: string | undefined;
	currentRunId?: string | undefined;
	lastRunId?: string | undefined;
}): ErrorMetadataV1 {
	return {
		...(values.agentId === undefined ? {} : { agentId: values.agentId }),
		...(values.runId === undefined ? {} : { runId: values.runId }),
		...(values.currentRunId === undefined ? {} : { currentRunId: values.currentRunId }),
		...(values.lastRunId === undefined ? {} : { lastRunId: values.lastRunId }),
	};
}

function copyParentSnapshot(parent: ParentRuntimeSnapshot): ParentRuntimeSnapshot {
	return {
		model: { ...parent.model },
		thinkingLevel: parent.thinkingLevel,
		projectContext: parent.projectContext.map((entry) => ({ ...entry })),
		candidateExtensionPaths: [...parent.candidateExtensionPaths],
		parentToolNames: [...parent.parentToolNames],
		parentToolSources: parent.parentToolSources.map((source) => ({ ...source })),
		parentActiveToolNames: [...parent.parentActiveToolNames],
	};
}

function serializeCursor(payload: CursorPayload, secret: string): string {
	const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
	const signature = createHmac("sha256", secret).update(encoded).digest("base64url");
	return `${encoded}.${signature}`;
}

function parseCursor(value: string, secret: string): CursorPayload | undefined {
	try {
		const [encoded, suppliedSignature, extra] = value.split(".");
		if (!encoded || !suppliedSignature || extra !== undefined) return undefined;
		const encodedPayload = Buffer.from(encoded, "base64url");
		const supplied = Buffer.from(suppliedSignature, "base64url");
		if (encodedPayload.toString("base64url") !== encoded || supplied.toString("base64url") !== suppliedSignature) {
			return undefined;
		}
		const expectedSignature = createHmac("sha256", secret).update(encoded).digest();
		if (supplied.byteLength !== expectedSignature.byteLength || !timingSafeEqual(supplied, expectedSignature)) {
			return undefined;
		}
		const decoded: unknown = JSON.parse(encodedPayload.toString("utf8"));
		if (
			typeof decoded !== "object" ||
			decoded === null ||
			!("version" in decoded) ||
			decoded.version !== 1 ||
			!("epoch" in decoded) ||
			typeof decoded.epoch !== "string" ||
			!("view" in decoded) ||
			(decoded.view !== "agents" && decoded.view !== "deliveries") ||
			!("highWater" in decoded) ||
			typeof decoded.highWater !== "number" ||
			!Number.isSafeInteger(decoded.highWater) ||
			!("lastSequence" in decoded) ||
			typeof decoded.lastSequence !== "number" ||
			!Number.isSafeInteger(decoded.lastSequence) ||
			!("states" in decoded) ||
			!Array.isArray(decoded.states) ||
			!decoded.states.every((state) => typeof state === "string")
		) {
			return undefined;
		}
		return decoded as CursorPayload;
	} catch {
		return undefined;
	}
}

function renderDelivery(delivery: ClaimedDelivery): string {
	const base = {
		agentId: delivery.agentId,
		runId: delivery.runId,
		deliveryId: delivery.deliveryId,
	};
	let input: DeliveryEnvelopeInputV1;
	if (delivery.outcome === "RESULT") {
		input = { ...base, outcome: "RESULT", report: delivery.report ?? "" };
	} else if (delivery.outcome === "FAILED") {
		input = {
			...base,
			outcome: "FAILED",
			failureCode: delivery.failureCode ?? "SUBAGENT_MODEL_RUN_FAILED",
		};
	} else if (delivery.outcome === "CANCELLED") {
		input = {
			...base,
			outcome: "CANCELLED",
			...(delivery.cancelReason === undefined ? {} : { reason: delivery.cancelReason }),
		};
	} else {
		input = { ...base, outcome: "LOST" };
	}
	return buildDeliveryEnvelope(input);
}

function deliveryResult(record: DeliveryRecord): DeliveryResultV1 {
	const base = {
		deliveryId: record.deliveryId,
		agentId: record.agentId,
		runId: record.runId,
		sequence: record.sequence,
		completedAt: record.completedAt,
	};
	if (record.outcome === "FAILED") {
		return {
			...base,
			outcome: "FAILED",
			failureCode: record.failureCode ?? "SUBAGENT_MODEL_RUN_FAILED",
		};
	}
	return { ...base, outcome: record.outcome };
}

function truncateUtf8WithEllipsis(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	const ellipsis = "…";
	const contentBudget = maxBytes - Buffer.byteLength(ellipsis, "utf8");
	let byteLength = 0;
	let truncated = "";
	for (const codePoint of value) {
		const codePointBytes = Buffer.byteLength(codePoint, "utf8");
		if (byteLength + codePointBytes > contentBudget) break;
		truncated += codePoint;
		byteLength += codePointBytes;
	}
	return `${truncated}${ellipsis}`;
}

function modelVisibleAgent(item: AgentListItemV1): ModelVisibleAgentV1 {
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

function renderAgentListContent(view: "agents" | "direct", items: AgentListItemV1[], nextCursor?: string): string {
	return JSON.stringify({
		schemaVersion: 1,
		operation: "list",
		view,
		items: items.map(modelVisibleAgent),
		...(nextCursor === undefined ? {} : { nextCursor }),
	});
}

function renderDeliveryListContent(items: DeliveryListItemV1[], nextCursor?: string): string {
	return JSON.stringify({
		schemaVersion: 1,
		operation: "list",
		view: "deliveries",
		items: items.map((item) => ({ ...item })),
		...(nextCursor === undefined ? {} : { nextCursor }),
	});
}

function renderSpawnContent(
	baseContent: string,
	degradedExtensions: readonly DegradedExtensionV1[],
	unavailableTools: readonly UnavailableToolV1[],
): string {
	if (degradedExtensions.length === 0 && unavailableTools.length === 0) return baseContent;

	const visibleDegradedExtensions: ModelVisibleSpawnWarningsV1["capabilityWarnings"]["degradedExtensions"] = [];
	const visibleUnavailableTools: ModelVisibleSpawnWarningsV1["capabilityWarnings"]["unavailableTools"] = [];
	const renderWarnings = (): string =>
		JSON.stringify({
			capabilityWarnings: {
				degradedExtensionCount: degradedExtensions.length,
				degradedExtensions: visibleDegradedExtensions,
				omittedDegradedExtensionCount: degradedExtensions.length - visibleDegradedExtensions.length,
				unavailableTools: visibleUnavailableTools,
				omittedUnavailableToolCount: unavailableTools.length - visibleUnavailableTools.length,
			},
		} satisfies ModelVisibleSpawnWarningsV1);
	const fitsContentBudget = (): boolean =>
		Buffer.byteLength(`${baseContent}\n${renderWarnings()}`, "utf8") < MAX_SPAWN_WARNING_CONTENT_BYTES;

	for (const item of degradedExtensions.slice(0, MAX_VISIBLE_DEGRADED_EXTENSIONS)) {
		visibleDegradedExtensions.push({
			pathDisplay: truncateUtf8WithEllipsis(item.path, MAX_PATH_DISPLAY_BYTES),
			code: item.code,
		});
		if (!fitsContentBudget()) {
			visibleDegradedExtensions.pop();
			break;
		}
	}
	for (const item of unavailableTools.slice(0, MAX_VISIBLE_UNAVAILABLE_TOOLS)) {
		visibleUnavailableTools.push({
			nameDisplay: truncateUtf8WithEllipsis(item.name, MAX_TOOL_NAME_DISPLAY_BYTES),
			reason: item.reason,
		});
		if (!fitsContentBudget()) {
			visibleUnavailableTools.pop();
			break;
		}
	}

	return `${baseContent}\n${renderWarnings()}`;
}

export class SubagentManager {
	readonly managerEpoch = opaqueId("epoch");
	readonly sessionNonce = opaqueId("session");
	readonly #options: ManagerOptions;
	readonly #now: () => number;
	#parent: ParentRuntimeSnapshot;
	#sidecar: SidecarTransport | undefined;
	#sidecarLaunch: Promise<SidecarTransport> | undefined;
	#sidecarLaunchController: AbortController | undefined;
	#spoolRoot: string | undefined;
	#mailbox: Mailbox | undefined;
	#workerGeneration = 0;
	#recovering = false;
	#shuttingDown = false;
	#runningSlots = 0;
	#nextAgentSequence = 0;
	readonly #agents = new Map<string, AgentRecord>();
	readonly #runs = new Map<string, RunRecord>();
	readonly #pendingOperations = new Map<string, PendingOperation>();
	readonly #reservedAgentIds = new Set<string>();
	readonly #pendingCancelRunIds = new Set<string>();
	readonly #pendingKillAgentIds = new Set<string>();
	readonly #acceptedKills = new Map<string, AcceptedKill>();

	constructor(options: ManagerOptions) {
		this.#options = options;
		this.#now = options.now ?? Date.now;
		this.#parent = copyParentSnapshot(options.parent);
	}

	updateParentSnapshot(parent: ParentRuntimeSnapshot): void {
		this.#parent = copyParentSnapshot(parent);
	}

	async spawn(input: SpawnInputV1, signal?: AbortSignal): Promise<ManagerToolResult> {
		this.#assertMutable("spawn", signal);
		if (this.#runningSlots >= MAX_RUNNING_RUNS) {
			throw new ManagerOperationError("SUBAGENT_CONCURRENCY_LIMIT");
		}
		if (input.tools?.some((name) => FORBIDDEN_CHILD_TOOLS.has(name))) {
			throw new ManagerOperationError("SUBAGENT_TOOL_FORBIDDEN");
		}
		const model =
			this.#options.config.model === "inherit" ? { ...this.#parent.model } : { ...this.#options.config.model };
		if (model.provider.length === 0 || model.id.length === 0) {
			throw new ManagerOperationError("SUBAGENT_MODEL_NOT_FOUND");
		}
		const thinkingLevel =
			this.#options.config.thinkingLevel === "inherit"
				? this.#parent.thinkingLevel
				: this.#options.config.thinkingLevel;
		this.#runningSlots++;
		let sidecar: SidecarTransport;
		try {
			sidecar = await this.#ensureSidecar(signal);
		} catch (error) {
			this.#runningSlots = Math.max(0, this.#runningSlots - 1);
			throw error;
		}
		const agentId = opaqueId("agent");
		const runId = opaqueId("run");
		const deliveryId = opaqueId("delivery");
		const opId = opaqueId("op");
		const agent: AgentRecord = {
			agentId,
			sequence: this.#nextAgentSequence++,
			...(input.label === undefined ? {} : { label: input.label }),
			state: "RUNNING",
			currentRunId: runId,
			lastRunId: runId,
			model,
			thinkingLevel,
			activeToolCount: 0,
			capabilityToolCount: 0,
			degradedExtensions: [],
			unavailableTools: [],
			workerGeneration: this.#workerGeneration,
			provisional: true,
		};
		const run: RunRecord = {
			runId,
			deliveryId,
			agentId,
			workerGeneration: this.#workerGeneration,
			accepted: false,
			terminalCommitted: false,
			terminalOpId: undefined,
			settled: false,
			cancelCommitted: false,
		};
		const frame: SpawnFrame = {
			type: "SPAWN",
			...sidecar.envelope(),
			opId,
			agentId,
			runId,
			deliveryId,
			task: input.task,
			model,
			thinkingLevel,
			projectContext:
				input.projectContext === "inherit" && this.#options.projectTrusted
					? this.#parent.projectContext.map((entry) => ({ ...entry }))
					: [],
			candidateExtensionPaths: [...this.#parent.candidateExtensionPaths],
			requiredExtensionPaths: [...this.#options.config.requiredExtensionPaths],
			parentToolNames: [...this.#parent.parentToolNames],
			parentToolSources: this.#parent.parentToolSources.map((source) => ({ ...source })),
			parentActiveToolNames: [...this.#parent.parentActiveToolNames],
			...(input.tools === undefined ? {} : { explicitTools: [...input.tools] }),
		};
		try {
			assertControlMessageWithinLimit(frame);
		} catch {
			this.#runningSlots = Math.max(0, this.#runningSlots - 1);
			throw new ManagerOperationError("SUBAGENT_SESSION_SNAPSHOT_TOO_LARGE");
		}
		this.#agents.set(agentId, agent);
		this.#runs.set(runId, run);
		this.#mailbox?.registerRun(runId);

		let response: ChildFrame;
		try {
			response = await this.#dispatch(sidecar, opId, "spawn", agentId, runId, frame, signal);
		} catch (error) {
			if (!run.accepted && !this.#pendingOperations.has(opId) && !this.#recovering) {
				this.#discardProvisional(agentId, runId);
			}
			throw error;
		}
		if (response.type !== "RUN_ACCEPTED") {
			throw new ManagerOperationError("SUBAGENT_PROTOCOL_MISMATCH", { agentId, runId });
		}
		const baseContent = `Spawned sub-agent ${agentId} with run ${runId}.`;
		return {
			content: renderSpawnContent(baseContent, agent.degradedExtensions, agent.unavailableTools),
			details: {
				schemaVersion: 1,
				operation: "spawn",
				agentId,
				runId,
				state: "RUNNING",
				...(agent.label === undefined ? {} : { label: agent.label }),
				degradedExtensions: agent.degradedExtensions.map((item) => ({ ...item })),
				unavailableTools: agent.unavailableTools.map((item) => ({ ...item })),
			},
			isError: false,
		};
	}

	async send(input: SendInputV1, signal?: AbortSignal): Promise<ManagerToolResult> {
		this.#assertMutable("send", signal);
		const agent = this.#requireAgent(input.agentId, "send");
		if (agent.state === "LOST") throw new ManagerOperationError("SUBAGENT_AGENT_LOST", { agentId: agent.agentId });
		if (agent.state === "TERMINATING") {
			throw new ManagerOperationError("SUBAGENT_AGENT_TERMINATING", { agentId: agent.agentId });
		}
		if (agent.state !== "IDLE" || this.#reservedAgentIds.has(agent.agentId)) {
			throw new ManagerOperationError(
				"SUBAGENT_BUSY",
				errorMetadata({
					agentId: agent.agentId,
					currentRunId: agent.currentRunId,
				}),
			);
		}
		if (this.#runningSlots >= MAX_RUNNING_RUNS) {
			throw new ManagerOperationError("SUBAGENT_CONCURRENCY_LIMIT");
		}
		this.#runningSlots++;
		this.#reservedAgentIds.add(agent.agentId);
		let sidecar: SidecarTransport;
		try {
			sidecar = await this.#ensureSidecar(signal);
		} catch (error) {
			this.#reservedAgentIds.delete(agent.agentId);
			this.#runningSlots = Math.max(0, this.#runningSlots - 1);
			throw error;
		}
		const runId = opaqueId("run");
		const deliveryId = opaqueId("delivery");
		const opId = opaqueId("op");
		const run: RunRecord = {
			runId,
			deliveryId,
			agentId: agent.agentId,
			workerGeneration: this.#workerGeneration,
			accepted: false,
			terminalCommitted: false,
			terminalOpId: undefined,
			settled: false,
			cancelCommitted: false,
		};
		this.#runs.set(runId, run);
		this.#mailbox?.registerRun(runId);

		try {
			const response = await this.#dispatch(
				sidecar,
				opId,
				"send",
				agent.agentId,
				runId,
				{
					type: "SEND",
					...sidecar.envelope(),
					opId,
					agentId: agent.agentId,
					runId,
					deliveryId,
					message: input.message,
				},
				signal,
			);
			if (response.type !== "RUN_ACCEPTED") {
				throw new ManagerOperationError("SUBAGENT_PROTOCOL_MISMATCH", {
					agentId: agent.agentId,
					runId,
				});
			}
		} catch (error) {
			if (!run.accepted && !this.#pendingOperations.has(opId) && !this.#recovering) {
				this.#discardPreparedSend(agent.agentId, runId);
			}
			throw error;
		}
		return {
			content: `Sent a new task to sub-agent ${agent.agentId} as run ${runId}.`,
			details: {
				schemaVersion: 1,
				operation: "send",
				agentId: agent.agentId,
				runId,
				state: "RUNNING",
			},
			isError: false,
		};
	}

	async wait(input: WaitInputV1, toolCallId: string, signal?: AbortSignal): Promise<ManagerToolResult> {
		this.#assertAvailable("wait");
		const mailbox = this.#requireMailbox();
		const firstRunId = input.runIds[0];
		if (firstRunId === undefined) throw new ManagerOperationError("SUBAGENT_RUN_NOT_FOUND");
		let resolution: WaitResolution;
		try {
			resolution = await mailbox.wait(input.runIds, input.mode, input.timeoutMs, signal);
		} catch (error) {
			throw this.#mapMailboxError(error, firstRunId);
		}
		if (resolution.status === "TIMEOUT") {
			const details: SuccessDetailsV1 = {
				schemaVersion: 1,
				operation: "wait",
				status: "TIMEOUT",
				mode: input.mode,
				timeoutMs: resolution.timeoutMs,
				pending: resolution.pending,
			};
			return {
				content: `No requested sub-agent delivery became available before the wait deadline.\n${JSON.stringify(details)}`,
				details,
				isError: false,
			};
		}

		try {
			const claimed = await mailbox.claimAndRender(resolution.waitId, toolCallId, (deliveries) =>
				deliveries.map(renderDelivery).join("\n\n"),
			);
			const details: SuccessDetailsV1 = {
				schemaVersion: 1,
				operation: "wait",
				status: "DELIVERED",
				mode: input.mode,
				deliveries: claimed.deliveries.map(deliveryResult),
				remainingRunIds: claimed.remainingRunIds,
			};
			mailbox.markAwaitingPersistence(toolCallId);
			return {
				content: claimed.content,
				details,
				isError: claimed.isError,
			};
		} catch (error) {
			throw this.#mapMailboxError(error, firstRunId);
		}
	}

	list(input: ListInputV1): ManagerToolResult {
		this.#assertAvailable("list");
		if ("agentIds" in input) {
			const items = input.agentIds.map((agentId) => this.#agentListItem(this.#requireAgent(agentId, "list")));
			return {
				content: renderAgentListContent("direct", items),
				details: { schemaVersion: 1, operation: "list", view: "direct", items },
				isError: false,
			};
		}
		return input.view === "deliveries" ? this.#listDeliveries(input) : this.#listAgents(input);
	}

	async cancel(input: CancelInputV1, signal?: AbortSignal): Promise<ManagerToolResult> {
		this.#assertMutable("cancel", signal);
		const agent = this.#requireAgent(input.agentId, "cancel");
		if (agent.state === "LOST") throw new ManagerOperationError("SUBAGENT_AGENT_LOST", { agentId: agent.agentId });
		if (agent.state === "TERMINATING") {
			throw new ManagerOperationError("SUBAGENT_AGENT_TERMINATING", { agentId: agent.agentId });
		}
		if (!agent.currentRunId) {
			throw new ManagerOperationError("SUBAGENT_RUN_ALREADY_TERMINAL", {
				agentId: agent.agentId,
				runId: input.expectedRunId,
			});
		}
		if (agent.currentRunId !== input.expectedRunId) {
			throw new ManagerOperationError("SUBAGENT_CANCEL_STALE", {
				agentId: agent.agentId,
				currentRunId: agent.currentRunId,
				runId: input.expectedRunId,
			});
		}
		if (agent.state === "CANCELLING" || this.#pendingCancelRunIds.has(input.expectedRunId)) {
			throw new ManagerOperationError("SUBAGENT_CANCEL_ALREADY_REQUESTED", {
				agentId: agent.agentId,
				runId: input.expectedRunId,
			});
		}
		const sidecar = this.#requireConnectedSidecar();
		const opId = opaqueId("op");
		this.#pendingCancelRunIds.add(input.expectedRunId);
		let response: ChildFrame;
		try {
			response = await this.#dispatch(
				sidecar,
				opId,
				"cancel",
				agent.agentId,
				input.expectedRunId,
				{
					type: "CANCEL",
					...sidecar.envelope(),
					opId,
					agentId: agent.agentId,
					runId: input.expectedRunId,
					reason: input.reason,
				},
				signal,
			);
		} catch (error) {
			if (!this.#pendingOperations.has(opId)) this.#pendingCancelRunIds.delete(input.expectedRunId);
			throw error;
		}
		if (response.type !== "CANCEL_ACCEPTED") {
			throw new ManagerOperationError("SUBAGENT_PROTOCOL_MISMATCH", {
				agentId: agent.agentId,
				runId: input.expectedRunId,
			});
		}
		return {
			content: `Cancellation was requested for run ${input.expectedRunId}.`,
			details: {
				schemaVersion: 1,
				operation: "cancel",
				agentId: agent.agentId,
				runId: input.expectedRunId,
				status: "CANCEL_REQUESTED",
				state: "CANCELLING",
			},
			isError: false,
		};
	}

	async kill(input: KillInputV1, signal?: AbortSignal): Promise<ManagerToolResult> {
		this.#assertMutable("kill", signal);
		const agent = this.#requireAgent(input.agentId, "kill");
		if (agent.state === "LOST") throw new ManagerOperationError("SUBAGENT_AGENT_LOST", { agentId: agent.agentId });
		if (agent.state === "TERMINATING") {
			throw new ManagerOperationError("SUBAGENT_AGENT_TERMINATING", { agentId: agent.agentId });
		}
		if (agent.state !== "IDLE") {
			throw new ManagerOperationError(
				"SUBAGENT_KILL_BLOCKED",
				errorMetadata({
					agentId: agent.agentId,
					currentRunId: agent.currentRunId,
				}),
			);
		}
		if (agent.lastRunId !== input.expectedLastRunId) {
			throw new ManagerOperationError(
				"SUBAGENT_KILL_STALE",
				errorMetadata({
					agentId: agent.agentId,
					lastRunId: agent.lastRunId,
				}),
			);
		}
		const sidecar = this.#requireConnectedSidecar();
		const opId = opaqueId("op");
		if (this.#pendingKillAgentIds.has(agent.agentId)) {
			throw new ManagerOperationError("SUBAGENT_AGENT_TERMINATING", { agentId: agent.agentId });
		}
		this.#pendingKillAgentIds.add(agent.agentId);
		let response: ChildFrame;
		try {
			response = await this.#dispatch(
				sidecar,
				opId,
				"kill",
				agent.agentId,
				undefined,
				{
					type: "KILL",
					...sidecar.envelope(),
					opId,
					agentId: agent.agentId,
					lastRunId: input.expectedLastRunId,
				},
				signal,
			);
		} catch (error) {
			if (!this.#pendingOperations.has(opId)) this.#pendingKillAgentIds.delete(agent.agentId);
			throw error;
		}
		if (response.type !== "KILL_ACCEPTED") {
			throw new ManagerOperationError("SUBAGENT_PROTOCOL_MISMATCH", { agentId: agent.agentId });
		}
		return {
			content: `Termination was requested for idle sub-agent ${agent.agentId}.`,
			details: {
				schemaVersion: 1,
				operation: "kill",
				agentId: agent.agentId,
				lastRunId: input.expectedLastRunId,
				status: "KILL_REQUESTED",
				state: "TERMINATING",
			},
			isError: false,
		};
	}

	rollbackWait(toolCallId: string): void {
		this.#mailbox?.rollback(toolCallId);
	}

	async reconcileWait(toolCallId: string, persisted: boolean): Promise<void> {
		await this.#mailbox?.reconcile(toolCallId, persisted);
	}

	pendingPersistenceToolCallIds(): string[] {
		const ids = new Set<string>();
		for (const delivery of this.#mailbox?.listPending() ?? []) {
			if (delivery.state === "AWAITING_PERSISTENCE" && delivery.toolCallId) {
				ids.add(delivery.toolCallId);
			}
		}
		return [...ids];
	}

	parentTransientSnapshot(): ParentTransientSnapshotV1 {
		const agents = [...this.#agents.values()]
			.filter((agent) => !agent.provisional)
			.sort((left, right) => left.sequence - right.sequence)
			.map((agent) => ({
				agentId: agent.agentId,
				state: agent.state,
				...(agent.label === undefined ? {} : { label: agent.label }),
				...(agent.currentRunId === undefined ? {} : { currentRunId: agent.currentRunId }),
				...(agent.lastRunId === undefined ? {} : { lastRunId: agent.lastRunId }),
			}));
		const readyDeliveries = (this.#mailbox?.listPending() ?? [])
			.filter((delivery) => delivery.state === "READY")
			.map((delivery) => ({
				agentId: delivery.agentId,
				runId: delivery.runId,
				deliveryId: delivery.deliveryId,
				sequence: delivery.sequence,
				outcome: delivery.outcome,
			}));
		return { agents, readyDeliveries };
	}

	async shutdown(): Promise<void> {
		if (this.#shuttingDown) return;
		this.#shuttingDown = true;
		this.#mailbox?.shutdown();
		this.#sidecarLaunchController?.abort();
		const launch = this.#sidecarLaunch;
		let sidecar = this.#sidecar;
		if (!sidecar && launch) {
			try {
				sidecar = await launch;
			} catch {
				// Launch cleanup maps its own failure and removes any provisional spool.
			}
			if (this.#sidecarLaunch === launch) this.#sidecarLaunch = undefined;
		}
		this.#mailbox?.shutdown();
		if (sidecar) {
			const shutdownStartedAt = this.#now();
			const cooperativeDeadline = shutdownStartedAt + 2000;
			const finalDeadline = shutdownStartedAt + 4000;
			try {
				await sidecar.requestShutdown(finalDeadline);
				if (!(await sidecar.waitForExit(cooperativeDeadline))) {
					await sidecar.forceCleanup(finalDeadline);
				}
			} catch {
				await sidecar.forceCleanup(finalDeadline).catch(() => undefined);
			}
		}
		if (this.#spoolRoot) {
			await removeSessionSpoolDirectory(this.#spoolRoot).catch(() => undefined);
		}
		this.#sidecar = undefined;
		this.#spoolRoot = undefined;
	}

	async #ensureSidecar(signal?: AbortSignal): Promise<SidecarTransport> {
		if (this.#shuttingDown) throw new ManagerOperationError("SUBAGENT_SHUTTING_DOWN");
		if (this.#recovering) throw new ManagerOperationError("SUBAGENT_WORKER_RECOVERING");
		if (signal?.aborted) throw new ManagerOperationError("SUBAGENT_OPERATION_INVALIDATED");
		if (this.#sidecar) return this.#sidecar;
		let launch = this.#sidecarLaunch;
		if (!launch) {
			launch = this.#launchSidecar();
			this.#sidecarLaunch = launch;
			void launch.then(
				() => {
					if (this.#sidecarLaunch === launch) this.#sidecarLaunch = undefined;
				},
				() => {
					if (this.#sidecarLaunch === launch) this.#sidecarLaunch = undefined;
				},
			);
		}
		const abortError = () => new ManagerOperationError("SUBAGENT_OPERATION_INVALIDATED");
		let onAbort: (() => void) | undefined;
		try {
			const sidecar = signal
				? await Promise.race([
						launch,
						new Promise<SidecarTransport>((_, reject) => {
							onAbort = () => reject(abortError());
							signal.addEventListener("abort", onAbort, { once: true });
							if (signal.aborted) reject(abortError());
						}),
					])
				: await launch;
			if (this.#shuttingDown) throw new ManagerOperationError("SUBAGENT_SHUTTING_DOWN");
			if (signal?.aborted) throw new ManagerOperationError("SUBAGENT_OPERATION_INVALIDATED");
			return sidecar;
		} finally {
			if (signal && onAbort) signal.removeEventListener("abort", onAbort);
		}
	}

	async #launchSidecar(): Promise<SidecarTransport> {
		if (process.platform === "win32") throw new ManagerOperationError("SUBAGENT_UNSUPPORTED_PLATFORM");
		const launchController = new AbortController();
		this.#sidecarLaunchController = launchController;
		try {
			this.#spoolRoot ??= await (this.#options.createSpoolRoot ?? createSessionSpoolDirectory)();
			if (launchController.signal.aborted) throw new ManagerOperationError("SUBAGENT_SHUTTING_DOWN");
			this.#mailbox ??= new Mailbox({
				spoolRoot: this.#spoolRoot,
				observeRunState: (runId) =>
					this.#agents.get(this.#runs.get(runId)?.agentId ?? "")?.state === "CANCELLING" ? "CANCELLING" : "RUNNING",
				onIntegrityFailure: async () => this.#beginIntegrityCleanup(),
				now: this.#now,
			});
			this.#workerGeneration++;
			const identity = {
				sessionNonce: this.sessionNonce,
				managerEpoch: this.managerEpoch,
				workerGeneration: this.#workerGeneration,
			};
			const bootstrap: BootstrapFrame = {
				type: "BOOTSTRAP",
				protocolVersion: 1,
				...identity,
				parentPid: process.pid,
				cwd: this.#options.cwd,
				agentDir: this.#options.agentDir,
				piPackageDir: this.#options.piPackageDir,
				spoolDir: this.#spoolRoot,
				selfExtensionPath: this.#options.selfExtensionPath,
				settingsSnapshot: this.#options.settingsSnapshot,
				projectTrusted: this.#options.projectTrusted,
			};
			const launch = this.#options.launchSidecar ?? ((options) => SidecarClient.launch(options));
			const sidecar = await launch({ identity, bootstrap, signal: launchController.signal });
			this.#sidecar = sidecar;
			sidecar.onFrame(async (frame) => this.#handleFrame(frame));
			sidecar.onExit(async () => this.#handleSidecarExit(sidecar));
			return sidecar;
		} catch (error) {
			this.#sidecar = undefined;
			const failedSpoolRoot = this.#spoolRoot;
			this.#mailbox = undefined;
			this.#spoolRoot = undefined;
			if (failedSpoolRoot) {
				await removeSessionSpoolDirectory(failedSpoolRoot).catch(() => undefined);
			}
			if (this.#shuttingDown) throw new ManagerOperationError("SUBAGENT_SHUTTING_DOWN");
			const message = error instanceof Error ? error.message : "";
			if (message.includes("ENOENT")) throw new ManagerOperationError("SUBAGENT_RUNTIME_NOT_BUILT");
			if (message.includes("SUBAGENT_CONTROL_MESSAGE_TOO_LARGE")) {
				throw new ManagerOperationError("SUBAGENT_SESSION_SNAPSHOT_TOO_LARGE");
			}
			if (message.includes("SUBAGENT_PROTOCOL_MISMATCH")) {
				throw new ManagerOperationError("SUBAGENT_PROTOCOL_MISMATCH");
			}
			throw new ManagerOperationError("SUBAGENT_WORKER_START_FAILED");
		} finally {
			if (this.#sidecarLaunchController === launchController) this.#sidecarLaunchController = undefined;
		}
	}

	async #dispatch(
		sidecar: SidecarTransport,
		opId: string,
		kind: OperationKind,
		agentId: string,
		runId: string | undefined,
		frame: ParentFrame,
		signal?: AbortSignal,
	): Promise<ChildFrame> {
		if (signal?.aborted) {
			throw new ManagerOperationError("SUBAGENT_OPERATION_INVALIDATED", errorMetadata({ agentId, runId }));
		}
		let resolveOperation!: (response: ChildFrame) => void;
		let rejectOperation!: (error: Error) => void;
		const response = new Promise<ChildFrame>((resolve, reject) => {
			resolveOperation = resolve;
			rejectOperation = reject;
		});
		this.#pendingOperations.set(opId, {
			opId,
			kind,
			agentId,
			runId,
			resolve: resolveOperation,
			reject: rejectOperation,
		});
		try {
			await sidecar.send(frame);
		} catch {
			this.#pendingOperations.delete(opId);
			await this.#beginIntegrityCleanup();
			throw new ManagerOperationError(
				kind === "spawn" || kind === "send" ? "SUBAGENT_START_UNCERTAIN" : "SUBAGENT_IPC_LOST",
				errorMetadata({ agentId, runId }),
			);
		}
		if (!signal) return await response;
		const abortError = () =>
			new ManagerOperationError(
				kind === "spawn" || kind === "send" ? "SUBAGENT_START_UNCERTAIN" : "SUBAGENT_IPC_LOST",
				errorMetadata({ agentId, runId }),
			);
		if (signal.aborted) throw abortError();
		let rejectForAbort: ((error: Error) => void) | undefined;
		const aborted = new Promise<ChildFrame>((_, reject) => {
			rejectForAbort = reject;
		});
		const onAbort = () => rejectForAbort?.(abortError());
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			if (signal.aborted) throw abortError();
			return await Promise.race([response, aborted]);
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
	}

	async #handleFrame(frame: ChildFrame): Promise<void> {
		if (frame.workerGeneration !== this.#workerGeneration) return;
		if (frame.type === "RUN_ACCEPTED") {
			const operation = this.#pendingOperations.get(frame.opId);
			if (
				!operation ||
				operation.kind !== frame.operation ||
				operation.agentId !== frame.agentId ||
				operation.runId !== frame.runId
			) {
				await this.#beginIntegrityCleanup();
				return;
			}
			const agent = this.#agents.get(frame.agentId);
			const run = this.#runs.get(frame.runId);
			if (!agent || !run) return;
			run.accepted = true;
			agent.provisional = false;
			agent.state = "RUNNING";
			agent.currentRunId = frame.runId;
			agent.lastRunId = frame.runId;
			this.#reservedAgentIds.delete(agent.agentId);
			agent.activeToolCount = frame.activeToolCount;
			agent.capabilityToolCount = frame.capabilityToolCount;
			agent.degradedExtensions = frame.degradedExtensions.map((item) => ({ ...item }));
			agent.unavailableTools = frame.unavailableTools.map((item) => ({ ...item }));
			this.#pendingOperations.delete(frame.opId);
			operation.resolve(frame);
			return;
		}
		if (frame.type === "OP_NACK") {
			const operation = this.#pendingOperations.get(frame.opId);
			if (!operation) return;
			if (operation.kind !== frame.operation) {
				await this.#beginIntegrityCleanup();
				return;
			}
			this.#pendingOperations.delete(frame.opId);
			if (operation.kind === "spawn" && operation.runId) {
				this.#discardProvisional(operation.agentId, operation.runId);
			} else if (operation.kind === "send" && operation.runId) {
				this.#discardPreparedSend(operation.agentId, operation.runId);
			} else if (operation.kind === "cancel" && operation.runId) {
				this.#pendingCancelRunIds.delete(operation.runId);
			} else if (operation.kind === "kill") {
				this.#pendingKillAgentIds.delete(operation.agentId);
			}
			operation.reject(
				new ManagerOperationError(
					frame.code,
					errorMetadata({
						agentId: frame.agentId ?? operation.agentId,
						runId: frame.runId ?? operation.runId,
						currentRunId: frame.currentRunId,
						lastRunId: frame.lastRunId,
					}),
				),
			);
			return;
		}
		if (frame.type === "CANCEL_ACCEPTED") {
			const operation = this.#pendingOperations.get(frame.opId);
			const agent = this.#agents.get(frame.agentId);
			const run = this.#runs.get(frame.runId);
			if (operation?.kind !== "cancel" || !agent || !run || operation.runId !== frame.runId) {
				await this.#beginIntegrityCleanup();
				return;
			}
			run.cancelCommitted = true;
			agent.state = "CANCELLING";
			this.#pendingCancelRunIds.delete(frame.runId);
			this.#pendingOperations.delete(frame.opId);
			operation.resolve(frame);
			return;
		}
		if (frame.type === "KILL_ACCEPTED") {
			const operation = this.#pendingOperations.get(frame.opId);
			const agent = this.#agents.get(frame.agentId);
			if (operation?.kind !== "kill" || !agent || agent.lastRunId !== frame.lastRunId) {
				await this.#beginIntegrityCleanup();
				return;
			}
			agent.state = "TERMINATING";
			this.#pendingKillAgentIds.delete(frame.agentId);
			this.#acceptedKills.set(frame.agentId, {
				opId: frame.opId,
				lastRunId: frame.lastRunId,
				workerGeneration: frame.workerGeneration,
			});
			this.#pendingOperations.delete(frame.opId);
			operation.resolve(frame);
			return;
		}
		if (frame.type === "KILL_SETTLED") {
			const accepted = this.#acceptedKills.get(frame.agentId);
			if (
				!accepted ||
				accepted.opId !== frame.opId ||
				accepted.lastRunId !== frame.lastRunId ||
				accepted.workerGeneration !== frame.workerGeneration
			) {
				await this.#beginIntegrityCleanup();
				return;
			}
			this.#acceptedKills.delete(frame.agentId);
			this.#agents.delete(frame.agentId);
			return;
		}
		if (frame.type === "RUN_TERMINAL") {
			await this.#commitTerminal(frame);
			return;
		}
		if (frame.type === "RUN_SETTLED") {
			const run = this.#runs.get(frame.runId);
			const agent = this.#agents.get(frame.agentId);
			if (
				!run ||
				!agent ||
				run.deliveryId !== frame.deliveryId ||
				run.terminalOpId !== frame.terminalOpId ||
				!run.terminalCommitted ||
				run.settled
			) {
				return;
			}
			run.settled = true;
			this.#runningSlots = Math.max(0, this.#runningSlots - 1);
			if (agent.state !== "TERMINATING" && agent.state !== "LOST") {
				agent.state = "IDLE";
				agent.currentRunId = undefined;
			}
			return;
		}
		if (frame.type === "AGENT_TOOL_STATE") {
			const agent = this.#agents.get(frame.agentId);
			if (agent) {
				agent.activeToolCount = frame.activeToolCount;
				agent.capabilityToolCount = frame.capabilityToolCount;
			}
			return;
		}
		if (frame.type === "WORKER_EXITED") {
			this.#recovering = true;
			for (const agent of this.#agents.values()) {
				if (agent.workerGeneration === frame.workerGeneration && agent.state !== "LOST") {
					agent.state = "TERMINATING";
				}
			}
			return;
		}
		if (frame.type === "LOSS_CLEANED") {
			await this.#finalizeGenerationLoss(frame.workerGeneration);
			return;
		}
		if (frame.type === "PROTOCOL_ERROR") {
			await this.#beginIntegrityCleanup();
		}
	}

	async #commitTerminal(frame: RunTerminalFrame): Promise<void> {
		const run = this.#runs.get(frame.runId);
		const agent = this.#agents.get(frame.agentId);
		const mailbox = this.#mailbox;
		const sidecar = this.#sidecar;
		if (
			!run ||
			!agent ||
			!mailbox ||
			!sidecar ||
			run.agentId !== frame.agentId ||
			run.deliveryId !== frame.deliveryId ||
			run.workerGeneration !== frame.workerGeneration
		) {
			await this.#beginIntegrityCleanup();
			return;
		}
		if (run.terminalCommitted && run.terminalOpId !== frame.terminalOpId) {
			await this.#beginIntegrityCleanup();
			return;
		}
		if (!run.terminalCommitted && frame.outcome === "RESULT") {
			try {
				if (!this.#spoolRoot) throw new Error("Missing spool root.");
				await verifyResultSpoolCommit(this.#spoolRoot, frame.deliveryId, frame.spool);
			} catch {
				mailbox.commitTerminal({
					deliveryId: frame.deliveryId,
					agentId: frame.agentId,
					runId: frame.runId,
					completedAt: this.#now(),
					workerGeneration: frame.workerGeneration,
					outcome: "FAILED",
					failureCode: "SUBAGENT_DELIVERY_INTEGRITY_FAILED",
				});
				run.terminalCommitted = true;
				run.terminalOpId = frame.terminalOpId;
				await this.#beginIntegrityCleanup();
				return;
			}
		}
		if (!run.terminalCommitted) {
			const outcome = run.cancelCommitted ? "CANCELLED" : frame.outcome;
			mailbox.commitTerminal({
				deliveryId: frame.deliveryId,
				agentId: frame.agentId,
				runId: frame.runId,
				completedAt: frame.completedAt,
				workerGeneration: frame.workerGeneration,
				outcome,
				...(outcome === "RESULT" && frame.outcome === "RESULT" ? { spool: frame.spool } : {}),
				...(outcome === "FAILED" && frame.outcome === "FAILED" ? { failureCode: frame.failureCode } : {}),
				...(outcome === "CANCELLED"
					? {
							cancelReason:
								frame.outcome === "CANCELLED" ? frame.cancelReason : "Cancellation was requested by the parent.",
						}
					: {}),
			});
			run.terminalCommitted = true;
			run.terminalOpId = frame.terminalOpId;
		}
		await sidecar.send({
			type: "MAILBOX_COMMIT_ACK",
			...sidecar.envelope(),
			terminalOpId: frame.terminalOpId,
			agentId: frame.agentId,
			runId: frame.runId,
			deliveryId: frame.deliveryId,
		});
	}

	async #beginIntegrityCleanup(): Promise<void> {
		if (this.#recovering) return;
		this.#recovering = true;
		const generation = this.#workerGeneration;
		for (const agent of this.#agents.values()) {
			if (agent.workerGeneration === generation && agent.state !== "LOST") {
				agent.state = "TERMINATING";
			}
		}
		const sidecar = this.#sidecar;
		if (sidecar) await sidecar.forceCleanup(this.#now() + 2000).catch(() => undefined);
		await this.#finalizeGenerationLoss(generation);
	}

	async #handleSidecarExit(sidecar: SidecarTransport): Promise<void> {
		if (this.#sidecar !== sidecar || this.#shuttingDown) return;
		this.#recovering = true;
		await sidecar.forceCleanup(this.#now() + 2000).catch(() => undefined);
		await this.#finalizeGenerationLoss(this.#workerGeneration);
	}

	async #finalizeGenerationLoss(generation: number): Promise<void> {
		const mailbox = this.#mailbox;
		for (const run of this.#runs.values()) {
			if (run.workerGeneration !== generation || run.settled) continue;
			if (!run.terminalCommitted && mailbox) {
				mailbox.commitTerminal({
					deliveryId: run.deliveryId,
					agentId: run.agentId,
					runId: run.runId,
					completedAt: this.#now(),
					workerGeneration: generation,
					outcome: "LOST",
				});
				run.terminalCommitted = true;
			}
			run.settled = true;
		}
		for (const agent of this.#agents.values()) {
			if (agent.workerGeneration !== generation) continue;
			agent.state = "LOST";
			agent.currentRunId = undefined;
			agent.provisional = false;
		}
		for (const operation of this.#pendingOperations.values()) {
			operation.reject(
				new ManagerOperationError(
					operation.kind === "spawn" || operation.kind === "send" ? "SUBAGENT_START_UNCERTAIN" : "SUBAGENT_IPC_LOST",
					errorMetadata({ agentId: operation.agentId, runId: operation.runId }),
				),
			);
		}
		this.#pendingOperations.clear();
		this.#reservedAgentIds.clear();
		this.#pendingCancelRunIds.clear();
		this.#pendingKillAgentIds.clear();
		this.#acceptedKills.clear();
		this.#runningSlots = 0;
		this.#sidecar = undefined;
		this.#recovering = false;
		if (this.#spoolRoot && mailbox) {
			await cleanupOrphanSpools(this.#spoolRoot, mailbox.retainedSpoolBasenames()).catch(() => undefined);
		}
	}

	#discardProvisional(agentId: string, runId: string): void {
		const agent = this.#agents.get(agentId);
		const run = this.#runs.get(runId);
		if (agent?.provisional) this.#agents.delete(agentId);
		if (run && !run.accepted) {
			this.#runs.delete(runId);
			this.#runningSlots = Math.max(0, this.#runningSlots - 1);
		}
	}

	#discardPreparedSend(agentId: string, runId: string): void {
		this.#reservedAgentIds.delete(agentId);
		const run = this.#runs.get(runId);
		if (run && !run.accepted) {
			this.#runs.delete(runId);
			this.#runningSlots = Math.max(0, this.#runningSlots - 1);
		}
	}

	#requireAgent(agentId: string, _operation: "send" | "list" | "cancel" | "kill"): AgentRecord {
		const agent = this.#agents.get(agentId);
		if (!agent || agent.provisional) throw new ManagerOperationError("SUBAGENT_AGENT_NOT_FOUND", { agentId });
		return agent;
	}

	#requireMailbox(): Mailbox {
		if (!this.#mailbox) throw new ManagerOperationError("SUBAGENT_RUN_NOT_FOUND");
		return this.#mailbox;
	}

	#requireConnectedSidecar(): SidecarTransport {
		if (!this.#sidecar) throw new ManagerOperationError("SUBAGENT_IPC_LOST");
		return this.#sidecar;
	}

	#assertAvailable(_operation: "wait" | "list"): void {
		if (this.#shuttingDown) throw new ManagerOperationError("SUBAGENT_SHUTTING_DOWN");
	}

	#assertMutable(_operation: "spawn" | "send" | "cancel" | "kill", signal?: AbortSignal): void {
		if (this.#shuttingDown) throw new ManagerOperationError("SUBAGENT_SHUTTING_DOWN");
		if (signal?.aborted) throw new ManagerOperationError("SUBAGENT_OPERATION_INVALIDATED");
	}

	#mapMailboxError(error: unknown, runId: string): Error {
		if (!(error instanceof MailboxError)) return error instanceof Error ? error : new Error(String(error));
		if (error.code === "SUBAGENT_RUN_UNKNOWN") {
			return new ManagerOperationError("SUBAGENT_RUN_NOT_FOUND", { runId });
		}
		return new ManagerOperationError(error.code, { runId });
	}

	#agentListItem(agent: AgentRecord): AgentListItemV1 {
		return {
			agentId: agent.agentId,
			...(agent.label === undefined ? {} : { label: agent.label }),
			state: agent.state,
			...(agent.currentRunId === undefined ? {} : { currentRunId: agent.currentRunId }),
			...(agent.lastRunId === undefined ? {} : { lastRunId: agent.lastRunId }),
			model: { ...agent.model },
			thinkingLevel: agent.thinkingLevel,
			activeToolCount: agent.activeToolCount,
			capabilityToolCount: agent.capabilityToolCount,
			readyDeliveryCount: this.#mailbox?.readyCountForAgent(agent.agentId) ?? 0,
			degradedExtensions: agent.degradedExtensions.map((item) => item.path),
			unavailableToolCount: agent.unavailableTools.length,
			workerGeneration: agent.workerGeneration,
		};
	}

	#listAgents(input: Extract<ListInputV1, { view: "agents" }>): ManagerToolResult {
		const normalizedStates = [...(input.states ?? ["IDLE", "RUNNING", "CANCELLING", "TERMINATING", "LOST"])].sort();
		const cursor = input.cursor ? parseCursor(input.cursor, this.sessionNonce) : undefined;
		const highWater = cursor?.highWater ?? Math.max(-1, this.#nextAgentSequence - 1);
		const lastSequence = cursor?.lastSequence ?? -1;
		if (
			input.cursor &&
			(!cursor ||
				cursor.epoch !== this.managerEpoch ||
				cursor.view !== "agents" ||
				JSON.stringify(cursor.states) !== JSON.stringify(normalizedStates))
		) {
			throw new ManagerOperationError("SUBAGENT_CURSOR_STALE");
		}
		const candidates = [...this.#agents.values()]
			.filter((agent) => agent.sequence <= highWater && agent.sequence > lastSequence)
			.sort((left, right) => left.sequence - right.sequence);
		const page: AgentRecord[] = [];
		let scannedSequence = lastSequence;
		let scannedCount = 0;
		for (const agent of candidates) {
			scannedSequence = agent.sequence;
			scannedCount++;
			if (!agent.provisional && normalizedStates.includes(agent.state)) page.push(agent);
			if (page.length === input.limit) break;
		}
		const hasMore = candidates.length > scannedCount;
		const nextCursor = hasMore
			? serializeCursor(
					{
						version: 1,
						epoch: this.managerEpoch,
						view: "agents",
						highWater,
						lastSequence: scannedSequence,
						states: normalizedStates,
					},
					this.sessionNonce,
				)
			: undefined;
		const items = page.map((agent) => this.#agentListItem(agent));
		return {
			content: renderAgentListContent("agents", items, nextCursor),
			details: {
				schemaVersion: 1,
				operation: "list",
				view: "agents",
				items,
				...(nextCursor === undefined ? {} : { nextCursor }),
			},
			isError: false,
		};
	}

	#listDeliveries(input: Extract<ListInputV1, { view: "deliveries" }>): ManagerToolResult {
		const normalizedStates = [...(input.states ?? ["READY", "CLAIMED", "AWAITING_PERSISTENCE"])].sort();
		const cursor = input.cursor ? parseCursor(input.cursor, this.sessionNonce) : undefined;
		const allDeliveries = this.#mailbox?.listAll() ?? [];
		const highWater = cursor?.highWater ?? Math.max(-1, ...allDeliveries.map((item) => item.sequence));
		const lastSequence = cursor?.lastSequence ?? -1;
		if (
			input.cursor &&
			(!cursor ||
				cursor.epoch !== this.managerEpoch ||
				cursor.view !== "deliveries" ||
				JSON.stringify(cursor.states) !== JSON.stringify(normalizedStates))
		) {
			throw new ManagerOperationError("SUBAGENT_CURSOR_STALE");
		}
		const candidates = allDeliveries.filter((item) => item.sequence <= highWater && item.sequence > lastSequence);
		const page: DeliveryRecord[] = [];
		let scannedSequence = lastSequence;
		let scannedCount = 0;
		for (const item of candidates) {
			scannedSequence = item.sequence;
			scannedCount++;
			if (item.state !== "DELIVERED" && normalizedStates.includes(item.state)) page.push(item);
			if (page.length === input.limit) break;
		}
		const hasMore = candidates.length > scannedCount;
		const nextCursor = hasMore
			? serializeCursor(
					{
						version: 1,
						epoch: this.managerEpoch,
						view: "deliveries",
						highWater,
						lastSequence: scannedSequence,
						states: normalizedStates,
					},
					this.sessionNonce,
				)
			: undefined;
		const items: DeliveryListItemV1[] = page.map((record) => ({
			...deliveryResult(record),
			state: record.state as DeliveryListItemV1["state"],
		}));
		return {
			content: renderDeliveryListContent(items, nextCursor),
			details: {
				schemaVersion: 1,
				operation: "list",
				view: "deliveries",
				items,
				...(nextCursor === undefined ? {} : { nextCursor }),
			},
			isError: false,
		};
	}
}

export async function canonicalizeCandidateExtensionPaths(
	paths: readonly string[],
	selfExtensionPath: string,
): Promise<string[]> {
	const self = await realpath(selfExtensionPath);
	const canonical = new Set<string>();
	for (const path of paths) {
		try {
			const candidate = await realpath(path);
			if (candidate !== self) canonical.add(candidate);
		} catch {
			// The Worker reports optional candidate failures using stable diagnostics.
		}
	}
	return [...canonical].sort();
}
