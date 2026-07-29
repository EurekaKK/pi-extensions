export const TODO_TOOL_NAME = "todo";
export const TODO_WIDGET_KEY = "todo:status";
export const TODO_SNAPSHOT_ENTRY_TYPE = "todo:snapshot";
export const TODO_COUNTER_ENTRY_TYPE = "todo:counter";
export const TODO_REMINDER_INTERVAL = 5;

export const TODO_PROMPT_SNIPPET = "Track multi-step work in one session-scoped Todo List";

export const TODO_PROMPT_GUIDELINES = [
	"Use todo when multi-step work benefits from explicit progress tracking; do not create a list for trivial single-step work.",
	"Keep the active Todo List accurate: add newly discovered work, complete items only after success, and cancel unnecessary items with a specific reason.",
	"Do not claim the tracked work is finished while unresolved Todos remain.",
] as const;

export const TODO_DESCRIPTION =
	"Manage the single session-scoped Todo List for multi-step work. Actions: create a list, add items, update item statuses, or list current state. Todo text is immutable, terminal items cannot be reopened, and the list closes automatically when every item is completed or cancelled.";
