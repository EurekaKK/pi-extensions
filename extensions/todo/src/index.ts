import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	TODO_COUNTER_ENTRY_TYPE,
	TODO_REMINDER_INTERVAL,
	type TODO_SNAPSHOT_ENTRY_TYPE,
	TODO_TOOL_NAME,
} from "./constants.js";
import { createEmptyRuntimeState, type RuntimeState } from "./domain.js";
import {
	createTodoCounter,
	restoreTodoState,
	type TodoCounterV1,
	TodoLifecycleChangedError,
	TodoStateCoordinator,
	withReminderCount,
} from "./session-state.js";
import { buildTodoReminder, createTodoToolDefinition, isRejectedTodoDetails } from "./tool.js";
import { tryProjectTodoWidget } from "./widget.js";

interface PendingReminder {
	readonly generation: number;
	readonly text: string;
}

function safeBranch(context: ExtensionContext): {
	readonly entries: readonly SessionEntry[];
	readonly failed: boolean;
} {
	try {
		return { entries: context.sessionManager.getBranch(), failed: false };
	} catch {
		return { entries: [], failed: true };
	}
}

export function registerTodoExtension(pi: ExtensionAPI): void {
	const coordinator = new TodoStateCoordinator();
	const toolCallGenerations = new Map<string, number>();
	const pendingReminders = new Map<string, PendingReminder>();
	const ignoredFailedEntryIds = new Set<string>();
	const ignoredFailedEntryData = new Set<unknown>();
	let corruptionWarningShown = false;

	function noteCorruptSessionEntry(context: ExtensionContext): void {
		if (corruptionWarningShown || !context.hasUI) return;
		corruptionWarningShown = true;
		try {
			context.ui.notify(
				"Todo skipped invalid session state and restored the latest valid state it could read.",
				"warning",
			);
		} catch {
			// UI projection is advisory and must not alter Todo semantics.
		}
	}

	function recoverFromBranch(
		context: ExtensionContext,
		fallbackState: RuntimeState,
		failedAppend?: {
			readonly customType: typeof TODO_COUNTER_ENTRY_TYPE | typeof TODO_SNAPSHOT_ENTRY_TYPE;
			readonly data: unknown;
		},
	): RuntimeState {
		if (failedAppend !== undefined) ignoredFailedEntryData.add(failedAppend.data);
		const branch = safeBranch(context);
		if (branch.failed) {
			noteCorruptSessionEntry(context);
			return fallbackState;
		}
		for (const entry of branch.entries) {
			if (
				entry.type === "custom" &&
				ignoredFailedEntryData.has(entry.data) &&
				(failedAppend === undefined || entry.customType === failedAppend.customType)
			) {
				ignoredFailedEntryIds.add(entry.id);
			}
		}
		const restored = restoreTodoState(branch.entries.filter((entry) => !ignoredFailedEntryIds.has(entry.id)));
		if (restored.foundCorruptEntry) noteCorruptSessionEntry(context);
		return restored.state;
	}

	async function restoreLifecycle(context: ExtensionContext, resetWarning: boolean): Promise<void> {
		const generation = coordinator.invalidateLifecycle();
		toolCallGenerations.clear();
		pendingReminders.clear();
		if (resetWarning) {
			corruptionWarningShown = false;
			ignoredFailedEntryIds.clear();
			ignoredFailedEntryData.clear();
		}
		const restoredState = recoverFromBranch(context, createEmptyRuntimeState());
		try {
			await coordinator.run(generation, undefined, (_state, commit) => {
				commit(restoredState);
				tryProjectTodoWidget(context, restoredState.activeList);
			});
		} catch (error) {
			if (!(error instanceof TodoLifecycleChangedError)) throw error;
		}
	}

	async function clearLifecycle(context: ExtensionContext): Promise<void> {
		const generation = coordinator.invalidateLifecycle();
		toolCallGenerations.clear();
		pendingReminders.clear();
		try {
			await coordinator.run(generation, undefined, (_state, commit) => {
				commit(createEmptyRuntimeState());
				tryProjectTodoWidget(context, null);
			});
		} catch (error) {
			if (!(error instanceof TodoLifecycleChangedError)) throw error;
		}
	}

	pi.on("session_start", async (_event, context) => {
		await restoreLifecycle(context, true);
	});

	pi.on("session_tree", async (_event, context) => {
		await restoreLifecycle(context, false);
	});

	pi.on("session_shutdown", async (_event, context) => {
		await clearLifecycle(context);
	});

	pi.on("tool_execution_start", (event) => {
		toolCallGenerations.set(event.toolCallId, coordinator.generation);
	});

	pi.on("tool_result", (event) => {
		if (event.toolName !== TODO_TOOL_NAME || !isRejectedTodoDetails(event.details)) return;
		return { isError: true };
	});

	pi.on("tool_execution_end", async (event, context) => {
		const generation = toolCallGenerations.get(event.toolCallId);
		toolCallGenerations.delete(event.toolCallId);
		if (generation === undefined || event.toolName === TODO_TOOL_NAME) return;

		try {
			await coordinator.run(generation, undefined, (state, commit) => {
				if (state.activeList === null) return;
				const nextCount =
					state.reminderCount === TODO_REMINDER_INTERVAL - 1 ? 0 : ((state.reminderCount + 1) as 1 | 2 | 3 | 4);
				const reminder = nextCount === 0 ? buildTodoReminder(state) : null;
				const counter: TodoCounterV1 = createTodoCounter(nextCount);

				// Pi reports parallel calls here in completion order, but only lets
				// extensions replace the persisted tool result later in message_end.
				// Commit the cadence here and bind any reminder to its call ID so
				// parallel batches cannot reorder or double-count it.
				try {
					pi.appendEntry(TODO_COUNTER_ENTRY_TYPE, counter);
				} catch {
					const recoveredState = recoverFromBranch(context, state, {
						customType: TODO_COUNTER_ENTRY_TYPE,
						data: counter,
					});
					commit(recoveredState);
					tryProjectTodoWidget(context, recoveredState.activeList);
					return;
				}

				commit(withReminderCount(state, nextCount));
				if (reminder !== null) {
					pendingReminders.set(event.toolCallId, { generation, text: reminder });
				}
			});
		} catch (error) {
			if (!(error instanceof TodoLifecycleChangedError)) throw error;
		}
	});

	pi.on("message_end", (event) => {
		if (event.message.role !== "toolResult") return;
		const pending = pendingReminders.get(event.message.toolCallId);
		if (pending === undefined) return;
		pendingReminders.delete(event.message.toolCallId);
		if (pending.generation !== coordinator.generation) return;
		return {
			message: {
				...event.message,
				content: [...event.message.content, { type: "text" as const, text: pending.text }],
			},
		};
	});

	pi.registerTool(
		createTodoToolDefinition(pi, {
			coordinator,
			generationForToolCall: (toolCallId) => toolCallGenerations.get(toolCallId),
			recoverAfterFailedAppend: (context, customType, attemptedData, fallbackState) =>
				recoverFromBranch(context, fallbackState, { customType, data: attemptedData }),
		}),
	);
}

export default registerTodoExtension;
