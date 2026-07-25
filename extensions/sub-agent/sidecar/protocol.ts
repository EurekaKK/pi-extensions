export const SUBAGENT_PROTOCOL_VERSION = 1 as const;
export const MAX_CONTROL_MESSAGE_BYTES = 1024 * 1024;

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type ThinkingLevelV1 = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type DeliveryOutcomeV1 = "RESULT" | "FAILED" | "CANCELLED" | "LOST";
export type RunFailureCodeV1 =
	| "SUBAGENT_MODEL_RUN_FAILED"
	| "SUBAGENT_RUN_ABORTED"
	| "SUBAGENT_OUTPUT_TRUNCATED"
	| "SUBAGENT_INCOMPLETE_TOOL_TURN"
	| "SUBAGENT_EMPTY_RESULT"
	| "SUBAGENT_OUTPUT_TOO_LARGE"
	| "SUBAGENT_DELIVERY_STORAGE_FAILED"
	| "SUBAGENT_DELIVERY_INTEGRITY_FAILED"
	| "SUBAGENT_COMPACTION_FAILED";

export type DegradedExtensionCodeV1 =
	| "factory_failed"
	| "loader_failed"
	| "provider_registration_failed"
	| "session_start_failed"
	| "resources_discover_failed"
	| "run_admission_gate_failed";

export type UnavailableToolReasonV1 = "unlocatable" | "extension_failed" | "not_registered";

export interface ProtocolEnvelope {
	protocolVersion: typeof SUBAGENT_PROTOCOL_VERSION;
	sessionNonce: string;
	managerEpoch: string;
	workerGeneration: number;
}

export interface BootstrapFrame extends ProtocolEnvelope {
	type: "BOOTSTRAP";
	parentPid: number;
	cwd: string;
	agentDir: string;
	piPackageDir: string;
	spoolDir: string;
	selfExtensionPath: string;
	settingsSnapshot: JsonObject;
	projectTrusted: boolean;
}

export interface ChildModelSelection {
	provider: string;
	id: string;
}

export interface FrozenProjectContextFile {
	path: string;
	content: string;
}

export interface ParentToolSource {
	name: string;
	path?: string;
}

export interface SpawnFrame extends ProtocolEnvelope {
	type: "SPAWN";
	opId: string;
	agentId: string;
	runId: string;
	deliveryId: string;
	task: string;
	model: ChildModelSelection;
	thinkingLevel: ThinkingLevelV1;
	projectContext: FrozenProjectContextFile[];
	candidateExtensionPaths: string[];
	requiredExtensionPaths: string[];
	parentToolNames: string[];
	parentToolSources: ParentToolSource[];
	parentActiveToolNames: string[];
	explicitTools?: string[];
}

export interface SendFrame extends ProtocolEnvelope {
	type: "SEND";
	opId: string;
	agentId: string;
	runId: string;
	deliveryId: string;
	message: string;
}

export interface CancelFrame extends ProtocolEnvelope {
	type: "CANCEL";
	opId: string;
	agentId: string;
	runId: string;
	reason: string;
}

export interface KillFrame extends ProtocolEnvelope {
	type: "KILL";
	opId: string;
	agentId: string;
	lastRunId: string;
}

export interface MailboxCommitAckFrame extends ProtocolEnvelope {
	type: "MAILBOX_COMMIT_ACK";
	terminalOpId: string;
	agentId: string;
	runId: string;
	deliveryId: string;
}

export interface ShutdownFrame extends ProtocolEnvelope {
	type: "SHUTDOWN";
	deadlineAt: number;
}

export type ParentFrame =
	| BootstrapFrame
	| SpawnFrame
	| SendFrame
	| CancelFrame
	| KillFrame
	| MailboxCommitAckFrame
	| ShutdownFrame;

export interface GuardianReadyFrame extends ProtocolEnvelope {
	type: "GUARDIAN_READY";
	guardianPid: number;
	workerPid: number;
	workerPgid: number;
}

