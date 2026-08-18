import { StringEnum } from "@earendil-works/pi-ai";
import { type AgentToolResult, defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { TODO_TOOL_NAME } from "./constants.js";
import { countTodos, normalizeTodoItems, type TodoCounts, type TodoItem } from "./domain.js";

const DESCRIPTION_HEAD =
	"Record and update a structured task list for the current work. Send the ENTIRE " +
	"list every call — it REPLACES the previous list (there are no partial updates, " +
	"no per-item edits). Use it to plan multi-step work and show progress: add one " +
	"todo per concrete step before you start. ";

const DESCRIPTION_PARALLEL =
	"Mark every todo being actively worked " +
	"on `in_progress` — several at once when work genuinely runs in parallel (e.g. " +
	"concurrent subagents or background commands), one for sequential work; while " +
	"work remains, at least one task should be `in_progress`. ";

const DESCRIPTION_SINGLE =
	"Keep AT MOST ONE todo `in_progress` at a " +
	"time; while work remains, exactly one active task should be `in_progress`. ";

const DESCRIPTION_TAIL =
	"Mark a todo " +
	"`completed` the moment it is done (do not batch completions), and allow no " +
	"`in_progress` item only once all work is complete. Skip the list for trivial " +
	"single-step tasks. Statuses: `pending` (not started), `in_progress` (being " +
	"worked on now), `completed` (finished).";

export const TodoStatusSchema = StringEnum(["pending", "in_progress", "completed"] as const);

export const TodoParametersSchema = Type.Object(
	{
		todos: Type.Array(
			Type.Object(
				{
					content: Type.String(),
					status: TodoStatusSchema,
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);

export type TodoParameters = Static<typeof TodoParametersSchema>;

export interface TodoWriteDetailsV1 {
	readonly version: 1;
	readonly todos: readonly TodoItem[];
	readonly counts: TodoCounts;
}

export interface TodoToolRuntime {
	readonly allowParallelInProgress: boolean;
	readonly persist: (todos: readonly TodoItem[]) => void;
	readonly show: (todos: readonly TodoItem[], context: ExtensionContext) => void;
}

export function describeTodoWrite(allowParallelInProgress: boolean): string {
	return DESCRIPTION_HEAD + (allowParallelInProgress ? DESCRIPTION_PARALLEL : DESCRIPTION_SINGLE) + DESCRIPTION_TAIL;
}

export function formatTodoResultText(counts: TodoCounts): string {
	return `Updated todo list: ${counts.pending} pending, ${counts.inProgress} in progress, ${counts.completed} completed.`;
}

export function createTodoToolDefinition(runtime: TodoToolRuntime) {
	return defineTool({
		name: TODO_TOOL_NAME,
		label: "Todo",
		description: describeTodoWrite(runtime.allowParallelInProgress),
		parameters: TodoParametersSchema,
		executionMode: "parallel",

		execute(_toolCallId, parameters, signal, _onUpdate, context) {
			if (signal?.aborted) throw new Error("Operation aborted");
			const todos = normalizeTodoItems(parameters.todos, runtime.allowParallelInProgress);
			runtime.persist(todos);
			runtime.show(todos, context);
			const counts = countTodos(todos);
			return Promise.resolve({
				content: [{ type: "text" as const, text: formatTodoResultText(counts) }],
				details: {
					version: 1,
					todos: [...todos],
					counts,
				} satisfies TodoWriteDetailsV1,
			} satisfies AgentToolResult<TodoWriteDetailsV1>);
		},

		renderCall(args, theme) {
			const count = Array.isArray(args.todos) ? args.todos.length : 0;
			return new Text(
				`${theme.fg("toolTitle", theme.bold("todo_write"))} ${theme.fg("muted", `Update todo list · ${count} todo${count === 1 ? "" : "s"}`)}`,
				0,
				0,
			);
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
