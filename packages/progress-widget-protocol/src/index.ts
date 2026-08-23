export const PROGRESS_WIDGET_ATTACH_EVENT = "progress-widget:attach";
export const PROGRESS_WIDGET_RELEASE_EVENT = "progress-widget:release";
export const PROGRESS_WIDGET_STATE_EVENT = "progress-widget:state";
export const PROGRESS_WIDGET_KEY = "progress-widget:status";
export const PROGRESS_WIDGET_SHORTCUT = "ctrl+alt+o";

export type ProgressWidgetView = "compact" | "full";
export type ProgressWidgetSource = "goal" | "todo" | "sub-agent";

export interface ProgressWidgetOwnershipV1 {
	readonly version: 1;
	readonly sessionId: string;
}

export interface ProgressWidgetGoalStateV1 {
	readonly id: string;
	readonly objective: string;
	readonly phase: "active" | "paused" | "blocked" | "complete";
	readonly roundsStarted: number;
	readonly maxGoalRounds: number;
	readonly activation: "armed" | "disarmed";
	readonly blockedReason?: {
		readonly code: string;
		readonly message: string;
	};
}

export interface ProgressWidgetGoalSnapshotV1 {
	readonly version: 1;
	readonly source: "goal";
	readonly sessionId: string;
	readonly goal: ProgressWidgetGoalStateV1 | null;
}

export interface ProgressWidgetTodoItemV1 {
	readonly content: string;
	readonly status: "pending" | "in_progress" | "completed";
}

export interface ProgressWidgetTodoSnapshotV1 {
	readonly version: 1;
	readonly source: "todo";
	readonly sessionId: string;
	readonly todos: readonly ProgressWidgetTodoItemV1[];
}

export type ProgressWidgetSubagentRunStatus = "running" | "interrupting" | "completed" | "interrupted" | "failed";

export interface ProgressWidgetSubagentV1 {
	readonly id: string;
	readonly description: string;
	readonly status: ProgressWidgetSubagentRunStatus;
}

export interface ProgressWidgetSubagentSnapshotV1 {
	readonly version: 1;
	readonly source: "sub-agent";
	readonly sessionId: string;
	readonly agents: readonly ProgressWidgetSubagentV1[];
}

export type ProgressWidgetSnapshotV1 =
	| ProgressWidgetGoalSnapshotV1
	| ProgressWidgetTodoSnapshotV1
	| ProgressWidgetSubagentSnapshotV1;

function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(
	record: Record<string, unknown>,
	required: readonly string[],
	optional: readonly string[] = [],
): boolean {
	const allowed = new Set([...required, ...optional]);
	return required.every((key) => Object.hasOwn(record, key)) && Object.keys(record).every((key) => allowed.has(key));
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseOwnership(value: unknown): ProgressWidgetOwnershipV1 | null {
	if (!isRecord(value) || !hasExactKeys(value, ["version", "sessionId"])) return null;
	if (value.version !== 1 || !isNonEmptyString(value.sessionId)) return null;
	return Object.freeze({ version: 1, sessionId: value.sessionId });
}

export const parseProgressWidgetAttach = parseOwnership;
export const parseProgressWidgetRelease = parseOwnership;

function parseBlockedReason(value: unknown): ProgressWidgetGoalStateV1["blockedReason"] | null {
	if (!isRecord(value) || !hasExactKeys(value, ["code", "message"])) return null;
	if (!isNonEmptyString(value.code) || !isNonEmptyString(value.message)) return null;
	return Object.freeze({ code: value.code, message: value.message });
}

function parseGoal(value: unknown): ProgressWidgetGoalStateV1 | null {
	if (
		!isRecord(value) ||
		!hasExactKeys(
			value,
			["id", "objective", "phase", "roundsStarted", "maxGoalRounds", "activation"],
			["blockedReason"],
		)
	)
		return null;
	if (!isNonEmptyString(value.id) || !isNonEmptyString(value.objective)) return null;
	if (value.phase !== "active" && value.phase !== "paused" && value.phase !== "blocked" && value.phase !== "complete")
		return null;
	if (!isNonNegativeSafeInteger(value.roundsStarted) || !isNonNegativeSafeInteger(value.maxGoalRounds)) return null;
	if (value.maxGoalRounds < 1) return null;
	if (value.activation !== "armed" && value.activation !== "disarmed") return null;
	let blockedReason: ProgressWidgetGoalStateV1["blockedReason"];
	if (value.blockedReason !== undefined) {
		const parsed = parseBlockedReason(value.blockedReason);
		if (parsed === null) return null;
		blockedReason = parsed;
	}
	return Object.freeze({
		id: value.id,
		objective: value.objective,
		phase: value.phase,
		roundsStarted: value.roundsStarted,
		maxGoalRounds: value.maxGoalRounds,
		activation: value.activation,
		...(blockedReason === undefined ? {} : { blockedReason }),
	});
}

function parseTodo(value: unknown): ProgressWidgetTodoItemV1 | null {
	if (!isRecord(value) || !hasExactKeys(value, ["content", "status"])) return null;
	if (!isNonEmptyString(value.content)) return null;
	if (value.status !== "pending" && value.status !== "in_progress" && value.status !== "completed") return null;
	return Object.freeze({ content: value.content, status: value.status });
}

const SUBAGENT_STATUSES = new Set<ProgressWidgetSubagentRunStatus>([
	"running",
	"interrupting",
	"completed",
	"interrupted",
	"failed",
]);

function parseSubagent(value: unknown): ProgressWidgetSubagentV1 | null {
	if (!isRecord(value) || !hasExactKeys(value, ["id", "description", "status"])) return null;
	if (!isNonEmptyString(value.id) || !isNonEmptyString(value.description)) return null;
	if (typeof value.status !== "string" || !SUBAGENT_STATUSES.has(value.status as ProgressWidgetSubagentRunStatus))
		return null;
	return Object.freeze({
		id: value.id,
		description: value.description,
		status: value.status as ProgressWidgetSubagentRunStatus,
	});
}

export function parseProgressWidgetSnapshot(value: unknown): ProgressWidgetSnapshotV1 | null {
	if (!isRecord(value) || value.version !== 1 || !isNonEmptyString(value.sessionId)) return null;
	if (value.source === "goal") {
		if (!hasExactKeys(value, ["version", "source", "sessionId", "goal"])) return null;
		const goal = value.goal === null ? null : parseGoal(value.goal);
		if (value.goal !== null && goal === null) return null;
		return Object.freeze({ version: 1, source: "goal", sessionId: value.sessionId, goal });
	}
	if (value.source === "todo") {
		if (!hasExactKeys(value, ["version", "source", "sessionId", "todos"]) || !Array.isArray(value.todos)) return null;
		const todos = value.todos.map(parseTodo);
		if (todos.some((todo) => todo === null)) return null;
		return Object.freeze({
			version: 1,
			source: "todo",
			sessionId: value.sessionId,
			todos: Object.freeze(todos as ProgressWidgetTodoItemV1[]),
		});
	}
	if (value.source === "sub-agent") {
		if (!hasExactKeys(value, ["version", "source", "sessionId", "agents"]) || !Array.isArray(value.agents)) return null;
		const agents = value.agents.map(parseSubagent);
		if (agents.some((agent) => agent === null)) return null;
		return Object.freeze({
			version: 1,
			source: "sub-agent",
			sessionId: value.sessionId,
			agents: Object.freeze(agents as ProgressWidgetSubagentV1[]),
		});
	}
	return null;
}
