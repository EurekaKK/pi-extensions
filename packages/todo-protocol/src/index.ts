import { hasExactKeys, isRecord } from "config-store";

/**
 * Todo Protocol — 由 Todo extension 独占所有权、供 Plan extension 通过声明依赖
 * 消费的持久化与进程内契约。
 *
 * 职责边界：
 * - Todo snapshot v2/v3 类型、parser 与 fold；
 * - TodoItem 的 Plan Step source metadata；
 * - handoff replace request/result envelope 及其 parser；
 * - 相关常量。
 *
 * 本包不包含 Plan Proposal 类型、规划策略、UI 或 Plan 状态 fold。
 */

export const TODO_SNAPSHOT_ENTRY_TYPE = "todo:snapshot" as const;
export const TODO_SNAPSHOT_VERSION = 3 as const;
export const TODO_REPLACE_REQUEST_EVENT = "todo:replace-request" as const;
export const TODO_REPLACE_REQUEST_VERSION = 1 as const;
export const TODO_REPLACE_RESULT_VERSION = 1 as const;

export const TODO_STATUSES = ["pending", "in_progress", "completed"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

/** 精确指向一个不可变 Plan Revision 中的某个 Plan Step。 */
export interface PlanStepRefV1 {
	readonly planId: string;
	readonly planRevision: number;
	readonly stepId: string;
}

export interface TodoPlanSourceV1 {
	readonly kind: "plan-step";
	readonly ref: PlanStepRefV1;
}

/** 未来其他 producer 可扩展为新的 kind。 */
export type TodoSourceV1 = TodoPlanSourceV1;

export interface TodoItemV3 {
	readonly content: string;
	readonly status: TodoStatus;
	readonly source?: TodoSourceV1;
}

export interface TodoHandoffOriginV1 {
	readonly handoffId: string;
}

export interface TodoSnapshotV3 {
	readonly version: 3;
	readonly todos: readonly TodoItemV3[];
	readonly handoffOrigin?: TodoHandoffOriginV1;
}

export type TodoSnapshotParseResult =
	| {
			readonly status: "valid";
			readonly todos: readonly TodoItemV3[];
			readonly handoffOrigin?: TodoHandoffOriginV1;
	  }
	| { readonly status: "ignored" }
	| { readonly status: "invalid" };

/** 内部 handoff 请求：Plan 请求 TodoService 建立链接的初始列表。 */
export interface TodoReplaceRequestV1 {
	readonly version: 1;
	readonly requestId: string;
	readonly sessionId: string;
	readonly handoffId: string;
	readonly todos: readonly TodoItemV3[];
}

export interface TodoReplaceResultV1 {
	readonly version: 1;
	readonly requestId: string;
	/** true = 本次提交；false = 同一 handoffId 已提交（幂等命中）。 */
	readonly applied: boolean;
	readonly error?: string;
}

export type TodoReplaceRespond = (result: TodoReplaceResultV1) => void;

export interface TodoReplaceRequestEnvelopeV1 extends TodoReplaceRequestV1 {
	readonly respond: TodoReplaceRespond;
}

function isTodoStatus(value: unknown): value is TodoStatus {
	return typeof value === "string" && TODO_STATUSES.some((status) => status === value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function freezeTodoItem(item: TodoItemV3): TodoItemV3 {
	return Object.freeze({
		content: item.content,
		status: item.status,
		...(item.source === undefined ? {} : { source: freezeSource(item.source) }),
	});
}

function freezeSource(source: TodoSourceV1): TodoSourceV1 {
	return Object.freeze({
		kind: source.kind,
		ref: Object.freeze({
			planId: source.ref.planId,
			planRevision: source.ref.planRevision,
			stepId: source.ref.stepId,
		}),
	});
}

function parsePlanStepRef(value: unknown): PlanStepRefV1 | null {
	if (!isRecord(value) || !hasExactKeys(value, ["planId", "planRevision", "stepId"])) return null;
	if (
		!isNonEmptyString(value.planId) ||
		!isPositiveSafeInteger(value.planRevision) ||
		!isNonEmptyString(value.stepId)
	) {
		return null;
	}
	return Object.freeze({ planId: value.planId, planRevision: value.planRevision, stepId: value.stepId });
}

function parseTodoSource(value: unknown): TodoSourceV1 | null {
	if (!isRecord(value) || !hasExactKeys(value, ["kind", "ref"])) return null;
	if (value.kind !== "plan-step") return null;
	const ref = parsePlanStepRef(value.ref);
	if (ref === null) return null;
	return Object.freeze({ kind: "plan-step", ref });
}

function parseTodoItem(value: unknown, allowSource: boolean): TodoItemV3 | null {
	if (!isRecord(value)) return null;
	if (allowSource) {
		const allowed = new Set(["content", "status", "source"]);
		if (!Object.keys(value).every((key) => allowed.has(key))) return null;
		if (!Object.hasOwn(value, "content") || !Object.hasOwn(value, "status")) return null;
	} else if (!hasExactKeys(value, ["content", "status"])) {
		return null;
	}
	if (typeof value.content !== "string" || value.content.length === 0 || value.content !== value.content.trim()) {
		return null;
	}
	if (!isTodoStatus(value.status)) return null;
	let source: TodoSourceV1 | undefined;
	if (allowSource && value.source !== undefined) {
		const parsed = parseTodoSource(value.source);
		if (parsed === null) return null;
		source = parsed;
	}
	return freezeTodoItem(
		source === undefined
			? { content: value.content, status: value.status }
			: { content: value.content, status: value.status, source },
	);
}

function parseHandoffOrigin(value: unknown): TodoHandoffOriginV1 | null {
	if (!isRecord(value) || !hasExactKeys(value, ["handoffId"])) return null;
	if (!isNonEmptyString(value.handoffId)) return null;
	return Object.freeze({ handoffId: value.handoffId });
}

function hasDuplicateContent(todos: readonly TodoItemV3[]): boolean {
	const seen = new Set<string>();
	for (const todo of todos) {
		if (seen.has(todo.content)) return true;
		seen.add(todo.content);
	}
	return false;
}

/**
 * 解析一条 `todo:snapshot` custom entry 数据。三态分类与既有实现一致：
 * version 2 合法（映射为无 source 的 v3 语义）；version 3 合法；version 1 与
 * 未知版本静默 ignored；声称当前版本但形状损坏的 invalid。
 */
export function parseTodoSnapshot(value: unknown): TodoSnapshotParseResult {
	if (!isRecord(value)) return { status: "invalid" };
	if (value.version === 3) {
		const allowedKeys = ["version", "todos", "handoffOrigin"];
		if (!Object.keys(value).every((key) => allowedKeys.includes(key))) return { status: "invalid" };
		if (!Array.isArray(value.todos)) return { status: "invalid" };
		const todos: TodoItemV3[] = [];
		for (const candidate of value.todos) {
			const parsed = parseTodoItem(candidate, true);
			if (parsed === null) return { status: "invalid" };
			todos.push(parsed);
		}
		if (hasDuplicateContent(todos)) return { status: "invalid" };
		let handoffOrigin: TodoHandoffOriginV1 | undefined;
		if (value.handoffOrigin !== undefined) {
			const parsed = parseHandoffOrigin(value.handoffOrigin);
			if (parsed === null) return { status: "invalid" };
			handoffOrigin = parsed;
		}
		return Object.freeze({
			status: "valid",
			todos: Object.freeze(todos),
			...(handoffOrigin === undefined ? {} : { handoffOrigin }),
		});
	}
	if (value.version === 2) {
		if (!hasExactKeys(value, ["version", "todos"]) || !Array.isArray(value.todos)) return { status: "invalid" };
		const todos: TodoItemV3[] = [];
		for (const candidate of value.todos) {
			const parsed = parseTodoItem(candidate, false);
			if (parsed === null) return { status: "invalid" };
			todos.push(parsed);
		}
		if (hasDuplicateContent(todos)) return { status: "invalid" };
		return Object.freeze({ status: "valid", todos: Object.freeze(todos) });
	}
	return { status: "ignored" };
}

/** 校验一个 handoff/模型提交的原始列表并构造规范化不可变列表；失败抛稳定错误。 */
export function normalizeTodoList(raw: readonly unknown[]): readonly TodoItemV3[] {
	const todos: TodoItemV3[] = [];
	const seen = new Set<string>();
	for (const candidate of raw) {
		if (!isRecord(candidate)) {
			throw new Error("invalid todo: `content` must be a non-empty string");
		}
		const { content, status } = candidate;
		if (typeof content !== "string" || !isTodoStatus(status)) {
			throw new Error("invalid todo: `content` must be a non-empty string");
		}
		const trimmed = content.trim();
		if (trimmed.length === 0) {
			throw new Error("invalid todo: `content` must be a non-empty string");
		}
		if (seen.has(trimmed)) {
			throw new Error(`invalid todos: duplicate content ${JSON.stringify(trimmed)}`);
		}
		seen.add(trimmed);
		let source: TodoSourceV1 | undefined;
		if (candidate.source !== undefined) {
			const parsed = parseTodoSource(candidate.source);
			if (parsed === null) {
				throw new Error(
					"invalid todo: `source` must be a plan step reference with `kind`, `planId`, `planRevision`, and `stepId`",
				);
			}
			source = parsed;
		}
		todos.push(
			freezeTodoItem(source === undefined ? { content: trimmed, status } : { content: trimmed, status, source }),
		);
	}
	return Object.freeze(todos);
}

export function createTodoSnapshotV3(
	todos: readonly TodoItemV3[],
	handoffOrigin?: TodoHandoffOriginV1,
): TodoSnapshotV3 {
	return Object.freeze({
		version: TODO_SNAPSHOT_VERSION,
		todos: Object.freeze(todos.map(freezeTodoItem)),
		...(handoffOrigin === undefined ? {} : { handoffOrigin: Object.freeze({ handoffId: handoffOrigin.handoffId }) }),
	});
}

export interface FoldedTodoState {
	readonly todos: readonly TodoItemV3[];
	readonly handoffOrigin?: TodoHandoffOriginV1;
	/** 遇到形状损坏的当前版本快照时为 true（调用方决定是否提示一次 warning）。 */
	readonly foundInvalid: boolean;
}

/** 按 branch 顺序 last-write-wins fold 所有可达 Todo 快照。 */
export function foldTodoSnapshots(
	entries: readonly { readonly type: string; readonly customType?: string; readonly data?: unknown }[],
): FoldedTodoState {
	let todos: readonly TodoItemV3[] = Object.freeze([]);
	let handoffOrigin: TodoHandoffOriginV1 | undefined;
	let foundInvalid = false;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== TODO_SNAPSHOT_ENTRY_TYPE) continue;
		const parsed = parseTodoSnapshot(entry.data);
		if (parsed.status === "valid") {
			todos = parsed.todos;
			if (parsed.handoffOrigin !== undefined) handoffOrigin = parsed.handoffOrigin;
		} else if (parsed.status === "invalid") {
			foundInvalid = true;
		}
	}
	return Object.freeze({
		todos,
		...(handoffOrigin === undefined ? {} : { handoffOrigin }),
		foundInvalid,
	});
}

/** 幂等检测：当前 branch 上任意可达 v3 快照带有该 handoffId。 */
export function hasCommittedHandoff(
	entries: readonly { readonly type: string; readonly customType?: string; readonly data?: unknown }[],
	handoffId: string,
): boolean {
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== TODO_SNAPSHOT_ENTRY_TYPE) continue;
		const parsed = parseTodoSnapshot(entry.data);
		if (parsed.status === "valid" && parsed.handoffOrigin?.handoffId === handoffId) return true;
	}
	return false;
}

