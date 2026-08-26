import type { Theme } from "@earendil-works/pi-coding-agent";
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

function goalHeader(goal: ProgressWidgetGoalStateV1): string {
	const blocker = goal.blockedReason === undefined ? "" : ` · ${goal.blockedReason.code}`;
	return `Goal · ${goal.phase} · round ${goal.roundsStarted}/${goal.maxGoalRounds} · ${goal.activation}${blocker}`;
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

function compactLines(state: ProgressWidgetState): string[] {
	const lines: string[] = [];
	const agents = visibleAgents(state.agents);
	if (agents.length > 0) {
		const counts = agentCounts(agents);
		lines.push(
			`Subagents · ${counts.running} running · ${counts.interrupting} interrupting · ${counts.completed} completed · ${counts.interrupted} interrupted · ${counts.failed} failed`,
		);
	}
	if (state.todos.length > 0) {
		const counts = todoCounts(state.todos);
		lines.push(`Todos · ${counts.inProgress} in progress · ${counts.pending} pending · ${counts.completed} completed`);
		const first =
			state.todos.find((todo) => todo.status === "in_progress") ??
			state.todos.find((todo) => todo.status === "pending");
		if (first !== undefined) lines.push(`${TODO_MARK[first.status]} ${first.content}`);
	}
	if (state.goal !== null) {
		lines.push(goalHeader(state.goal), `${GOAL_MARK[state.goal.phase]} ${state.goal.objective}`);
	}
	return lines;
}

function fullLines(state: ProgressWidgetState): string[] {
	const lines: string[] = [];
	const agents = visibleAgents(state.agents);
	if (agents.length > 0) {
		const counts = agentCounts(agents);
		lines.push(
			`Subagents · ${counts.running} running · ${counts.interrupting} interrupting · ${counts.completed} completed · ${counts.interrupted} interrupted · ${counts.failed} failed`,
		);
		for (const agent of agents) {
			lines.push(`${AGENT_MARK[agent.status]} ${agent.status} · ${agent.id} · ${agent.description}`);
		}
	}
	if (state.todos.length > 0) {
		const counts = todoCounts(state.todos);
		lines.push(`Todos · ${counts.inProgress} in progress · ${counts.pending} pending · ${counts.completed} completed`);
		for (const todo of state.todos) lines.push(`${TODO_MARK[todo.status]} ${todo.content}`);
	}
	if (state.goal !== null) {
		lines.push(goalHeader(state.goal), `Objective: ${state.goal.objective}`);
		if (state.goal.blockedReason !== undefined) {
			lines.push(`Blocker: ${state.goal.blockedReason.code}: ${state.goal.blockedReason.message}`);
		}
	}
	return lines;
}

export function buildProgressWidgetLines(state: ProgressWidgetState, view: ProgressWidgetView): string[] {
	return view === "compact" ? compactLines(state) : fullLines(state);
}

function styledLine(line: string, theme: Theme): string {
	if (line.startsWith("Goal ·") || line.startsWith("Subagents ·") || line.startsWith("Todos ·")) {
		return theme.fg("accent", theme.bold(line));
	}
	if (line.startsWith("! ") || line.startsWith("! failed") || line.startsWith("Blocker:")) {
		return theme.fg("error", line);
	}
	if (line.startsWith("✓ completed ·")) return theme.fg("success", line);
	if (line.startsWith("✓ ")) return theme.fg("muted", theme.strikethrough(line));
	if (line.startsWith("◐ ") || line.startsWith("◐ running")) return theme.fg("warning", line);
	if (line.startsWith("Ⅱ ") || line.startsWith("○ ") || line.startsWith("■ ")) return theme.fg("muted", line);
	return theme.fg("text", line);
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
		const lines = buildProgressWidgetLines(this.#state, this.#view).map((line) => styledLine(line, this.#theme));
		if (this.#view === "compact") return lines.map((line) => truncateToWidth(line, safeWidth));
		return lines.flatMap((line) => wrapTextWithAnsi(line, safeWidth));
	}

	invalidate(): void {}
}

export function applySnapshot(state: ProgressWidgetState, snapshot: ProgressWidgetSnapshotV1): ProgressWidgetState {
	if (snapshot.source === "goal") return { ...state, goal: snapshot.goal };
	if (snapshot.source === "todo") return { ...state, todos: snapshot.todos };
	return { ...state, agents: snapshot.agents };
}
