import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type {
	ProgressWidgetGoalStateV1,
	ProgressWidgetSnapshotV1,
	ProgressWidgetSubagentRunStatus,
	ProgressWidgetSubagentV1,
	ProgressWidgetTodoItemV1,
	ProgressWidgetView,
} from "progress-widget-protocol";

export interface ProgressWidgetState {
	readonly goal: ProgressWidgetGoalStateV1 | null;
	readonly todos: readonly ProgressWidgetTodoItemV1[];
	readonly agents: readonly ProgressWidgetSubagentV1[];
}

const GOAL_MARK = Object.freeze({ active: "◐", paused: "Ⅱ", blocked: "!", complete: "✓" });
const TODO_MARK = Object.freeze({ in_progress: "◐", pending: "○", completed: "✓" });
const AGENT_MARK: Readonly<Record<ProgressWidgetSubagentRunStatus, string>> = Object.freeze({
	running: "◐",
	interrupting: "…",
	completed: "✓",
	interrupted: "■",
	failed: "!",
});

type GoalPhase = ProgressWidgetGoalStateV1["phase"];
type TodoStatus = ProgressWidgetTodoItemV1["status"];
type VisualStatus = GoalPhase | TodoStatus | ProgressWidgetSubagentRunStatus;
type WidgetSection = "Subagents" | "Todos" | "Goal";

const STATUS_COLOR: Readonly<Record<VisualStatus, ThemeColor>> = Object.freeze({
	active: "accent",
	paused: "muted",
	blocked: "error",
	complete: "success",
	in_progress: "accent",
	pending: "muted",
	completed: "success",
	running: "accent",
	interrupting: "warning",
	interrupted: "muted",
	failed: "error",
});

type WidgetRow =
	| { readonly kind: "header"; readonly title: WidgetSection; readonly metadata: string }
	| {
			readonly kind: "agent";
			readonly status: ProgressWidgetSubagentRunStatus;
			readonly id: string;
			readonly description: string;
	  }
	| { readonly kind: "status"; readonly status: GoalPhase | TodoStatus; readonly content: string }
	| { readonly kind: "objective"; readonly phase: GoalPhase; readonly content: string }
	| { readonly kind: "blocker"; readonly code: string; readonly message: string };

function goalMetadata(goal: ProgressWidgetGoalStateV1): string {
	const blocker = goal.blockedReason === undefined ? "" : ` · ${goal.blockedReason.code}`;
	return `${goal.phase} · round ${goal.roundsStarted}/${goal.maxGoalRounds} · ${goal.activation}${blocker}`;
}

function todoCounts(todos: readonly ProgressWidgetTodoItemV1[]): {
	readonly pending: number;
	readonly inProgress: number;
	readonly completed: number;
} {
	let pending = 0;
	let inProgress = 0;
	let completed = 0;
	for (const todo of todos) {
		if (todo.status === "pending") pending += 1;
		else if (todo.status === "in_progress") inProgress += 1;
		else completed += 1;
	}
	return { pending, inProgress, completed };
}

function visibleAgents(agents: readonly ProgressWidgetSubagentV1[]): readonly ProgressWidgetSubagentV1[] {
	return agents.some((agent) => agent.status === "running" || agent.status === "interrupting") ? agents : [];
}

function agentCounts(agents: readonly ProgressWidgetSubagentV1[]): Record<ProgressWidgetSubagentRunStatus, number> {
	const counts: Record<ProgressWidgetSubagentRunStatus, number> = {
		running: 0,
		interrupting: 0,
		completed: 0,
		interrupted: 0,
		failed: 0,
	};
	for (const agent of agents) counts[agent.status] += 1;
	return counts;
}

function header(title: WidgetSection, metadata: string): WidgetRow {
	return { kind: "header", title, metadata };
}

function compactRows(state: ProgressWidgetState): WidgetRow[] {
	const rows: WidgetRow[] = [];
	const agents = visibleAgents(state.agents);
	if (agents.length > 0) {
		const counts = agentCounts(agents);
		rows.push(
			header(
				"Subagents",
				`${counts.running} running · ${counts.interrupting} interrupting · ${counts.completed} completed · ${counts.interrupted} interrupted · ${counts.failed} failed`,
			),
		);
	}
	if (state.todos.length > 0) {
		const counts = todoCounts(state.todos);
		rows.push(
			header("Todos", `${counts.inProgress} in progress · ${counts.pending} pending · ${counts.completed} completed`),
		);
		const first =
			state.todos.find((todo) => todo.status === "in_progress") ??
			state.todos.find((todo) => todo.status === "pending");
		if (first !== undefined) rows.push({ kind: "status", status: first.status, content: first.content });
	}
	if (state.goal !== null) {
		rows.push(header("Goal", goalMetadata(state.goal)), {
			kind: "status",
			status: state.goal.phase,
			content: state.goal.objective,
		});
	}
	return rows;
}