export interface WorkerReadyFrame extends ProtocolEnvelope {
	type: "WORKER_READY";
	workerPid: number;
	workerPgid: number;
	piVersion: string;
}

export interface DegradedExtensionV1 {
	path: string;
	code: DegradedExtensionCodeV1;
}

export interface UnavailableToolV1 {
	name: string;
	reason: UnavailableToolReasonV1;
}

export interface RunAcceptedFrame extends ProtocolEnvelope {
	type: "RUN_ACCEPTED";
	opId: string;
	operation: "spawn" | "send";
	agentId: string;
	runId: string;
	model: ChildModelSelection;
	thinkingLevel: ThinkingLevelV1;
	activeToolCount: number;
	capabilityToolCount: number;
	degradedExtensions: DegradedExtensionV1[];
	unavailableTools: UnavailableToolV1[];
}

export type WorkerOperationErrorCode =
	| "SUBAGENT_INPUT_HANDLED"
	| "SUBAGENT_RUN_START_FAILED"
	| "SUBAGENT_REQUIRED_EXTENSION_FAILED"
	| "SUBAGENT_EXPLICIT_TOOL_MISSING"
	| "SUBAGENT_TOOL_FORBIDDEN"
	| "SUBAGENT_EXTENSION_REHYDRATION_UNSTABLE"
	| "SUBAGENT_MODEL_NOT_FOUND"
	| "SUBAGENT_MODEL_AUTH_REQUIRED"
	| "SUBAGENT_THINKING_UNSUPPORTED"
	| "SUBAGENT_PI_API_UNSUPPORTED"
	| "SUBAGENT_PROTOCOL_MISMATCH"
	| "SUBAGENT_AGENT_NOT_FOUND"
	| "SUBAGENT_AGENT_TERMINATING"
	| "SUBAGENT_AGENT_LOST"
	| "SUBAGENT_BUSY"
	| "SUBAGENT_RUN_ALREADY_TERMINAL"
	| "SUBAGENT_CANCEL_STALE"
	| "SUBAGENT_CANCEL_ALREADY_REQUESTED"
	| "SUBAGENT_KILL_BLOCKED"
	| "SUBAGENT_KILL_STALE"
	| "SUBAGENT_IPC_LOST";

export interface OperationNackFrame extends ProtocolEnvelope {
	type: "OP_NACK";
	opId: string;
	operation: "spawn" | "send" | "cancel" | "kill";
	code: WorkerOperationErrorCode;
	agentId?: string;
	runId?: string;
	currentRunId?: string;
	lastRunId?: string;
	message: string;
}

export interface CancelAcceptedFrame extends ProtocolEnvelope {
	type: "CANCEL_ACCEPTED";
	opId: string;
	agentId: string;
	runId: string;
}

export interface KillAcceptedFrame extends ProtocolEnvelope {
	type: "KILL_ACCEPTED";
	opId: string;
	agentId: string;
	lastRunId: string;
}

export interface KillSettledFrame extends ProtocolEnvelope {
	type: "KILL_SETTLED";
	opId: string;
	agentId: string;
	lastRunId: string;
}

export interface ResultSpoolMetadata {
	basename: string;
	byteSize: number;
	digest: string;
}

interface RunTerminalBaseFrame extends ProtocolEnvelope {
	type: "RUN_TERMINAL";
	terminalOpId: string;
	agentId: string;
	runId: string;
	deliveryId: string;
	completedAt: number;
}

export type RunTerminalFrame =
	| (RunTerminalBaseFrame & {
			outcome: "RESULT";
			spool: ResultSpoolMetadata;
	  })
	| (RunTerminalBaseFrame & {
			outcome: "FAILED";
			failureCode: RunFailureCodeV1;
	  })
	| (RunTerminalBaseFrame & {
			outcome: "CANCELLED";
			cancelReason: string;
	  });

export interface RunSettledFrame extends ProtocolEnvelope {
	type: "RUN_SETTLED";
	terminalOpId: string;
	agentId: string;
	runId: string;
	deliveryId: string;
}

