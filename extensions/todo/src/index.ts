import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	type SessionEntry,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import {
	PROGRESS_WIDGET_ATTACH_EVENT,
	PROGRESS_WIDGET_RELEASE_EVENT,
	PROGRESS_WIDGET_STATE_EVENT,
	parseProgressWidgetAttach,
	parseProgressWidgetRelease,
} from "progress-widget-protocol";
import { type FileMutationQueue, initializeTodoConfig, type TodoConfigV1 } from "./config.js";
import { TODO_SNAPSHOT_ENTRY_TYPE } from "./constants.js";
import { createTodoSnapshot, isFullyCompleted, parseTodoSnapshot, type TodoItem } from "./domain.js";
import { createTodoToolDefinition } from "./tool.js";
import { tryProjectTodoWidget } from "./widget.js";

export interface LoadTodoExtensionDependencies {
	readonly agentDir: string;
	readonly withFileMutationQueue: FileMutationQueue;
}

interface TodoRuntimeState {
	visibleTodos: readonly TodoItem[] | null;
	warningShown: boolean;
}

function notify(context: ExtensionContext, message: string): void {
	if (!context.hasUI) return;
	try {
		context.ui.notify(message, "warning");
	} catch {
		// Advisory UI projection must not change Todo semantics.
	}
}

function restoreVisibleTodos(
	context: ExtensionContext,
	state: TodoRuntimeState,
	project: (context: ExtensionContext, todos: readonly TodoItem[] | null) => void,
): void {
	let entries: readonly SessionEntry[];
	try {
		entries = context.sessionManager.getBranch();
	} catch {
		state.visibleTodos = null;
		project(context, null);
		notify(context, "Todo could not read the current session branch and cleared its widget.");
		return;
	}

	let latestValidTodos: readonly TodoItem[] | null = null;
	let foundInvalidV2 = false;

	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== TODO_SNAPSHOT_ENTRY_TYPE) continue;
		const parsed = parseTodoSnapshot(entry.data);
		if (parsed.status === "valid") {
			latestValidTodos = parsed.todos;
		} else if (parsed.status === "invalid") {
			foundInvalidV2 = true;
		}
	}

	// A fully completed snapshot is the plan's terminal state; retire it on
	// restore too so lists written before settling stay hidden after reload.
	state.visibleTodos = latestValidTodos !== null && isFullyCompleted(latestValidTodos) ? null : latestValidTodos;
	project(context, state.visibleTodos);

	if (foundInvalidV2 && !state.warningShown) {
		state.warningShown = true;
		notify(context, "Todo skipped an invalid version 2 snapshot and restored the latest valid state it could read.");
	}
}

export function registerTodoExtension(pi: ExtensionAPI, config: TodoConfigV1): void {
	const state: TodoRuntimeState = {
		visibleTodos: null,
		warningShown: false,
	};
	let currentContext: ExtensionContext | undefined;
	let attachedSessionId: string | undefined;

	function project(context: ExtensionContext, todos: readonly TodoItem[] | null): void {
		currentContext = context;
		const sessionId = context.sessionManager.getSessionId();
		if (attachedSessionId === sessionId) {
			tryProjectTodoWidget(context, null);
			pi.events.emit(PROGRESS_WIDGET_STATE_EVENT, {
				version: 1,
				source: "todo",
				sessionId,
				todos: todos ?? [],
			});
			return;
		}
		tryProjectTodoWidget(context, todos);
	}

	pi.events.on(PROGRESS_WIDGET_ATTACH_EVENT, (value) => {
		const attached = parseProgressWidgetAttach(value);
		if (attached === null) return;
		attachedSessionId = attached.sessionId;
		if (currentContext?.sessionManager.getSessionId() === attached.sessionId) {
			project(currentContext, state.visibleTodos);
		}
	});

	pi.events.on(PROGRESS_WIDGET_RELEASE_EVENT, (value) => {
		const released = parseProgressWidgetRelease(value);
		if (released === null || attachedSessionId !== released.sessionId) return;
		attachedSessionId = undefined;
		if (currentContext?.sessionManager.getSessionId() === released.sessionId) {
			project(currentContext, state.visibleTodos);
		}
	});

	pi.on("session_start", (_event, context) => {
		currentContext = context;
		state.warningShown = false;
		restoreVisibleTodos(context, state, project);
	});

	pi.on("session_tree", (_event, context) => {
		currentContext = context;
		restoreVisibleTodos(context, state, project);
	});

	pi.on("session_shutdown", (_event, context) => {
		state.visibleTodos = null;
		tryProjectTodoWidget(context, null);
		currentContext = undefined;
		attachedSessionId = undefined;
	});

	pi.registerTool(
		createTodoToolDefinition({
			allowParallelInProgress: config.allowParallelInProgress,
			persist(todos) {
				try {
					pi.appendEntry(TODO_SNAPSHOT_ENTRY_TYPE, createTodoSnapshot(todos));
				} catch (error) {
					throw new Error(`todo_write persistence failed: ${error instanceof Error ? error.message : String(error)}`);
				}
			},
			show(todos, context) {
				state.visibleTodos = todos;
				project(context, todos);
			},
		}),
	);
}

function registerDisabledTodo(pi: ExtensionAPI, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	let warningShown = false;
	pi.on("session_start", (_event, context) => {
		if (warningShown || !context.hasUI) return;
		warningShown = true;
		notify(context, `Todo is disabled: ${message}`);
	});
}

export async function loadTodoExtension(pi: ExtensionAPI, dependencies: LoadTodoExtensionDependencies): Promise<void> {
	try {
		const initialized = await initializeTodoConfig(dependencies);
		registerTodoExtension(pi, initialized.config);
	} catch (error) {
		registerDisabledTodo(pi, error);
	}
}

export default async function todo(pi: ExtensionAPI): Promise<void> {
	await loadTodoExtension(pi, {
		agentDir: getAgentDir(),
		withFileMutationQueue,
	});
}

export type { TodoConfigV1 };
