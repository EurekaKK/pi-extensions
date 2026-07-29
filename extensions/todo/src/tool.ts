import { randomUUID } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	type AgentToolResult,
	defineTool,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import {
	TODO_DESCRIPTION,
	TODO_PROMPT_GUIDELINES,
	TODO_PROMPT_SNIPPET,
	TODO_SNAPSHOT_ENTRY_TYPE,
	TODO_TOOL_NAME,
} from "./constants.js";
import {
	addTodos,
	createTodoList,
	getTodoCounts,
	getUnresolvedTodos,
	type RuntimeState,
	type TodoErrorCode,
	type TodoItem,
	type TodoMutationError,
	type TodoMutationResult,
	updateTodos,
} from "./domain.js";
import {
	createTodoSnapshot,
	TodoLifecycleChangedError,
	type TodoSnapshotV1,
	type TodoStateCoordinator,
} from "./session-state.js";
import { tryProjectTodoWidget } from "./widget.js";

export const TODO_ACTIONS = ["create", "add", "update", "list"] as const;
export type TodoAction = (typeof TODO_ACTIONS)[number];
export type TodoToolOutcome = "created" | "added" | "updated" | "listed" | "closed" | "rejected";

export interface TodoToolDetailsV1 {
	readonly version: 1;
	readonly action: TodoAction;
	readonly outcome: TodoToolOutcome;
	readonly changedIds: readonly number[];
	readonly errorCode?: TodoErrorCode;
}

const TODO_ERROR_CODES: readonly TodoErrorCode[] = [
	"todo_active_list_exists",
	"todo_no_active_list",
	"todo_invalid_arguments",
	"todo_duplicate_update_id",
	"todo_not_found",
	"todo_invalid_transition",
	"todo_no_state_change",
	"todo_cancellation_reason_required",
	"todo_cancellation_reason_forbidden",
	"todo_persistence_failed",
];