export interface AgentToolStateFrame extends ProtocolEnvelope {
	type: "AGENT_TOOL_STATE";
	agentId: string;
	activeToolCount: number;
	capabilityToolCount: number;
}

export interface WorkerWarningFrame extends ProtocolEnvelope {
	type: "WORKER_WARNING";
	code: string;
	agentId?: string;
	runId?: string;
}

export interface WorkerExitedFrame extends ProtocolEnvelope {
	type: "WORKER_EXITED";
	exitCode: number | null;
	signal: string | null;
}

export interface LossCleanedFrame extends ProtocolEnvelope {
	type: "LOSS_CLEANED";
	workerPid: number;
	workerPgid: number;
}

export interface ShutdownCompleteFrame extends ProtocolEnvelope {
	type: "SHUTDOWN_COMPLETE";
}

export interface ProtocolErrorFrame extends ProtocolEnvelope {
	type: "PROTOCOL_ERROR";
	code: "SUBAGENT_PROTOCOL_MISMATCH" | "SUBAGENT_PI_API_UNSUPPORTED";
}

export type ChildFrame =
	| GuardianReadyFrame
	| WorkerReadyFrame
	| RunAcceptedFrame
	| OperationNackFrame
	| CancelAcceptedFrame
	| KillAcceptedFrame
	| KillSettledFrame
	| RunTerminalFrame
	| RunSettledFrame
	| AgentToolStateFrame
	| WorkerWarningFrame
	| WorkerExitedFrame
	| LossCleanedFrame
	| ShutdownCompleteFrame
	| ProtocolErrorFrame;

const PARENT_FRAME_TYPES = new Set<ParentFrame["type"]>([
	"BOOTSTRAP",
	"SPAWN",
	"SEND",
	"CANCEL",
	"KILL",
	"MAILBOX_COMMIT_ACK",
	"SHUTDOWN",
]);

const CHILD_FRAME_TYPES = new Set<ChildFrame["type"]>([
	"GUARDIAN_READY",
	"WORKER_READY",
	"RUN_ACCEPTED",
	"OP_NACK",
	"CANCEL_ACCEPTED",
	"KILL_ACCEPTED",
	"KILL_SETTLED",
	"RUN_TERMINAL",
	"RUN_SETTLED",
	"AGENT_TOOL_STATE",
	"WORKER_WARNING",
	"WORKER_EXITED",
	"LOSS_CLEANED",
	"SHUTDOWN_COMPLETE",
	"PROTOCOL_ERROR",
]);

const THINKING_LEVELS = new Set<ThinkingLevelV1>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const FAILURE_CODES = new Set<RunFailureCodeV1>([
	"SUBAGENT_MODEL_RUN_FAILED",
	"SUBAGENT_RUN_ABORTED",
	"SUBAGENT_OUTPUT_TRUNCATED",
	"SUBAGENT_INCOMPLETE_TOOL_TURN",
	"SUBAGENT_EMPTY_RESULT",
	"SUBAGENT_OUTPUT_TOO_LARGE",
	"SUBAGENT_DELIVERY_STORAGE_FAILED",
	"SUBAGENT_DELIVERY_INTEGRITY_FAILED",
	"SUBAGENT_COMPACTION_FAILED",
]);
const DEGRADED_CODES = new Set<DegradedExtensionCodeV1>([
	"factory_failed",
	"loader_failed",
	"provider_registration_failed",
	"session_start_failed",
	"resources_discover_failed",
	"run_admission_gate_failed",
]);
const UNAVAILABLE_REASONS = new Set<UnavailableToolReasonV1>(["unlocatable", "extension_failed", "not_registered"]);
const OPERATION_ERROR_CODES = new Set<WorkerOperationErrorCode>([
	"SUBAGENT_INPUT_HANDLED",
	"SUBAGENT_RUN_START_FAILED",
	"SUBAGENT_REQUIRED_EXTENSION_FAILED",
	"SUBAGENT_EXPLICIT_TOOL_MISSING",
	"SUBAGENT_TOOL_FORBIDDEN",
	"SUBAGENT_EXTENSION_REHYDRATION_UNSTABLE",
	"SUBAGENT_MODEL_NOT_FOUND",
	"SUBAGENT_MODEL_AUTH_REQUIRED",
	"SUBAGENT_THINKING_UNSUPPORTED",
	"SUBAGENT_PI_API_UNSUPPORTED",
	"SUBAGENT_PROTOCOL_MISMATCH",
	"SUBAGENT_AGENT_NOT_FOUND",
	"SUBAGENT_AGENT_TERMINATING",
	"SUBAGENT_AGENT_LOST",
	"SUBAGENT_BUSY",
	"SUBAGENT_RUN_ALREADY_TERMINAL",
	"SUBAGENT_CANCEL_STALE",
	"SUBAGENT_CANCEL_ALREADY_REQUESTED",
	"SUBAGENT_KILL_BLOCKED",
	"SUBAGENT_KILL_STALE",
	"SUBAGENT_IPC_LOST",
]);