function fullRows(state: ProgressWidgetState): WidgetRow[] {
	const rows: WidgetRow[] = [];
	const agents = visibleAgents(state.agents);
	if (agents.length > 0) {
		const counts = agentCounts(agents);
		rows.push(
			header(
				"Subagents",
				`${counts.running} running · ${counts.interrupting} interrupting · ${counts.completed} completed · ${counts.interrupted} interrupted · ${counts.failed} failed`,
			),
		);
		for (const agent of agents) {
			rows.push({
				kind: "agent",
				status: agent.status,
				id: agent.id,
				description: agent.description,
			});
		}
	}
	if (state.todos.length > 0) {
		const counts = todoCounts(state.todos);
		rows.push(
			header("Todos", `${counts.inProgress} in progress · ${counts.pending} pending · ${counts.completed} completed`),
		);
		for (const todo of state.todos) {
			rows.push({ kind: "status", status: todo.status, content: todo.content });
		}
	}
	if (state.goal !== null) {
		rows.push(header("Goal", goalMetadata(state.goal)), {
			kind: "objective",
			phase: state.goal.phase,
			content: state.goal.objective,
		});
		if (state.goal.blockedReason !== undefined) {
			rows.push({
				kind: "blocker",
				code: state.goal.blockedReason.code,
				message: state.goal.blockedReason.message,
			});
		}
	}
	return rows;
}

function statusMark(status: GoalPhase | TodoStatus): string {
	if (status === "active" || status === "paused" || status === "blocked" || status === "complete") {
		return GOAL_MARK[status];
	}
	return TODO_MARK[status];
}

function plainRow(row: WidgetRow): string {
	if (row.kind === "header") return `${row.title} · ${row.metadata}`;
	if (row.kind === "agent") {
		return `${AGENT_MARK[row.status]} ${row.status} · ${row.id} · ${row.description}`;
	}
	if (row.kind === "status") return `${statusMark(row.status)} ${row.content}`;
	if (row.kind === "objective") return `Objective: ${row.content}`;
	return `Blocker: ${row.code}: ${row.message}`;
}

function progressWidgetRows(state: ProgressWidgetState, view: ProgressWidgetView): WidgetRow[] {
	return view === "compact" ? compactRows(state) : fullRows(state);
}

export function buildProgressWidgetLines(state: ProgressWidgetState, view: ProgressWidgetView): string[] {
	return progressWidgetRows(state, view).map(plainRow);
}

function styledBody(status: GoalPhase | TodoStatus, content: string, theme: Theme): string {
	if (status === "complete" || status === "completed") {
		return theme.fg("muted", theme.strikethrough(content));
	}
	if (status === "paused" || status === "pending") return theme.fg("muted", content);
	return theme.fg("text", content);
}

function styledRow(row: WidgetRow, theme: Theme): string {
	if (row.kind === "header") {
		return theme.fg("accent", theme.bold(row.title)) + theme.fg("accent", ` · ${row.metadata}`);
	}
	if (row.kind === "agent") {
		const descriptionColor = row.status === "completed" || row.status === "interrupted" ? "muted" : "text";
		return (
			theme.fg(STATUS_COLOR[row.status], `${AGENT_MARK[row.status]} ${row.status}`) +
			theme.fg("muted", " · ") +
			theme.fg("dim", row.id) +
			theme.fg("muted", " · ") +
			theme.fg(descriptionColor, row.description)
		);
	}
	if (row.kind === "status") {
		return `${theme.fg(STATUS_COLOR[row.status], statusMark(row.status))} ${styledBody(row.status, row.content, theme)}`;
	}
	if (row.kind === "objective") {
		return `${theme.fg("accent", "Objective:")} ${styledBody(row.phase, row.content, theme)}`;
	}
	return `${theme.fg("error", `Blocker: ${row.code}`)}${theme.fg("text", `: ${row.message}`)}`;
}

export class ProgressWidgetComponent implements Component {
	readonly #state: ProgressWidgetState;
	readonly #view: ProgressWidgetView;
	readonly #theme: Theme;

	constructor(state: ProgressWidgetState, view: ProgressWidgetView, theme: Theme) {
		this.#state = state;
		this.#view = view;
		this.#theme = theme;
	}

	render(width: number): string[] {
		const safeWidth = Math.max(1, width);
		const lines = progressWidgetRows(this.#state, this.#view).map((row) => styledRow(row, this.#theme));
		if (this.#view === "compact") return lines.map((line) => truncateToWidth(line, safeWidth));
		return lines.flatMap((line) => wrapTextWithAnsi(line, safeWidth));
	}

	invalidate(): void {
		// Theme segments are resolved from the live Theme proxy on every render; no styled output is cached.
	}
}

export function applySnapshot(state: ProgressWidgetState, snapshot: ProgressWidgetSnapshotV1): ProgressWidgetState {
	if (snapshot.source === "goal") return { ...state, goal: snapshot.goal };
	if (snapshot.source === "todo") return { ...state, todos: snapshot.todos };
	return { ...state, agents: snapshot.agents };
}
