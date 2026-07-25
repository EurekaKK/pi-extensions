import { type Static, Type } from "typebox";

export const MAX_TEXT_BYTES = 64 * 1024;
export const MAX_CANCEL_REASON_BYTES = 2 * 1024;
export const MAX_CONTROL_MESSAGE_BYTES = 1024 * 1024;
export const MAX_WAIT_RUN_IDS = 16;
export const MAX_LIST_ITEMS = 16;
export const MAX_LABEL_CODE_POINTS = 80;
export const MAX_TIMEOUT_MS = 2_147_483_647;

export const INVALID_ROOT_SENTINEL_KEY = "__subagent_invalid_root_v1__";
export const TRANSPORT_ROOT_DESCRIPTION =
	"Transport envelope. The extension validates the effective input contract; do not send unknown fields.";
export const SUBAGENT_TOOL_NAMES = Object.freeze([
	"subagent_spawn",
	"subagent_send",
	"subagent_wait",
	"subagent_list",
	"subagent_cancel",
	"subagent_kill",
] as const);
export type SubagentToolNameV1 = (typeof SUBAGENT_TOOL_NAMES)[number];

export const TOOL_DESCRIPTIONS = Object.freeze({
	subagent_spawn:
		"Create a new sub-agent with a parent-defined task and start its first run. Use it for independent work that does not require an existing sub-agent's private context.",
	subagent_send:
		"Send one new task to an existing IDLE sub-agent while preserving its private context. This fails instead of queuing when the agent is busy.",
	subagent_wait:
		'Wait for terminal results from specific sub-agent runs. Results are delivered exactly once; use subagent_list with view "deliveries" to rediscover unread run IDs.',
	subagent_list:
		"Inspect sub-agent or pending-delivery metadata without reading report bodies. Use direct lookup for known agent IDs or paginated views for discovery.",
	subagent_cancel:
		"Request cooperative cancellation of the exact active run. This does not kill the sub-agent and must be followed by subagent_wait.",
	subagent_kill:
		"Remove an IDLE sub-agent after checking its last run ID. This never interrupts a running task and does not delete unread deliveries.",
} as const);

export const TRANSPORT_PROPERTY_DESCRIPTIONS = Object.freeze({
	spawn: Object.freeze({
		task: "Required string: the child agent's role, task, and expected deliverable; non-blank, at most 64 KiB UTF-8.",
		label:
			"Optional single-line display label; non-blank after trimming, at most 80 Unicode code points, no C0/C1 controls.",
		projectContext: 'Optional string enum "inherit" or "none"; defaults to "inherit".',
		tools:
			"Optional array of unique non-empty tool-name strings. Omit for best-effort inheritance; an empty array means no tools.",
	}),
	send: Object.freeze({
		agentId: "Required non-empty opaque agent ID returned by spawn or list.",
		message: "Required non-blank string appended to this child agent's private context; at most 64 KiB UTF-8.",
	}),
	wait: Object.freeze({
		runIds: "Required array of 1 to 16 unique non-empty opaque run IDs.",
		mode: 'Required string enum "any" or "all".',
		timeoutMs:
			"Optional integer from 0 to 2147483647 milliseconds; omit to wait until completion, abort, or session shutdown.",
	}),
	list: Object.freeze({
		view: 'Optional string enum "agents" or "deliveries"; defaults to "agents"; forbidden with agentIds.',
		states: "Optional non-empty unique state filter for the selected paginated view; forbidden with agentIds.",
		cursor: "Optional opaque pagination cursor; forbidden with agentIds.",
		limit: "Optional integer from 1 to 16; defaults to 8; forbidden with agentIds.",
		agentIds:
			"Direct-lookup branch only: array of 1 to 16 unique non-empty opaque agent IDs; mutually exclusive with view, states, cursor, and limit.",
	}),
	cancel: Object.freeze({
		agentId: "Required non-empty opaque agent ID.",
		expectedRunId: "Required non-empty opaque ID of the exact active run to cancel.",
		reason: "Required string explaining the cancellation; at most 2 KiB UTF-8.",
	}),
	kill: Object.freeze({
		agentId: "Required non-empty opaque ID of an IDLE agent.",
		expectedLastRunId: "Required non-empty opaque ID of that agent's last run.",
	}),
} as const);

function transportProperty(description: string) {
	return Type.Optional(Type.Unknown({ description }));
}

export const spawnTransportSchema = Type.Object(
	{
		task: transportProperty(TRANSPORT_PROPERTY_DESCRIPTIONS.spawn.task),
		label: transportProperty(TRANSPORT_PROPERTY_DESCRIPTIONS.spawn.label),
		projectContext: transportProperty(TRANSPORT_PROPERTY_DESCRIPTIONS.spawn.projectContext),
		tools: transportProperty(TRANSPORT_PROPERTY_DESCRIPTIONS.spawn.tools),
	},
	{ additionalProperties: true, description: TRANSPORT_ROOT_DESCRIPTION },
);

export const sendTransportSchema = Type.Object(
	{
		agentId: transportProperty(TRANSPORT_PROPERTY_DESCRIPTIONS.send.agentId),
		message: transportProperty(TRANSPORT_PROPERTY_DESCRIPTIONS.send.message),
	},
	{ additionalProperties: true, description: TRANSPORT_ROOT_DESCRIPTION },
);

export const waitTransportSchema = Type.Object(
	{
		runIds: transportProperty(TRANSPORT_PROPERTY_DESCRIPTIONS.wait.runIds),
		mode: transportProperty(TRANSPORT_PROPERTY_DESCRIPTIONS.wait.mode),
		timeoutMs: transportProperty(TRANSPORT_PROPERTY_DESCRIPTIONS.wait.timeoutMs),
	},
	{ additionalProperties: true, description: TRANSPORT_ROOT_DESCRIPTION },
);

