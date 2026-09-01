import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import type { ProgressWidgetPlanStateV1 } from "progress-widget-protocol";
import { PLAN_WIDGET_KEY } from "./constants.js";

function planMetadata(plan: ProgressWidgetPlanStateV1): string {
	const phase = plan.phase.replaceAll("_", " ");
	const revision = plan.revision === undefined ? "" : ` · r${plan.revision}`;
	return `${phase} · ${plan.planId}${revision} · workspace mutations blocked`;
}

export function buildPlanWidgetLines(plan: ProgressWidgetPlanStateV1): string[] {
	return [`Plan · ${planMetadata(plan)}`];
}

export class PlanWidgetComponent implements Component {
	readonly #plan: ProgressWidgetPlanStateV1;
	readonly #theme: Theme;

	constructor(plan: ProgressWidgetPlanStateV1, theme: Theme) {
		this.#plan = plan;
		this.#theme = theme;
	}

	render(width: number): string[] {
		const line =
			this.#theme.fg("accent", this.#theme.bold("Plan")) + this.#theme.fg("accent", ` · ${planMetadata(this.#plan)}`);
		return [truncateToWidth(line, Math.max(1, width))];
	}

	invalidate(): void {
		// Theme segments are resolved from the live Theme proxy on every render.
	}
}

export function projectPlanWidget(context: ExtensionContext, plan: ProgressWidgetPlanStateV1 | null): void {
	if (!context.hasUI || (context.mode !== "tui" && context.mode !== "rpc")) return;
	if (plan === null) {
		context.ui.setWidget(PLAN_WIDGET_KEY, undefined, { placement: "aboveEditor" });
		return;
	}
	if (context.mode === "tui") {
		context.ui.setWidget(PLAN_WIDGET_KEY, (_tui, theme) => new PlanWidgetComponent(plan, theme), {
			placement: "aboveEditor",
		});
		return;
	}
	context.ui.setWidget(PLAN_WIDGET_KEY, buildPlanWidgetLines(plan), { placement: "aboveEditor" });
}

export function tryProjectPlanWidget(context: ExtensionContext, plan: ProgressWidgetPlanStateV1 | null): boolean {
	try {
		projectPlanWidget(context, plan);
		return true;
	} catch {
		return false;
	}
}
