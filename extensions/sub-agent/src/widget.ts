import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { SUBAGENT_WIDGET_KEY } from "./constants.js";
import type { SubagentUiEntry } from "./runtime.js";

export function buildSubagentWidgetLines(agents: readonly SubagentUiEntry[]): string[] {
	if (!agents.some((agent) => agent.status === "running" || agent.status === "interrupting")) return [];
	const counts = { running: 0, interrupting: 0, completed: 0, interrupted: 0, failed: 0 };
	for (const agent of agents) counts[agent.status] += 1;
	return [
		`Subagents · ${counts.running} running · ${counts.interrupting} interrupting · ${counts.completed} completed · ${counts.interrupted} interrupted · ${counts.failed} failed`,
	];
}

class SubagentWidgetComponent implements Component {
	readonly #agents: readonly SubagentUiEntry[];
	readonly #theme: Theme;

	constructor(agents: readonly SubagentUiEntry[], theme: Theme) {
		this.#agents = agents;
		this.#theme = theme;
	}

	render(width: number): string[] {
		return buildSubagentWidgetLines(this.#agents).map((line) =>
			truncateToWidth(this.#theme.fg("accent", this.#theme.bold(line)), Math.max(1, width)),
		);
	}

	invalidate(): void {}
}

export function projectSubagentWidget(context: ExtensionContext, agents: readonly SubagentUiEntry[]): void {
	if (!context.hasUI || (context.mode !== "tui" && context.mode !== "rpc")) return;
	const lines = buildSubagentWidgetLines(agents);
	if (lines.length === 0) {
		context.ui.setWidget(SUBAGENT_WIDGET_KEY, undefined, { placement: "aboveEditor" });
		return;
	}
	if (context.mode === "tui") {
		context.ui.setWidget(SUBAGENT_WIDGET_KEY, (_tui, theme) => new SubagentWidgetComponent(agents, theme), {
			placement: "aboveEditor",
		});
		return;
	}
	context.ui.setWidget(SUBAGENT_WIDGET_KEY, lines, { placement: "aboveEditor" });
}

export function tryProjectSubagentWidget(context: ExtensionContext, agents: readonly SubagentUiEntry[]): boolean {
	try {
		projectSubagentWidget(context, agents);
		return true;
	} catch {
		return false;
	}
}