const ENVELOPE_KEYS = ["protocolVersion", "sessionNonce", "managerEpoch", "workerGeneration", "type"] as const;

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
	return isSafeNonNegativeInteger(value) && value > 0;
}

function hasExactKeys(
	value: Record<string, unknown>,
	required: readonly string[],
	optional: readonly string[] = [],
): boolean {
	const allowed = new Set([...ENVELOPE_KEYS, ...required, ...optional]);
	for (const key of [...ENVELOPE_KEYS, ...required]) {
		if (!Object.hasOwn(value, key)) return false;
	}
	return Object.keys(value).every((key) => allowed.has(key));
}

function isStringArray(value: unknown, allowEmpty = true): value is string[] {
	return Array.isArray(value) && (allowEmpty || value.length > 0) && value.every((entry) => isNonEmptyString(entry));
}

function isJsonValue(value: unknown): value is JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJsonValue);
	if (!isPlainRecord(value)) return false;
	return Object.values(value).every(isJsonValue);
}

function isModel(value: unknown): value is ChildModelSelection {
	return (
		isPlainRecord(value) &&
		hasOnlyObjectKeys(value, ["provider", "id"]) &&
		isNonEmptyString(value.provider) &&
		isNonEmptyString(value.id)
	);
}

function hasOnlyObjectKeys(
	value: Record<string, unknown>,
	required: readonly string[],
	optional: readonly string[] = [],
): boolean {
	const allowed = new Set([...required, ...optional]);
	return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}

function isProjectContext(value: unknown): value is FrozenProjectContextFile[] {
	return (
		Array.isArray(value) &&
		value.every(
			(entry) =>
				isPlainRecord(entry) &&
				hasOnlyObjectKeys(entry, ["path", "content"]) &&
				isNonEmptyString(entry.path) &&
				typeof entry.content === "string",
		)
	);
}

function isParentToolSources(value: unknown): value is ParentToolSource[] {
	return (
		Array.isArray(value) &&
		value.every(
			(entry) =>
				isPlainRecord(entry) &&
				hasOnlyObjectKeys(entry, ["name"], ["path"]) &&
				isNonEmptyString(entry.name) &&
				(!Object.hasOwn(entry, "path") || isNonEmptyString(entry.path)),
		)
	);
}

function isDegradedExtensions(value: unknown): value is DegradedExtensionV1[] {
	return (
		Array.isArray(value) &&
		value.every(
			(entry) =>
				isPlainRecord(entry) &&
				hasOnlyObjectKeys(entry, ["path", "code"]) &&
				isNonEmptyString(entry.path) &&
				typeof entry.code === "string" &&
				DEGRADED_CODES.has(entry.code as DegradedExtensionCodeV1),
		)
	);
}

function isUnavailableTools(value: unknown): value is UnavailableToolV1[] {
	return (
		Array.isArray(value) &&
		value.every(
			(entry) =>
				isPlainRecord(entry) &&
				hasOnlyObjectKeys(entry, ["name", "reason"]) &&
				isNonEmptyString(entry.name) &&
				typeof entry.reason === "string" &&
				UNAVAILABLE_REASONS.has(entry.reason as UnavailableToolReasonV1),
		)
	);
}

