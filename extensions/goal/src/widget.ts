import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { GOAL_STATUS_KEY } from "./constants.js";
import type { GoalPhase, GoalView } from "./domain.js";

const PHASE_MARK: Readonly<Record<GoalPhase, string>> = Object.freeze({
	active: "◐",
	paused: "Ⅱ",
	blocked: "!",
	complete: "✓",
});

function phaseColor(phase: GoalPhase): "warning" | "muted" | "error" | "success" {
	switch (phase) {
		case "active":
			return "warning";
		case "paused":
			return "muted";
		case "blocked":
			return "error";
		case "complete":
			return "success";
	}
}

export function buildGoalWidgetLines(view: GoalView): string[] {
	const reason = view.blockedReason === undefined ? "" : ` · ${view.blockedReason.code}`;
	return [
		`Goal · ${view.phase} · round ${view.roundsStarted}/${view.maxGoalRounds} · ${view.activation}${reason}`,
		`${PHASE_MARK[view.phase]} ${view.objective}`,
	];
}

export class GoalWidgetComponent implements Component {
	readonly #view: GoalView;
	readonly #theme: Theme;

	constructor(view: GoalView, theme: Theme) {
		this.#view = view;
		this.#theme = theme;
	}

	render(width: number): string[] {
		const lines = buildGoalWidgetLines(this.#view);
		const header = this.#theme.fg("accent", this.#theme.bold(lines[0] ?? "Goal"));
		const mark = this.#theme.fg(phaseColor(this.#view.phase), PHASE_MARK[this.#view.phase]);
		const objective =
			this.#view.phase === "complete"
				? this.#theme.fg("muted", this.#theme.strikethrough(this.#view.objective))
				: this.#theme.fg("text", this.#view.objective);
		return [header, `${mark} ${objective}`].map((line) => truncateToWidth(line, Math.max(1, width)));
	}

	invalidate(): void {}
}

export function projectGoalWidget(context: ExtensionContext, view: GoalView | undefined): void {
	if (!context.hasUI || (context.mode !== "tui" && context.mode !== "rpc")) return;
	if (view === undefined) {
		context.ui.setWidget(GOAL_STATUS_KEY, undefined, { placement: "aboveEditor" });
		return;
	}
	if (context.mode === "tui") {
		context.ui.setWidget(GOAL_STATUS_KEY, (_tui, theme) => new GoalWidgetComponent(view, theme), {
			placement: "aboveEditor",
		});
		return;
	}
	context.ui.setWidget(GOAL_STATUS_KEY, buildGoalWidgetLines(view), { placement: "aboveEditor" });
}

export function tryProjectGoalWidget(context: ExtensionContext, view: GoalView | undefined): boolean {
	try {
		projectGoalWidget(context, view);
		return true;
	} catch {
		return false;
	}
}