export const listTransportSchema = Type.Object(
	{
		view: transportProperty(TRANSPORT_PROPERTY_DESCRIPTIONS.list.view),
		states: transportProperty(TRANSPORT_PROPERTY_DESCRIPTIONS.list.states),
		cursor: transportProperty(TRANSPORT_PROPERTY_DESCRIPTIONS.list.cursor),
		limit: transportProperty(TRANSPORT_PROPERTY_DESCRIPTIONS.list.limit),
		agentIds: transportProperty(TRANSPORT_PROPERTY_DESCRIPTIONS.list.agentIds),
	},
	{ additionalProperties: true, description: TRANSPORT_ROOT_DESCRIPTION },
);

export const cancelTransportSchema = Type.Object(
	{
		agentId: transportProperty(TRANSPORT_PROPERTY_DESCRIPTIONS.cancel.agentId),
		expectedRunId: transportProperty(TRANSPORT_PROPERTY_DESCRIPTIONS.cancel.expectedRunId),
		reason: transportProperty(TRANSPORT_PROPERTY_DESCRIPTIONS.cancel.reason),
	},
	{ additionalProperties: true, description: TRANSPORT_ROOT_DESCRIPTION },
);

export const killTransportSchema = Type.Object(
	{
		agentId: transportProperty(TRANSPORT_PROPERTY_DESCRIPTIONS.kill.agentId),
		expectedLastRunId: transportProperty(TRANSPORT_PROPERTY_DESCRIPTIONS.kill.expectedLastRunId),
	},
	{ additionalProperties: true, description: TRANSPORT_ROOT_DESCRIPTION },
);

export const TRANSPORT_SCHEMAS = Object.freeze({
	spawn: spawnTransportSchema,
	send: sendTransportSchema,
	wait: waitTransportSchema,
	list: listTransportSchema,
	cancel: cancelTransportSchema,
	kill: killTransportSchema,
});

type JsonRecord = Record<string, unknown>;

function isPlainJsonObject(value: unknown): value is JsonRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

export function prepareTransportArguments(args: unknown): JsonRecord {
	if (isPlainJsonObject(args)) return args;
	return { [INVALID_ROOT_SENTINEL_KEY]: true };
}

export function prepareSpawnArguments(args: unknown): Static<typeof spawnTransportSchema> {
	return prepareTransportArguments(args);
}

export function prepareSendArguments(args: unknown): Static<typeof sendTransportSchema> {
	return prepareTransportArguments(args);
}

export function prepareWaitArguments(args: unknown): Static<typeof waitTransportSchema> {
	return prepareTransportArguments(args);
}

export function prepareListArguments(args: unknown): Static<typeof listTransportSchema> {
	return prepareTransportArguments(args);
}

export function prepareCancelArguments(args: unknown): Static<typeof cancelTransportSchema> {
	return prepareTransportArguments(args);
}

export function prepareKillArguments(args: unknown): Static<typeof killTransportSchema> {
	return prepareTransportArguments(args);
}

export type AgentStateV1 = "IDLE" | "RUNNING" | "CANCELLING" | "TERMINATING" | "LOST";
export type DeliveryOutcomeV1 = "RESULT" | "FAILED" | "CANCELLED" | "LOST";
export type ThinkingLevelV1 = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type DegradedExtensionCodeV1 =
	| "factory_failed"
	| "loader_failed"
	| "provider_registration_failed"
	| "session_start_failed"
	| "resources_discover_failed"
	| "run_admission_gate_failed";
export type PendingDeliveryStateV1 = "READY" | "CLAIMED" | "AWAITING_PERSISTENCE";
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