export function parseTodoReplaceRequest(value: unknown): TodoReplaceRequestV1 | null {
	if (!isRecord(value) || value.version !== TODO_REPLACE_REQUEST_VERSION) return null;
	// 总线上的真实 payload 还携带 respond 回调；parser 只校验并返回持久化字段。
	const allowedKeys = ["version", "requestId", "sessionId", "handoffId", "todos", "respond"];
	if (!Object.keys(value).every((key) => allowedKeys.includes(key))) return null;
	if (!isNonEmptyString(value.requestId) || !isNonEmptyString(value.sessionId) || !isNonEmptyString(value.handoffId)) {
		return null;
	}
	if (!Array.isArray(value.todos)) return null;
	const todos: TodoItemV3[] = [];
	for (const candidate of value.todos) {
		const parsed = parseTodoItem(candidate, true);
		if (parsed === null) return null;
		todos.push(parsed);
	}
	if (hasDuplicateContent(todos)) return null;
	return Object.freeze({
		version: 1,
		requestId: value.requestId,
		sessionId: value.sessionId,
		handoffId: value.handoffId,
		todos: Object.freeze(todos),
	});
}

export function parseTodoReplaceResult(value: unknown): TodoReplaceResultV1 | null {
	if (!isRecord(value) || value.version !== TODO_REPLACE_RESULT_VERSION) return null;
	const allowedKeys = ["version", "requestId", "applied", "error"];
	if (!Object.keys(value).every((key) => allowedKeys.includes(key))) return null;
	if (!Object.hasOwn(value, "requestId") || !Object.hasOwn(value, "applied")) return null;
	if (!isNonEmptyString(value.requestId) || typeof value.applied !== "boolean") return null;
	if (value.error !== undefined && typeof value.error !== "string") return null;
	return Object.freeze({
		version: 1,
		requestId: value.requestId,
		applied: value.applied,
		...(value.error === undefined ? {} : { error: value.error }),
	});
}