function isSpoolMetadata(value: unknown): value is ResultSpoolMetadata {
	return (
		isPlainRecord(value) &&
		hasOnlyObjectKeys(value, ["basename", "byteSize", "digest"]) &&
		isNonEmptyString(value.basename) &&
		isSafeNonNegativeInteger(value.byteSize) &&
		typeof value.digest === "string" &&
		/^[a-f0-9]{64}$/u.test(value.digest)
	);
}

export function isProtocolEnvelope(value: unknown): value is ProtocolEnvelope & Record<string, unknown> {
	return (
		isPlainRecord(value) &&
		value.protocolVersion === SUBAGENT_PROTOCOL_VERSION &&
		isNonEmptyString(value.sessionNonce) &&
		isNonEmptyString(value.managerEpoch) &&
		isSafeNonNegativeInteger(value.workerGeneration)
	);
}

export function matchesProtocolIdentity(
	value: ProtocolEnvelope,
	identity: Pick<ProtocolEnvelope, "sessionNonce" | "managerEpoch" | "workerGeneration">,
): boolean {
	return (
		value.sessionNonce === identity.sessionNonce &&
		value.managerEpoch === identity.managerEpoch &&
		value.workerGeneration === identity.workerGeneration
	);
}

export function isParentFrame(value: unknown): value is ParentFrame {
	if (
		!isProtocolEnvelope(value) ||
		typeof value.type !== "string" ||
		!PARENT_FRAME_TYPES.has(value.type as ParentFrame["type"])
	) {
		return false;
	}
	switch (value.type) {
		case "BOOTSTRAP":
			return (
				hasExactKeys(value, [
					"parentPid",
					"cwd",
					"agentDir",
					"piPackageDir",
					"spoolDir",
					"selfExtensionPath",
					"settingsSnapshot",
					"projectTrusted",
				]) &&
				isPositiveInteger(value.parentPid) &&
				isNonEmptyString(value.cwd) &&
				isNonEmptyString(value.agentDir) &&
				isNonEmptyString(value.piPackageDir) &&
				isNonEmptyString(value.spoolDir) &&
				isNonEmptyString(value.selfExtensionPath) &&
				isPlainRecord(value.settingsSnapshot) &&
				isJsonValue(value.settingsSnapshot) &&
				typeof value.projectTrusted === "boolean"
			);
		case "SPAWN":
			return (
				hasExactKeys(
					value,
					[
						"opId",
						"agentId",
						"runId",
						"deliveryId",
						"task",
						"model",
						"thinkingLevel",
						"projectContext",
						"candidateExtensionPaths",
						"requiredExtensionPaths",
						"parentToolNames",
						"parentToolSources",
						"parentActiveToolNames",
					],
					["explicitTools"],
				) &&
				isNonEmptyString(value.opId) &&
				isNonEmptyString(value.agentId) &&
				isNonEmptyString(value.runId) &&
				isNonEmptyString(value.deliveryId) &&
				isNonEmptyString(value.task) &&
				isModel(value.model) &&
				typeof value.thinkingLevel === "string" &&
				THINKING_LEVELS.has(value.thinkingLevel as ThinkingLevelV1) &&
				isProjectContext(value.projectContext) &&
				isStringArray(value.candidateExtensionPaths) &&
				isStringArray(value.requiredExtensionPaths) &&
				isStringArray(value.parentToolNames) &&
				isParentToolSources(value.parentToolSources) &&
				isStringArray(value.parentActiveToolNames) &&
				(!Object.hasOwn(value, "explicitTools") || isStringArray(value.explicitTools))
			);
		case "SEND":
			return (
				hasExactKeys(value, ["opId", "agentId", "runId", "deliveryId", "message"]) &&
				isNonEmptyString(value.opId) &&
				isNonEmptyString(value.agentId) &&
				isNonEmptyString(value.runId) &&
				isNonEmptyString(value.deliveryId) &&
				isNonEmptyString(value.message)
			);
		case "CANCEL":
			return (
				hasExactKeys(value, ["opId", "agentId", "runId", "reason"]) &&
				isNonEmptyString(value.opId) &&
				isNonEmptyString(value.agentId) &&
				isNonEmptyString(value.runId) &&
				typeof value.reason === "string"
			);
		case "KILL":
			return (
				hasExactKeys(value, ["opId", "agentId", "lastRunId"]) &&
				isNonEmptyString(value.opId) &&
				isNonEmptyString(value.agentId) &&
				isNonEmptyString(value.lastRunId)
			);
		case "MAILBOX_COMMIT_ACK":
			return (
				hasExactKeys(value, ["terminalOpId", "agentId", "runId", "deliveryId"]) &&
				isNonEmptyString(value.terminalOpId) &&
				isNonEmptyString(value.agentId) &&
				isNonEmptyString(value.runId) &&
				isNonEmptyString(value.deliveryId)
			);
		case "SHUTDOWN":
			return hasExactKeys(value, ["deadlineAt"]) && isSafeNonNegativeInteger(value.deadlineAt);
		default:
			return false;
	}
}