export const DELIVERY_OUTCOME_VALUES = Object.freeze([
	"RESULT",
	"FAILED",
	"CANCELLED",
	"LOST",
] as const satisfies readonly DeliveryOutcomeV1[]);
export const THINKING_LEVEL_VALUES = Object.freeze([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const satisfies readonly ThinkingLevelV1[]);
export const DEGRADED_EXTENSION_CODE_VALUES = Object.freeze([
	"factory_failed",
	"loader_failed",
	"provider_registration_failed",
	"session_start_failed",
	"resources_discover_failed",
	"run_admission_gate_failed",
] as const satisfies readonly DegradedExtensionCodeV1[]);
export const RUN_FAILURE_CODE_VALUES = Object.freeze([
	"SUBAGENT_MODEL_RUN_FAILED",
	"SUBAGENT_RUN_ABORTED",
	"SUBAGENT_OUTPUT_TRUNCATED",
	"SUBAGENT_INCOMPLETE_TOOL_TURN",
	"SUBAGENT_EMPTY_RESULT",
	"SUBAGENT_OUTPUT_TOO_LARGE",
	"SUBAGENT_DELIVERY_STORAGE_FAILED",
	"SUBAGENT_DELIVERY_INTEGRITY_FAILED",
	"SUBAGENT_COMPACTION_FAILED",
] as const satisfies readonly RunFailureCodeV1[]);

export interface DeliveryResultBaseV1 {
	deliveryId: string;
	agentId: string;
	runId: string;
	sequence: number;
	completedAt: number;
}

export type DeliveryResultV1 =
	| (DeliveryResultBaseV1 & { outcome: "RESULT" })
	| (DeliveryResultBaseV1 & { outcome: "FAILED"; failureCode: RunFailureCodeV1 })
	| (DeliveryResultBaseV1 & { outcome: "CANCELLED" | "LOST" });

export interface AgentListItemV1 {
	agentId: string;
	label?: string;
	state: AgentStateV1;
	currentRunId?: string;
	lastRunId?: string;
	model: { provider: string; id: string };
	thinkingLevel: ThinkingLevelV1;
	activeToolCount: number;
	capabilityToolCount: number;
	readyDeliveryCount: number;
	degradedExtensions: string[];
	unavailableToolCount: number;
	workerGeneration: number;
}

export type DeliveryListItemV1 = DeliveryResultV1 & { state: PendingDeliveryStateV1 };

export type SuccessDetailsV1 =
	| {
			schemaVersion: 1;
			operation: "spawn";
			agentId: string;
			runId: string;
			state: "RUNNING";
			label?: string;
			degradedExtensions: Array<{ path: string; code: DegradedExtensionCodeV1 }>;
			unavailableTools: Array<{
				name: string;
				reason: "unlocatable" | "extension_failed" | "not_registered";
			}>;
	  }
	| {
			schemaVersion: 1;
			operation: "send";
			agentId: string;
			runId: string;
			state: "RUNNING";
	  }
	| {
			schemaVersion: 1;
			operation: "wait";
			status: "DELIVERED";
			mode: "any" | "all";
			deliveries: DeliveryResultV1[];
			remainingRunIds: string[];
	  }
	| {
			schemaVersion: 1;
			operation: "wait";
			status: "TIMEOUT";
			mode: "any" | "all";
			timeoutMs: number;
			pending: Array<{ runId: string; state: "RUNNING" | "CANCELLING" | "READY" }>;
	  }
	| {
			schemaVersion: 1;
			operation: "list";
			view: "agents";
			items: AgentListItemV1[];
			nextCursor?: string;
	  }
	| {
			schemaVersion: 1;
			operation: "list";
			view: "deliveries";
			items: DeliveryListItemV1[];
			nextCursor?: string;
	  }
	| {
			schemaVersion: 1;
			operation: "list";
			view: "direct";
			items: AgentListItemV1[];
	  }
	| {
			schemaVersion: 1;
			operation: "cancel";
			agentId: string;
			runId: string;
			status: "CANCEL_REQUESTED";
			state: "CANCELLING";
	  }
	| {
			schemaVersion: 1;
			operation: "kill";
			agentId: string;
			lastRunId: string;
			status: "KILL_REQUESTED";
			state: "TERMINATING";
	  };

export interface SpawnInputV1 {
	task: string;
	label?: string;
	projectContext: "inherit" | "none";
	tools?: string[];
}

export interface SendInputV1 {
	agentId: string;
	message: string;
}

export interface WaitInputV1 {
	runIds: string[];
	mode: "any" | "all";
	timeoutMs?: number;
}

export type AgentListStateV1 = AgentStateV1;
export type DeliveryListStateV1 = PendingDeliveryStateV1;

export type ListInputV1 =
	| {
			view: "agents";
			states?: AgentListStateV1[];
			cursor?: string;
			limit: number;
	  }
	| {
			view: "deliveries";
			states?: DeliveryListStateV1[];
			cursor?: string;
			limit: number;
	  }
	| {
			agentIds: string[];
	  };

export interface CancelInputV1 {
	agentId: string;
	expectedRunId: string;
	reason: string;
}

export interface KillInputV1 {
	agentId: string;
	expectedLastRunId: string;
}

export type InputValidationErrorCodeV1 = "SUBAGENT_INPUT_INVALID" | "SUBAGENT_INPUT_TOO_LARGE";

export class InputValidationError extends Error {
	readonly code: InputValidationErrorCodeV1;

	constructor(code: InputValidationErrorCodeV1, message: string) {
		super(message);
		this.name = "InputValidationError";
		this.code = code;
	}
}

function invalid(message: string): never {
	throw new InputValidationError("SUBAGENT_INPUT_INVALID", message);
}

function tooLarge(message: string): never {
	throw new InputValidationError("SUBAGENT_INPUT_TOO_LARGE", message);
}

function requireObject(value: unknown, allowedKeys: readonly string[]): JsonRecord {
	if (!isPlainJsonObject(value)) invalid("The tool input must be a JSON object.");
	for (const key of Object.keys(value)) {
		if (!allowedKeys.includes(key)) invalid("The tool input contains an unknown field.");
	}
	return value;
}

function requireOwn(record: JsonRecord, key: string): unknown {
	if (!Object.hasOwn(record, key)) invalid("The tool input is missing a required field.");
	return record[key];
}

function requireString(value: unknown): string {
	if (typeof value !== "string") invalid("A tool input field has the wrong JSON type.");
	return value;
}

function requireOpaqueId(value: unknown): string {
	const id = requireString(value);
	if (id.length === 0) invalid("An opaque ID must be a non-empty string.");
	return id;
}

function requireNonBlankText(value: unknown, maximumBytes: number): string {
	const text = requireString(value);
	if (text.trim().length === 0) invalid("Text must contain at least one non-whitespace character.");
	if (Buffer.byteLength(text, "utf8") > maximumBytes) tooLarge("Text exceeds its UTF-8 byte limit.");
	return text;
}

function optionalOpaqueCursor(record: JsonRecord): string | undefined {
	if (!Object.hasOwn(record, "cursor")) return undefined;
	return requireOpaqueId(record.cursor);
}

function requireUniqueIdArray(value: unknown, maximumItems: number): string[] {
	if (!Array.isArray(value) || value.length < 1 || value.length > maximumItems) {
		invalid(`The ID array must contain between 1 and ${maximumItems} items.`);
	}
	const result = value.map(requireOpaqueId);
	if (new Set(result).size !== result.length) invalid("The ID array must not contain duplicates.");
	return result;
}

function requireStateArray<T extends string>(value: unknown, allowedStates: ReadonlySet<string>): T[] {
	if (!Array.isArray(value) || value.length === 0) invalid("The states filter must be a non-empty array.");
	const states = value.map((candidate): T => {
		if (typeof candidate !== "string" || !allowedStates.has(candidate)) {
			return invalid("The states filter contains an invalid state.");
		}
		return candidate as T;
	});
	if (new Set(states).size !== states.length) invalid("The states filter must not contain duplicates.");
	return states;
}

function requireInteger(value: unknown, minimum: number, maximum: number): number {
	if (!Number.isInteger(value) || typeof value !== "number" || value < minimum || value > maximum) {
		invalid(`The number must be an integer from ${minimum} to ${maximum}.`);
	}
	return value;
}

function assertControlMessageSize(value: unknown): void {
	let encoded: string;
	try {
		encoded = JSON.stringify(value);
	} catch {
		invalid("The tool input is not serializable JSON.");
	}
	if (Buffer.byteLength(encoded, "utf8") > MAX_CONTROL_MESSAGE_BYTES) {
		tooLarge("The tool input exceeds the control IPC byte limit.");
	}
}

function containsControlCharacter(value: string): boolean {
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (
			codePoint !== undefined &&
			(codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) || codePoint === 0x2028 || codePoint === 0x2029)
		) {
			return true;
		}
	}
	return false;
}