const TodoUpdateSchema = Type.Object(
	{
		id: Type.Integer({ minimum: 1 }),
		status: StringEnum(["in_progress", "completed", "cancelled"] as const),
		reason: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

export const TodoParametersSchema = Type.Object(
	{
		action: StringEnum(TODO_ACTIONS),
		items: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
		updates: Type.Optional(Type.Array(TodoUpdateSchema, { minItems: 1 })),
	},
	{ additionalProperties: false },
);

type TodoParameters = Static<typeof TodoParametersSchema>;
type ToolTodoUpdate = TodoParameters["updates"] extends Array<infer Update> | undefined ? Update : never;

type ValidTodoRequest =
	| { readonly action: "create"; readonly items: readonly string[] }
	| { readonly action: "add"; readonly items: readonly string[] }
	| { readonly action: "update"; readonly updates: readonly ToolTodoUpdate[] }
	| { readonly action: "list" };

type RequestValidation =
	| { readonly ok: true; readonly request: ValidTodoRequest }
	| { readonly ok: false; readonly action: TodoAction; readonly message: string };

export interface TodoToolRuntime {
	readonly coordinator: TodoStateCoordinator;
	readonly generationForToolCall: (toolCallId: string) => number | undefined;
	readonly recoverAfterFailedAppend: (
		context: ExtensionContext,
		customType: typeof TODO_SNAPSHOT_ENTRY_TYPE,
		attemptedData: TodoSnapshotV1,
		fallbackState: RuntimeState,
	) => RuntimeState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Object.keys(value);
	return (
		Object.getOwnPropertySymbols(value).length === 0 &&
		keys.length === expected.length &&
		expected.every((key) => Object.hasOwn(value, key))
	);
}

function isTodoAction(value: unknown): value is TodoAction {
	return typeof value === "string" && TODO_ACTIONS.some((action) => action === value);
}

function invalidRequest(value: unknown, message: string): RequestValidation {
	const action = isRecord(value) && isTodoAction(value.action) ? value.action : "list";
	return { ok: false, action, message };
}

export function validateTodoRequest(value: unknown): RequestValidation {
	if (!isRecord(value) || !isTodoAction(value.action)) {
		return invalidRequest(value, "action must be one of create, add, update, or list.");
	}

	if (value.action === "list") {
		return hasExactKeys(value, ["action"])
			? { ok: true, request: { action: "list" } }
			: invalidRequest(value, "list accepts only the action field.");
	}

	if (value.action === "create" || value.action === "add") {
		if (!hasExactKeys(value, ["action", "items"]) || !Array.isArray(value.items) || value.items.length === 0) {
			return invalidRequest(value, `${value.action} requires a non-empty items array and no other fields.`);
		}
		const items: string[] = [];
		for (const [index, item] of value.items.entries()) {
			if (typeof item !== "string" || item.trim().length === 0) {
				return invalidRequest(value, `items[${index}] must be a non-blank string.`);
			}
			items.push(item);
		}
		return { ok: true, request: { action: value.action, items } };
	}

	if (!hasExactKeys(value, ["action", "updates"]) || !Array.isArray(value.updates) || value.updates.length === 0) {
		return invalidRequest(value, "update requires a non-empty updates array and no other fields.");
	}
	const updates: ToolTodoUpdate[] = [];
	for (const [index, candidate] of value.updates.entries()) {
		if (
			!isRecord(candidate) ||
			!Object.hasOwn(candidate, "id") ||
			!Object.hasOwn(candidate, "status") ||
			!Object.keys(candidate).every((key) => key === "id" || key === "status" || key === "reason") ||
			Object.getOwnPropertySymbols(candidate).length > 0 ||
			!Number.isSafeInteger(candidate.id) ||
			typeof candidate.id !== "number" ||
			candidate.id <= 0 ||
			(candidate.status !== "in_progress" && candidate.status !== "completed" && candidate.status !== "cancelled") ||
			(Object.hasOwn(candidate, "reason") && typeof candidate.reason !== "string")
		) {
			return invalidRequest(value, `updates[${index}] has invalid or unknown fields.`);
		}
		const reason = candidate.reason;
		updates.push(
			typeof reason === "string"
				? { id: candidate.id, status: candidate.status, reason }
				: { id: candidate.id, status: candidate.status },
		);
	}
	return { ok: true, request: { action: "update", updates } };
}

function itemLine(todo: TodoItem): string {
	const reason = todo.status === "cancelled" ? ` — reason: ${todo.cancellationReason}` : "";
	return `- [${todo.status}] #${todo.id} ${todo.text}${reason}`;
}

function unresolvedSection(todos: readonly TodoItem[]): string[] {
	if (todos.length === 0) return ["No unresolved Todos remain."];
	return ["The active Todo List still has unresolved items:", ...todos.map(itemLine)];
}

function rejectionResult(
	action: TodoAction,
	error: TodoMutationError,
	state: RuntimeState,
): AgentToolResult<TodoToolDetailsV1> {
	const unresolved = getUnresolvedTodos(state.activeList);
	const content = [
		`Todo request rejected (${error.code}): ${error.message}`,
		"No Todo was changed, and the reminder counter was not reset.",
	];
	if (state.activeList === null) {
		content.push("No active Todo List.");
	} else {
		content.push(
			...unresolvedSection(unresolved),
			"Continue governing every unresolved item: mark it completed when finished, or cancelled with a specific reason when it is no longer needed.",
		);
	}
	return {
		content: [{ type: "text", text: content.join("\n") }],
		details: {
			version: 1,
			action,
			outcome: "rejected",
			changedIds: [],
			errorCode: error.code,
		},
	};
}

function mutationSuccessResult(
	action: Exclude<TodoAction, "list">,
	result: Extract<TodoMutationResult, { readonly ok: true }>,
): AgentToolResult<TodoToolDetailsV1> {
	const changedIds = result.changedTodos.map((todo) => todo.id);
	if (result.outcome === "closed") {
		return {
			content: [
				{
					type: "text",
					text: [
						`Updated Todos: ${changedIds.map((id) => `#${id}`).join(", ")}.`,
						"All Todos are terminal; the Todo List is now closed.",
						`Final counts: ${result.counts.completed} completed, ${result.counts.cancelled} cancelled, ${result.counts.unresolved} unresolved.`,
					].join("\n"),
				},
			],
			details: { version: 1, action, outcome: "closed", changedIds },
		};
	}

	const verb = result.outcome === "created" ? "Created" : result.outcome === "added" ? "Added" : "Updated";
	return {
		content: [
			{
				type: "text",
				text: [
					`${verb} ${result.changedTodos.length} Todo${result.changedTodos.length === 1 ? "" : "s"}:`,
					...result.changedTodos.map(itemLine),
					...unresolvedSection(result.unresolvedTodos),
					"Keep governing the unresolved items until each is completed or explicitly cancelled.",
				].join("\n"),
			},
		],
		details: { version: 1, action, outcome: result.outcome, changedIds },
	};
}

function listResult(state: RuntimeState): AgentToolResult<TodoToolDetailsV1> {
	if (state.activeList === null) {
		return {
			content: [{ type: "text", text: "No active Todo List." }],
			details: { version: 1, action: "list", outcome: "listed", changedIds: [] },
		};
	}
	const counts = getTodoCounts(state.activeList);
	return {
		content: [
			{
				type: "text",
				text: [
					`Active Todo List: ${counts.completed} completed, ${counts.cancelled} cancelled, ${counts.unresolved} unresolved.`,
					...state.activeList.todos.map(itemLine),
				].join("\n"),
			},
		],
		details: { version: 1, action: "list", outcome: "listed", changedIds: [] },
	};
}

function runMutation(
	state: RuntimeState,
	request: Exclude<ValidTodoRequest, { readonly action: "list" }>,
): TodoMutationResult {
	switch (request.action) {
		case "create":
			return createTodoList(state, request.items);
		case "add":
			return addTodos(state, request.items);
		case "update":
			return updateTodos(state, request.updates);
	}
}

export function createTodoToolDefinition(pi: ExtensionAPI, runtime: TodoToolRuntime) {
	const invalidArgumentMarker = `\u0000todo-invalid:${randomUUID()}:`;

	function prepareArguments(rawParameters: unknown): TodoParameters {
		const validation = validateTodoRequest(rawParameters);
		if (validation.ok) {
			switch (validation.request.action) {
				case "create":
				case "add":
					return { action: validation.request.action, items: [...validation.request.items] };
				case "update":
					return {
						action: validation.request.action,
						updates: validation.request.updates.map((update) => ({ ...update })),
					};
				case "list":
					return { action: validation.request.action };
			}
		}
		return {
			action: "create",
			items: [
				`${invalidArgumentMarker}${JSON.stringify({
					action: validation.action,
					message: validation.message,
				})}`,
			],
		};
	}

	function preparedValidation(rawParameters: unknown): RequestValidation {
		if (isRecord(rawParameters) && rawParameters.action === "create" && Array.isArray(rawParameters.items)) {
			const [onlyItem] = rawParameters.items;
			if (
				rawParameters.items.length === 1 &&
				typeof onlyItem === "string" &&
				onlyItem.startsWith(invalidArgumentMarker)
			) {
				try {
					const encoded: unknown = JSON.parse(onlyItem.slice(invalidArgumentMarker.length));
					if (
						isRecord(encoded) &&
						hasExactKeys(encoded, ["action", "message"]) &&
						isTodoAction(encoded.action) &&
						typeof encoded.message === "string"
					) {
						return { ok: false, action: encoded.action, message: encoded.message };
					}
				} catch {
					// Fall through to ordinary strict validation.
				}
			}
		}
		return validateTodoRequest(rawParameters);
	}

	return defineTool({
		name: TODO_TOOL_NAME,
		label: "Todo",
		description: TODO_DESCRIPTION,
		promptSnippet: TODO_PROMPT_SNIPPET,
		promptGuidelines: [...TODO_PROMPT_GUIDELINES],
		parameters: TodoParametersSchema,
		prepareArguments,

		async execute(toolCallId, rawParameters, signal, _onUpdate, context) {
			const validation = preparedValidation(rawParameters);
			const generation = runtime.generationForToolCall(toolCallId);
			if (generation === undefined) throw new TodoLifecycleChangedError();
			return await runtime.coordinator.run(generation, signal, (state, commit) => {
				if (!validation.ok) {
					return rejectionResult(
						validation.action,
						{ code: "todo_invalid_arguments", message: validation.message },
						state,
					);
				}
				if (validation.request.action === "list") return listResult(state);

				const mutation = runMutation(state, validation.request);
				if (!mutation.ok) return rejectionResult(validation.request.action, mutation.error, mutation.state);

				const snapshot = createTodoSnapshot(mutation.state);
				try {
					pi.appendEntry(TODO_SNAPSHOT_ENTRY_TYPE, snapshot);
				} catch {
					const recoveredState = runtime.recoverAfterFailedAppend(context, TODO_SNAPSHOT_ENTRY_TYPE, snapshot, state);
					commit(recoveredState);
					tryProjectTodoWidget(context, recoveredState.activeList);
					return rejectionResult(
						validation.request.action,
						{
							code: "todo_persistence_failed",
							message:
								"The Todo snapshot could not be persisted; the mutation was not reported as committed, and the extension retained or rebuilt the last known state.",
						},
						recoveredState,
					);
				}

				commit(mutation.state);
				tryProjectTodoWidget(context, mutation.state.activeList);
				return mutationSuccessResult(validation.request.action, mutation);
			});
		},

		renderCall(args, theme) {
			let summary = args.action;
			if (Array.isArray(args.items)) {
				summary += ` · ${args.items.length} item${args.items.length === 1 ? "" : "s"}`;
			}
			if (Array.isArray(args.updates)) {
				const ids = args.updates.map((update) => (typeof update?.id === "number" ? `#${update.id}` : "?")).join(", ");
				summary += ` · ${ids}`;
			}
			return new Text(`${theme.fg("toolTitle", theme.bold("todo"))} ${theme.fg("muted", summary)}`, 0, 0);
		},

		renderResult(result, { expanded }, theme, context) {
			const text = result.content
				.filter((block): block is Extract<(typeof result.content)[number], { type: "text" }> => block.type === "text")
				.map((block) => block.text)
				.join("\n");
			const visible = expanded ? text : (text.split("\n", 1)[0] ?? "");
			return new Text(theme.fg(context.isError ? "error" : "success", visible), 0, 0);
		},
	});
}

export function isRejectedTodoDetails(value: unknown): value is TodoToolDetailsV1 & {
	readonly outcome: "rejected";
	readonly errorCode: TodoErrorCode;
} {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, ["version", "action", "outcome", "changedIds", "errorCode"]) ||
		value.version !== 1 ||
		value.outcome !== "rejected" ||
		!isTodoAction(value.action)
	) {
		return false;
	}
	if (
		!Array.isArray(value.changedIds) ||
		value.changedIds.length !== 0 ||
		!TODO_ERROR_CODES.some((code) => code === value.errorCode)
	) {
		return false;
	}
	return true;
}

export function buildTodoReminder(state: RuntimeState): string | null {
	const unresolved = getUnresolvedTodos(state.activeList);
	if (unresolved.length === 0) return null;
	return [
		"TODO REMINDER — generated by the Todo extension",
		"",
		...unresolvedSection(unresolved),
		"",
		"Continue governing these items. Mark each one completed when finished,",
		"or cancelled with a specific reason when it is no longer needed.",
		"The list closes only when no unresolved items remain.",
	].join("\n");
}