export function isChildFrame(value: unknown): value is ChildFrame {
	if (
		!isProtocolEnvelope(value) ||
		typeof value.type !== "string" ||
		!CHILD_FRAME_TYPES.has(value.type as ChildFrame["type"])
	) {
		return false;
	}
	switch (value.type) {
		case "GUARDIAN_READY":
			return (
				hasExactKeys(value, ["guardianPid", "workerPid", "workerPgid"]) &&
				isPositiveInteger(value.guardianPid) &&
				isPositiveInteger(value.workerPid) &&
				isPositiveInteger(value.workerPgid)
			);
		case "WORKER_READY":
			return (
				hasExactKeys(value, ["workerPid", "workerPgid", "piVersion"]) &&
				isPositiveInteger(value.workerPid) &&
				isPositiveInteger(value.workerPgid) &&
				isNonEmptyString(value.piVersion)
			);
		case "RUN_ACCEPTED":
			return (
				hasExactKeys(value, [
					"opId",
					"operation",
					"agentId",
					"runId",
					"model",
					"thinkingLevel",
					"activeToolCount",
					"capabilityToolCount",
					"degradedExtensions",
					"unavailableTools",
				]) &&
				isNonEmptyString(value.opId) &&
				(value.operation === "spawn" || value.operation === "send") &&
				isNonEmptyString(value.agentId) &&
				isNonEmptyString(value.runId) &&
				isModel(value.model) &&
				typeof value.thinkingLevel === "string" &&
				THINKING_LEVELS.has(value.thinkingLevel as ThinkingLevelV1) &&
				isSafeNonNegativeInteger(value.activeToolCount) &&
				isSafeNonNegativeInteger(value.capabilityToolCount) &&
				isDegradedExtensions(value.degradedExtensions) &&
				isUnavailableTools(value.unavailableTools)
			);
		case "OP_NACK":
			return (
				hasExactKeys(
					value,
					["opId", "operation", "code", "message"],
					["agentId", "runId", "currentRunId", "lastRunId"],
				) &&
				isNonEmptyString(value.opId) &&
				["spawn", "send", "cancel", "kill"].includes(value.operation as string) &&
				typeof value.code === "string" &&
				OPERATION_ERROR_CODES.has(value.code as WorkerOperationErrorCode) &&
				typeof value.message === "string" &&
				["agentId", "runId", "currentRunId", "lastRunId"].every(
					(key) => !Object.hasOwn(value, key) || isNonEmptyString(value[key]),
				)
			);
		case "CANCEL_ACCEPTED":
			return (
				hasExactKeys(value, ["opId", "agentId", "runId"]) &&
				isNonEmptyString(value.opId) &&
				isNonEmptyString(value.agentId) &&
				isNonEmptyString(value.runId)
			);
		case "KILL_ACCEPTED":
		case "KILL_SETTLED":
			return (
				hasExactKeys(value, ["opId", "agentId", "lastRunId"]) &&
				isNonEmptyString(value.opId) &&
				isNonEmptyString(value.agentId) &&
				isNonEmptyString(value.lastRunId)
			);
		case "RUN_TERMINAL": {
			const common =
				isNonEmptyString(value.terminalOpId) &&
				isNonEmptyString(value.agentId) &&
				isNonEmptyString(value.runId) &&
				isNonEmptyString(value.deliveryId) &&
				isSafeNonNegativeInteger(value.completedAt);
			if (!common) return false;
			if (value.outcome === "RESULT") {
				return (
					hasExactKeys(value, ["terminalOpId", "agentId", "runId", "deliveryId", "completedAt", "outcome", "spool"]) &&
					isSpoolMetadata(value.spool)
				);
			}
			if (value.outcome === "FAILED") {
				return (
					hasExactKeys(value, [
						"terminalOpId",
						"agentId",
						"runId",
						"deliveryId",
						"completedAt",
						"outcome",
						"failureCode",
					]) &&
					typeof value.failureCode === "string" &&
					FAILURE_CODES.has(value.failureCode as RunFailureCodeV1)
				);
			}
			return (
				value.outcome === "CANCELLED" &&
				hasExactKeys(value, [
					"terminalOpId",
					"agentId",
					"runId",
					"deliveryId",
					"completedAt",
					"outcome",
					"cancelReason",
				]) &&
				typeof value.cancelReason === "string"
			);
		}
		case "RUN_SETTLED":
			return (
				hasExactKeys(value, ["terminalOpId", "agentId", "runId", "deliveryId"]) &&
				isNonEmptyString(value.terminalOpId) &&
				isNonEmptyString(value.agentId) &&
				isNonEmptyString(value.runId) &&
				isNonEmptyString(value.deliveryId)
			);
		case "AGENT_TOOL_STATE":
			return (
				hasExactKeys(value, ["agentId", "activeToolCount", "capabilityToolCount"]) &&
				isNonEmptyString(value.agentId) &&
				isSafeNonNegativeInteger(value.activeToolCount) &&
				isSafeNonNegativeInteger(value.capabilityToolCount)
			);
		case "WORKER_WARNING":
			return (
				hasExactKeys(value, ["code"], ["agentId", "runId"]) &&
				isNonEmptyString(value.code) &&
				(!Object.hasOwn(value, "agentId") || isNonEmptyString(value.agentId)) &&
				(!Object.hasOwn(value, "runId") || isNonEmptyString(value.runId))
			);
		case "WORKER_EXITED":
			return (
				hasExactKeys(value, ["exitCode", "signal"]) &&
				(value.exitCode === null || (typeof value.exitCode === "number" && Number.isInteger(value.exitCode))) &&
				(value.signal === null || isNonEmptyString(value.signal))
			);
		case "LOSS_CLEANED":
			return (
				hasExactKeys(value, ["workerPid", "workerPgid"]) &&
				isPositiveInteger(value.workerPid) &&
				isPositiveInteger(value.workerPgid)
			);
		case "SHUTDOWN_COMPLETE":
			return hasExactKeys(value, []);
		case "PROTOCOL_ERROR":
			return (
				hasExactKeys(value, ["code"]) &&
				(value.code === "SUBAGENT_PROTOCOL_MISMATCH" || value.code === "SUBAGENT_PI_API_UNSUPPORTED")
			);
		default:
			return false;
	}
}

export function controlMessageByteLength(value: unknown): number {
	try {
		return Buffer.byteLength(JSON.stringify(value), "utf8");
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

export function isControlMessageWithinLimit(value: unknown): boolean {
	return controlMessageByteLength(value) <= MAX_CONTROL_MESSAGE_BYTES;
}

export function assertControlMessageWithinLimit(value: unknown): void {
	if (!isControlMessageWithinLimit(value)) {
		throw new Error("SUBAGENT_CONTROL_MESSAGE_TOO_LARGE");
	}
}