export function validateSpawnInput(value: unknown): SpawnInputV1 {
	const record = requireObject(value, ["task", "label", "projectContext", "tools"]);
	const task = requireNonBlankText(requireOwn(record, "task"), MAX_TEXT_BYTES);
	const projectContextValue = Object.hasOwn(record, "projectContext") ? record.projectContext : "inherit";
	if (projectContextValue !== "inherit" && projectContextValue !== "none") {
		invalid('projectContext must be "inherit" or "none".');
	}

	let label: string | undefined;
	if (Object.hasOwn(record, "label")) {
		label = requireString(record.label);
		if (label.trim().length === 0) invalid("The label must be non-blank.");
		if ([...label].length > MAX_LABEL_CODE_POINTS) invalid("The label exceeds 80 Unicode code points.");
		if (containsControlCharacter(label)) invalid("The label contains a control character.");
	}

	let tools: string[] | undefined;
	if (Object.hasOwn(record, "tools")) {
		if (!Array.isArray(record.tools)) invalid("tools must be an array.");
		tools = record.tools.map((candidate): string => {
			if (typeof candidate !== "string" || candidate.length === 0) {
				return invalid("Every tool name must be a non-empty string.");
			}
			return candidate;
		});
		if (new Set(tools).size !== tools.length) invalid("tools must not contain duplicate names.");
	}

	const result: SpawnInputV1 = {
		task,
		projectContext: projectContextValue,
		...(label === undefined ? {} : { label }),
		...(tools === undefined ? {} : { tools }),
	};
	assertControlMessageSize(result);
	return result;
}

export function validateSendInput(value: unknown): SendInputV1 {
	const record = requireObject(value, ["agentId", "message"]);
	const result = {
		agentId: requireOpaqueId(requireOwn(record, "agentId")),
		message: requireNonBlankText(requireOwn(record, "message"), MAX_TEXT_BYTES),
	};
	assertControlMessageSize(result);
	return result;
}

export function validateWaitInput(value: unknown): WaitInputV1 {
	const record = requireObject(value, ["runIds", "mode", "timeoutMs"]);
	const runIds = requireUniqueIdArray(requireOwn(record, "runIds"), MAX_WAIT_RUN_IDS);
	const mode = requireString(requireOwn(record, "mode"));
	if (mode !== "any" && mode !== "all") invalid('mode must be "any" or "all".');
	const timeoutMs = Object.hasOwn(record, "timeoutMs")
		? requireInteger(record.timeoutMs, 0, MAX_TIMEOUT_MS)
		: undefined;
	const result: WaitInputV1 = { runIds, mode, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
	assertControlMessageSize(result);
	return result;
}

export const AGENT_STATE_VALUES = Object.freeze([
	"IDLE",
	"RUNNING",
	"CANCELLING",
	"TERMINATING",
	"LOST",
] as const satisfies readonly AgentStateV1[]);
export const DELIVERY_STATE_VALUES = Object.freeze([
	"READY",
	"CLAIMED",
	"AWAITING_PERSISTENCE",
] as const satisfies readonly PendingDeliveryStateV1[]);
const AGENT_STATES = new Set<string>(AGENT_STATE_VALUES);
const DELIVERY_STATES = new Set<string>(DELIVERY_STATE_VALUES);

function normalizeStates<T extends string>(states: T[], canonicalOrder: readonly T[]): T[] {
	const indexes = new Map(canonicalOrder.map((state, index) => [state, index]));
	return states.toSorted((left, right) => (indexes.get(left) ?? Number.MAX_SAFE_INTEGER) - (indexes.get(right) ?? 0));
}

export function validateListInput(value: unknown): ListInputV1 {
	const record = requireObject(value, ["view", "states", "cursor", "limit", "agentIds"]);
	if (Object.hasOwn(record, "agentIds")) {
		if (["view", "states", "cursor", "limit"].some((key) => Object.hasOwn(record, key))) {
			invalid("agentIds is mutually exclusive with view, states, cursor, and limit.");
		}
		const result = { agentIds: requireUniqueIdArray(record.agentIds, MAX_LIST_ITEMS) };
		assertControlMessageSize(result);
		return result;
	}

	const viewValue = Object.hasOwn(record, "view") ? requireString(record.view) : "agents";
	if (viewValue !== "agents" && viewValue !== "deliveries") {
		invalid('view must be "agents" or "deliveries".');
	}
	const cursor = optionalOpaqueCursor(record);
	const limit = Object.hasOwn(record, "limit") ? requireInteger(record.limit, 1, MAX_LIST_ITEMS) : 8;

	if (viewValue === "agents") {
		const states = Object.hasOwn(record, "states")
			? normalizeStates(requireStateArray<AgentListStateV1>(record.states, AGENT_STATES), AGENT_STATE_VALUES)
			: undefined;
		const result: ListInputV1 = {
			view: "agents",
			limit,
			...(states === undefined ? {} : { states }),
			...(cursor === undefined ? {} : { cursor }),
		};
		assertControlMessageSize(result);
		return result;
	}

	const states = Object.hasOwn(record, "states")
		? normalizeStates(requireStateArray<DeliveryListStateV1>(record.states, DELIVERY_STATES), DELIVERY_STATE_VALUES)
		: undefined;
	const result: ListInputV1 = {
		view: "deliveries",
		limit,
		...(states === undefined ? {} : { states }),
		...(cursor === undefined ? {} : { cursor }),
	};
	assertControlMessageSize(result);
	return result;
}

export function validateCancelInput(value: unknown): CancelInputV1 {
	const record = requireObject(value, ["agentId", "expectedRunId", "reason"]);
	const reason = requireString(requireOwn(record, "reason"));
	if (Buffer.byteLength(reason, "utf8") > MAX_CANCEL_REASON_BYTES) {
		tooLarge("The cancellation reason exceeds its UTF-8 byte limit.");
	}
	const result = {
		agentId: requireOpaqueId(requireOwn(record, "agentId")),
		expectedRunId: requireOpaqueId(requireOwn(record, "expectedRunId")),
		reason,
	};
	assertControlMessageSize(result);
	return result;
}

export function validateKillInput(value: unknown): KillInputV1 {
	const record = requireObject(value, ["agentId", "expectedLastRunId"]);
	const result = {
		agentId: requireOpaqueId(requireOwn(record, "agentId")),
		expectedLastRunId: requireOpaqueId(requireOwn(record, "expectedLastRunId")),
	};
	assertControlMessageSize(result);
	return result;
}

export type OperationV1 = "spawn" | "send" | "wait" | "list" | "cancel" | "kill";

export type CommonErrorCodeV1 =
	| "SUBAGENT_UNSUPPORTED_MODE"
	| "SUBAGENT_UNSUPPORTED_PLATFORM"
	| "SUBAGENT_RUNTIME_NOT_BUILT"
	| "SUBAGENT_PI_API_UNSUPPORTED"
	| "SUBAGENT_CONFIG_INVALID"
	| "SUBAGENT_INPUT_INVALID"
	| "SUBAGENT_INPUT_TOO_LARGE"
	| "SUBAGENT_SHUTTING_DOWN";

export interface ErrorCodeByOperationV1 {
	spawn:
		| CommonErrorCodeV1
		| "SUBAGENT_INPUT_HANDLED"
		| "SUBAGENT_RUN_START_FAILED"
		| "SUBAGENT_SESSION_SNAPSHOT_TOO_LARGE"
		| "SUBAGENT_CONCURRENCY_LIMIT"
		| "SUBAGENT_REQUIRED_EXTENSION_FAILED"
		| "SUBAGENT_EXPLICIT_TOOL_MISSING"
		| "SUBAGENT_TOOL_FORBIDDEN"
		| "SUBAGENT_EXTENSION_REHYDRATION_UNSTABLE"
		| "SUBAGENT_MODEL_NOT_FOUND"
		| "SUBAGENT_MODEL_AUTH_REQUIRED"
		| "SUBAGENT_THINKING_UNSUPPORTED"
		| "SUBAGENT_WORKER_START_FAILED"
		| "SUBAGENT_WORKER_RECOVERING"
		| "SUBAGENT_PROTOCOL_MISMATCH"
		| "SUBAGENT_START_UNCERTAIN"
		| "SUBAGENT_OPERATION_INVALIDATED";
	send:
		| CommonErrorCodeV1
		| "SUBAGENT_INPUT_HANDLED"
		| "SUBAGENT_RUN_START_FAILED"
		| "SUBAGENT_CONCURRENCY_LIMIT"
		| "SUBAGENT_BUSY"
		| "SUBAGENT_AGENT_NOT_FOUND"
		| "SUBAGENT_AGENT_TERMINATING"
		| "SUBAGENT_AGENT_LOST"
		| "SUBAGENT_START_UNCERTAIN"
		| "SUBAGENT_OPERATION_INVALIDATED";
	wait:
		| CommonErrorCodeV1
		| "SUBAGENT_RUN_NOT_FOUND"
		| "SUBAGENT_RUN_ALREADY_DELIVERED"
		| "SUBAGENT_WAIT_CONFLICT"
		| "SUBAGENT_WAIT_RESULT_TOO_LARGE";
	list: CommonErrorCodeV1 | "SUBAGENT_AGENT_NOT_FOUND" | "SUBAGENT_CURSOR_STALE";
	cancel:
		| CommonErrorCodeV1
		| "SUBAGENT_AGENT_NOT_FOUND"
		| "SUBAGENT_AGENT_TERMINATING"
		| "SUBAGENT_AGENT_LOST"
		| "SUBAGENT_RUN_ALREADY_TERMINAL"
		| "SUBAGENT_CANCEL_STALE"
		| "SUBAGENT_CANCEL_ALREADY_REQUESTED"
		| "SUBAGENT_IPC_LOST"
		| "SUBAGENT_OPERATION_INVALIDATED";
	kill:
		| CommonErrorCodeV1
		| "SUBAGENT_AGENT_NOT_FOUND"
		| "SUBAGENT_AGENT_TERMINATING"
		| "SUBAGENT_AGENT_LOST"
		| "SUBAGENT_KILL_BLOCKED"
		| "SUBAGENT_KILL_STALE"
		| "SUBAGENT_IPC_LOST"
		| "SUBAGENT_OPERATION_INVALIDATED";
}

export type ManagementErrorCodeV1 = ErrorCodeByOperationV1[OperationV1];
export type ErrorSideEffectsV1 = "none" | "possible";
export type ErrorRetryV1 = "never" | "after_state_change" | "safe";

export type ErrorDetailsForV1<O extends OperationV1> = {
	schemaVersion: 1;
	operation: O;
	code: ErrorCodeByOperationV1[O];
	sideEffects: ErrorSideEffectsV1;
	retry: ErrorRetryV1;
	agentId?: string;
	runId?: string;
	currentRunId?: string;
	lastRunId?: string;
	message: string;
	guidance?: string;
};

export type ErrorDetailsV1 = {
	[O in OperationV1]: ErrorDetailsForV1<O>;
}[OperationV1];

const COMMON_ERROR_CODES = [
	"SUBAGENT_UNSUPPORTED_MODE",
	"SUBAGENT_UNSUPPORTED_PLATFORM",
	"SUBAGENT_RUNTIME_NOT_BUILT",
	"SUBAGENT_PI_API_UNSUPPORTED",
	"SUBAGENT_CONFIG_INVALID",
	"SUBAGENT_INPUT_INVALID",
	"SUBAGENT_INPUT_TOO_LARGE",
	"SUBAGENT_SHUTTING_DOWN",
] as const satisfies readonly CommonErrorCodeV1[];

export const ERROR_CODES_BY_OPERATION = Object.freeze({
	spawn: [
		...COMMON_ERROR_CODES,
		"SUBAGENT_INPUT_HANDLED",
		"SUBAGENT_RUN_START_FAILED",
		"SUBAGENT_SESSION_SNAPSHOT_TOO_LARGE",
		"SUBAGENT_CONCURRENCY_LIMIT",
		"SUBAGENT_REQUIRED_EXTENSION_FAILED",
		"SUBAGENT_EXPLICIT_TOOL_MISSING",
		"SUBAGENT_TOOL_FORBIDDEN",
		"SUBAGENT_EXTENSION_REHYDRATION_UNSTABLE",
		"SUBAGENT_MODEL_NOT_FOUND",
		"SUBAGENT_MODEL_AUTH_REQUIRED",
		"SUBAGENT_THINKING_UNSUPPORTED",
		"SUBAGENT_WORKER_START_FAILED",
		"SUBAGENT_WORKER_RECOVERING",
		"SUBAGENT_PROTOCOL_MISMATCH",
		"SUBAGENT_START_UNCERTAIN",
		"SUBAGENT_OPERATION_INVALIDATED",
	],
	send: [
		...COMMON_ERROR_CODES,
		"SUBAGENT_INPUT_HANDLED",
		"SUBAGENT_RUN_START_FAILED",
		"SUBAGENT_CONCURRENCY_LIMIT",
		"SUBAGENT_BUSY",
		"SUBAGENT_AGENT_NOT_FOUND",
		"SUBAGENT_AGENT_TERMINATING",
		"SUBAGENT_AGENT_LOST",
		"SUBAGENT_START_UNCERTAIN",
		"SUBAGENT_OPERATION_INVALIDATED",
	],
	wait: [
		...COMMON_ERROR_CODES,
		"SUBAGENT_RUN_NOT_FOUND",
		"SUBAGENT_RUN_ALREADY_DELIVERED",
		"SUBAGENT_WAIT_CONFLICT",
		"SUBAGENT_WAIT_RESULT_TOO_LARGE",
	],
	list: [...COMMON_ERROR_CODES, "SUBAGENT_AGENT_NOT_FOUND", "SUBAGENT_CURSOR_STALE"],
	cancel: [
		...COMMON_ERROR_CODES,
		"SUBAGENT_AGENT_NOT_FOUND",
		"SUBAGENT_AGENT_TERMINATING",
		"SUBAGENT_AGENT_LOST",
		"SUBAGENT_RUN_ALREADY_TERMINAL",
		"SUBAGENT_CANCEL_STALE",
		"SUBAGENT_CANCEL_ALREADY_REQUESTED",
		"SUBAGENT_IPC_LOST",
		"SUBAGENT_OPERATION_INVALIDATED",
	],
	kill: [
		...COMMON_ERROR_CODES,
		"SUBAGENT_AGENT_NOT_FOUND",
		"SUBAGENT_AGENT_TERMINATING",
		"SUBAGENT_AGENT_LOST",
		"SUBAGENT_KILL_BLOCKED",
		"SUBAGENT_KILL_STALE",
		"SUBAGENT_IPC_LOST",
		"SUBAGENT_OPERATION_INVALIDATED",
	],
} as const satisfies Readonly<Record<OperationV1, readonly ManagementErrorCodeV1[]>>);

export const ERROR_BEHAVIOR = Object.freeze({
	SUBAGENT_UNSUPPORTED_MODE: { sideEffects: "none", retry: "never" },
	SUBAGENT_UNSUPPORTED_PLATFORM: { sideEffects: "none", retry: "never" },
	SUBAGENT_RUNTIME_NOT_BUILT: { sideEffects: "none", retry: "after_state_change" },
	SUBAGENT_PI_API_UNSUPPORTED: { sideEffects: "none", retry: "never" },
	SUBAGENT_CONFIG_INVALID: { sideEffects: "none", retry: "after_state_change" },
	SUBAGENT_INPUT_INVALID: { sideEffects: "none", retry: "never" },
	SUBAGENT_INPUT_TOO_LARGE: { sideEffects: "none", retry: "never" },
	SUBAGENT_INPUT_HANDLED: { sideEffects: "possible", retry: "never" },
	SUBAGENT_RUN_START_FAILED: { sideEffects: "possible", retry: "never" },
	SUBAGENT_SESSION_SNAPSHOT_TOO_LARGE: { sideEffects: "none", retry: "never" },
	SUBAGENT_CONCURRENCY_LIMIT: { sideEffects: "none", retry: "after_state_change" },
	SUBAGENT_BUSY: { sideEffects: "none", retry: "after_state_change" },
	SUBAGENT_AGENT_NOT_FOUND: { sideEffects: "none", retry: "never" },
	SUBAGENT_AGENT_TERMINATING: { sideEffects: "none", retry: "never" },
	SUBAGENT_AGENT_LOST: { sideEffects: "none", retry: "never" },
	SUBAGENT_RUN_NOT_FOUND: { sideEffects: "none", retry: "never" },
	SUBAGENT_RUN_ALREADY_TERMINAL: { sideEffects: "none", retry: "never" },
	SUBAGENT_RUN_ALREADY_DELIVERED: { sideEffects: "none", retry: "never" },
	SUBAGENT_WAIT_CONFLICT: { sideEffects: "none", retry: "after_state_change" },
	SUBAGENT_WAIT_RESULT_TOO_LARGE: { sideEffects: "none", retry: "never" },
	SUBAGENT_CURSOR_STALE: { sideEffects: "none", retry: "never" },
	SUBAGENT_CANCEL_STALE: { sideEffects: "none", retry: "never" },
	SUBAGENT_CANCEL_ALREADY_REQUESTED: { sideEffects: "none", retry: "never" },
	SUBAGENT_KILL_BLOCKED: { sideEffects: "none", retry: "after_state_change" },
	SUBAGENT_KILL_STALE: { sideEffects: "none", retry: "never" },
	SUBAGENT_REQUIRED_EXTENSION_FAILED: { sideEffects: "possible", retry: "after_state_change" },
	SUBAGENT_EXPLICIT_TOOL_MISSING: { sideEffects: "possible", retry: "after_state_change" },
	SUBAGENT_TOOL_FORBIDDEN: { sideEffects: "none", retry: "never" },
	SUBAGENT_EXTENSION_REHYDRATION_UNSTABLE: { sideEffects: "possible", retry: "after_state_change" },
	SUBAGENT_MODEL_NOT_FOUND: { sideEffects: "possible", retry: "after_state_change" },
	SUBAGENT_MODEL_AUTH_REQUIRED: { sideEffects: "possible", retry: "after_state_change" },
	SUBAGENT_THINKING_UNSUPPORTED: { sideEffects: "possible", retry: "after_state_change" },
	SUBAGENT_WORKER_START_FAILED: { sideEffects: "none", retry: "safe" },
	SUBAGENT_WORKER_RECOVERING: { sideEffects: "none", retry: "after_state_change" },
	SUBAGENT_PROTOCOL_MISMATCH: { sideEffects: "none", retry: "never" },
	SUBAGENT_IPC_LOST: { sideEffects: "possible", retry: "never" },
	SUBAGENT_START_UNCERTAIN: { sideEffects: "possible", retry: "never" },
	SUBAGENT_OPERATION_INVALIDATED: { sideEffects: "none", retry: "after_state_change" },
	SUBAGENT_SHUTTING_DOWN: { sideEffects: "none", retry: "never" },
} as const satisfies Readonly<
	Record<ManagementErrorCodeV1, { readonly sideEffects: ErrorSideEffectsV1; readonly retry: ErrorRetryV1 }>
>);

export interface ErrorMetadataV1 {
	agentId?: string;
	runId?: string;
	currentRunId?: string;
	lastRunId?: string;
}

function safeOpaqueForMessage(value: string | undefined, fallback: string): string {
	if (value === undefined) return fallback;
	const withoutControls = [...value]
		.map((character) => (containsControlCharacter(character) ? "\uFFFD" : character))
		.join("");
	const codePoints = [...withoutControls];
	return codePoints.length <= 160 ? withoutControls : `${codePoints.slice(0, 160).join("")}…`;
}

function publicErrorText(
	code: ManagementErrorCodeV1,
	metadata: ErrorMetadataV1,
): { readonly message: string; readonly guidance?: string } {
	const agentId = safeOpaqueForMessage(metadata.agentId, "<agentId>");
	const runId = safeOpaqueForMessage(metadata.runId ?? metadata.currentRunId, "<runId>");
	switch (code) {
		case "SUBAGENT_BUSY":
			return {
				message: `Agent ${agentId} is already running ${runId}.\nNo message was delivered or queued, and the current run was not affected.`,
				guidance:
					"If you need this agent's existing context, wait for that run to finish and then send again.\nIf the new task does not need that context, spawn a new agent.",
			};
		case "SUBAGENT_CONCURRENCY_LIMIT":
			return {
				message:
					"The session already has 8 running or cancelling sub-agent runs.\nNo agent or run was created and no task was delivered.",
				guidance: "Continue work in the parent agent, or wait for an existing run before trying again.",
			};
		case "SUBAGENT_KILL_BLOCKED":
			return {
				message: "Kill was refused because the agent is not IDLE.\nThe current task was not interrupted.",
				guidance:
					"Do not retry kill while it is running.\nIf cancellation is necessary, cancel the exact active run, wait for its terminal result, and only then kill the idle agent.",
			};
		case "SUBAGENT_WORKER_RECOVERING":
			return {
				message:
					"The previous worker generation exited, but its process group is still being cleaned up.\nNo new agent or run was created and no task was delivered.",
				guidance: "Continue work in the parent agent and retry spawn after the cleanup state changes.",
			};
		case "SUBAGENT_UNSUPPORTED_MODE":
			return { message: "Sub-agents can only run from an interactive parent session." };
		case "SUBAGENT_UNSUPPORTED_PLATFORM":
			return { message: "This sub-agent implementation requires a supported POSIX platform." };
		case "SUBAGENT_RUNTIME_NOT_BUILT":
			return {
				message: "The prebuilt sub-agent sidecar runtime is unavailable.",
				guidance: "Build or reinstall the extension before retrying.",
			};
		case "SUBAGENT_PI_API_UNSUPPORTED":
			return { message: "The current Pi runtime does not expose the public API required by sub-agent v1." };
		case "SUBAGENT_CONFIG_INVALID":
			return {
				message: "The sub-agent configuration is invalid.",
				guidance: "Inspect /subagent config, fix the file, and reload Pi.",
			};
		case "SUBAGENT_INPUT_INVALID":
			return {
				message: "The sub-agent tool input is invalid.",
				guidance: "Correct the arguments before trying again.",
			};
		case "SUBAGENT_INPUT_TOO_LARGE":
			return { message: "The sub-agent tool input exceeds a documented byte limit." };
		case "SUBAGENT_INPUT_HANDLED":
			return { message: "A child input hook handled the delegation before an agent run started." };
		case "SUBAGENT_RUN_START_FAILED":
			return { message: "The child run failed before its first agent_start event." };
		case "SUBAGENT_SESSION_SNAPSHOT_TOO_LARGE":
			return {
				message: "The frozen session or project context exceeds the control-message limit.",
				guidance: 'Retry spawn with projectContext set to "none" and ask the child to inspect files directly.',
			};
		case "SUBAGENT_AGENT_NOT_FOUND":
			return { message: `Agent ${agentId} was not found.` };
		case "SUBAGENT_AGENT_TERMINATING":
			return { message: `Agent ${agentId} is terminating and cannot accept this operation.` };
		case "SUBAGENT_AGENT_LOST":
			return { message: `Agent ${agentId} lost its worker context and cannot be reused.` };
		case "SUBAGENT_RUN_NOT_FOUND":
			return { message: `Run ${runId} was not found.` };
		case "SUBAGENT_RUN_ALREADY_TERMINAL":
			return { message: `Run ${runId} is already terminal and cannot be cancelled.` };
		case "SUBAGENT_RUN_ALREADY_DELIVERED":
			return { message: `Run ${runId} was already delivered and cannot be replayed.` };
		case "SUBAGENT_WAIT_CONFLICT":
			return { message: "At least one requested run is reserved by another active wait." };
		case "SUBAGENT_WAIT_RESULT_TOO_LARGE":
			return {
				message: "The combined wait result would exceed 1 MiB.",
				guidance: "Split the run IDs across multiple wait calls.",
			};
		case "SUBAGENT_CURSOR_STALE":
			return { message: "The pagination cursor belongs to an earlier manager epoch." };
		case "SUBAGENT_CANCEL_STALE":
			return { message: `Run ${runId} is not the agent's current active run.` };
		case "SUBAGENT_CANCEL_ALREADY_REQUESTED":
			return { message: `Cancellation was already requested for run ${runId}.` };
		case "SUBAGENT_KILL_STALE":
			return {
				message: `The expected last run does not match agent ${agentId}.`,
				guidance: `Refresh agent metadata before deciding whether to kill it. Current last run: ${safeOpaqueForMessage(metadata.lastRunId, "<unknown>")}.`,
			};
		case "SUBAGENT_REQUIRED_EXTENSION_FAILED":
			return { message: "A required extension could not be rehydrated for the child runtime." };
		case "SUBAGENT_EXPLICIT_TOOL_MISSING":
			return { message: "An explicitly requested child tool is unavailable." };
		case "SUBAGENT_TOOL_FORBIDDEN":
			return { message: "A requested tool is forbidden by the depth-one sub-agent policy." };
		case "SUBAGENT_EXTENSION_REHYDRATION_UNSTABLE":
			return { message: "Optional extension rehydration remained unstable after one clean rebuild." };
		case "SUBAGENT_MODEL_NOT_FOUND":
			return { message: "The configured child provider or model was not found." };
		case "SUBAGENT_MODEL_AUTH_REQUIRED":
			return {
				message: "Authentication for the selected child model is unavailable.",
				guidance: "Complete provider login in the parent Pi session, then spawn a new child.",
			};
		case "SUBAGENT_THINKING_UNSUPPORTED":
			return { message: "The selected model does not support the requested thinking level." };
		case "SUBAGENT_WORKER_START_FAILED":
			return { message: "The child worker failed to start and provisional manager state was cleaned up." };
		case "SUBAGENT_PROTOCOL_MISMATCH":
			return { message: "The manager and sidecar protocol versions are incompatible." };
		case "SUBAGENT_IPC_LOST":
			return {
				message: "Control IPC was lost after the mutation was dispatched.",
				guidance: "Do not repeat the mutation blindly; inspect list and transient state.",
			};
		case "SUBAGENT_START_UNCERTAIN":
			return {
				message: `Run ${runId} for agent ${agentId} lost IPC before RUN_ACCEPTED was confirmed.`,
				guidance: "External side effects may have occurred. Do not repeat the same task blindly.",
			};
		case "SUBAGENT_OPERATION_INVALIDATED":
			return { message: "The worker generation changed before the prepared operation was dispatched." };
		case "SUBAGENT_SHUTTING_DOWN":
			return { message: "The parent session is shutting down and no new sub-agent operation can start." };
	}
}

export function isErrorCodeForOperation<O extends OperationV1>(
	operation: O,
	code: ManagementErrorCodeV1,
): code is ErrorCodeByOperationV1[O] {
	return (ERROR_CODES_BY_OPERATION[operation] as readonly ManagementErrorCodeV1[]).includes(code);
}

export function createErrorDetails<O extends OperationV1>(
	operation: O,
	code: ErrorCodeByOperationV1[O],
	metadata: ErrorMetadataV1 = {},
): ErrorDetailsForV1<O> {
	if (!isErrorCodeForOperation(operation, code)) {
		throw new TypeError(`Error code ${code} is not valid for operation ${operation}.`);
	}
	const behavior = ERROR_BEHAVIOR[code];
	const text = publicErrorText(code, metadata);
	return {
		schemaVersion: 1,
		operation,
		code,
		sideEffects: behavior.sideEffects,
		retry: behavior.retry,
		...(metadata.agentId === undefined ? {} : { agentId: metadata.agentId }),
		...(metadata.runId === undefined ? {} : { runId: metadata.runId }),
		...(metadata.currentRunId === undefined ? {} : { currentRunId: metadata.currentRunId }),
		...(metadata.lastRunId === undefined ? {} : { lastRunId: metadata.lastRunId }),
		message: text.message,
		...(text.guidance === undefined ? {} : { guidance: text.guidance }),
	};
}

export interface TextToolResultV1<TDetails> {
	content: [{ type: "text"; text: string }];
	details: TDetails;
	isError: boolean;
}

function modelVisibleErrorHeader<O extends OperationV1>(details: ErrorDetailsForV1<O>): string {
	return `SUBAGENT_ERROR code=${details.code} operation=${details.operation} sideEffects=${details.sideEffects} retry=${details.retry}`;
}

export function createErrorResult<O extends OperationV1>(
	operation: O,
	code: ErrorCodeByOperationV1[O],
	metadata: ErrorMetadataV1 = {},
): TextToolResultV1<ErrorDetailsForV1<O>> {
	const details = createErrorDetails(operation, code, metadata);
	const publicText = details.guidance === undefined ? details.message : `${details.message}\n${details.guidance}`;
	const text = `${modelVisibleErrorHeader(details)}\n${publicText}`;
	return {
		content: [{ type: "text", text }],
		details,
		isError: true,
	};
}

function successIsError(details: SuccessDetailsV1): boolean {
	return (
		details.operation === "wait" &&
		details.status === "DELIVERED" &&
		details.deliveries.some((delivery) => delivery.outcome !== "RESULT")
	);
}

export function createSuccessResult(details: SuccessDetailsV1, text: string): TextToolResultV1<SuccessDetailsV1> {
	const isError = successIsError(details);
	return {
		content: [
			{
				type: "text",
				text: isError
					? `${text}\nThe deliveries listed above have been delivered exactly once. Do not wait for those run IDs again.`
					: text,
			},
		],
		details,
		isError,
	};
}
