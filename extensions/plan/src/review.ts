import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { foldTodoSnapshots } from "todo-protocol";
import { approveFlow, cancelFlow, type PlanCommandRuntime, reviseFlow } from "./commands.js";

/**
 * 审阅 UI 时机：plan_submit 的工具执行独立于人类 UI 并立即返回；只有包含该次
 * 成功提交的低层 run 结束时（agent_end）才在 TUI 打开一次 focused overlay，
 * RPC 使用等价的 select/editor 请求。JSON/print 不打开任何 UI。
 */
export function registerReviewFlow(
	pi: ExtensionAPI,
	runtime: PlanCommandRuntime,
	pendingReview: () => { readonly planId: string; readonly revision: number } | undefined,
	clearPendingReview: () => void,
): void {
	pi.on("agent_end", async (_event, context) => {
		const pending = pendingReview();
		if (pending === undefined) return;
		clearPendingReview();
		if (!context.hasUI) return;
		const state = runtime.service.state(context);
		if (
			state.active?.planId !== pending.planId ||
			state.active.phase !== "reviewing" ||
			state.active.revision !== pending.revision
		) {
			return;
		}
		const proposal = state.proposalsByRef.get(`${pending.planId}#${pending.revision}`);
		if (proposal === undefined) return;
		const replaceWarning =
			foldTodoSnapshots(context.sessionManager.getBranch()).todos.length > 0
				? `⚠ Approval replaces the current Todo list.`
				: undefined;
		if (context.mode === "tui") {
			const result = await context.ui.custom<string | null>(
				(_tui, theme, _keybindings, done) =>
					new PlanReviewOverlay({
						proposal,
						theme,
						...(replaceWarning === undefined ? {} : { replaceWarning }),
						onDone: (action) => done(action),
					}),
				{ overlay: true },
			);
			await dispatchReviewAction(runtime, context, asReviewAction(result));
		} else if (context.mode === "rpc") {
			const choice = await context.ui.select("Plan review", ["Approve & execute", "Revise", "Cancel"]);
			let feedback: string | undefined;
			if (choice === "Revise") {
				feedback = (await context.ui.editor("Revision feedback (optional)", "")) ?? undefined;
			}
			await dispatchReviewAction(
				runtime,
				context,
				choice === "Approve & execute"
					? "approve"
					: choice === "Revise"
						? "revise"
						: choice === "Cancel"
							? "cancel"
							: null,
				feedback,
			);
		}
	});
}

function asReviewAction(value: string | null): "approve" | "revise" | "cancel" | null {
	if (value === "approve" || value === "revise" || value === "cancel" || value === null) return value;
	return null;
}

async function dispatchReviewAction(
	runtime: PlanCommandRuntime,
	context: ExtensionContext,
	action: "approve" | "revise" | "cancel" | null,
	feedback?: string,
): Promise<void> {
	if (action === null) return;
	try {
		if (action === "approve") {
			runtime.notify(context, approveFlow(runtime, context), "info");
		} else if (action === "revise") {
			runtime.notify(context, reviseFlow(runtime, context, feedback), "info");
		} else {
			runtime.notify(context, cancelFlow(runtime, context), "info");
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		runtime.notify(context, `Plan review action failed: ${message}`, "error");
	}
}

interface PlanReviewOverlayOptions {
	readonly proposal: {
		readonly planId: string;
		readonly revision: number;
		readonly objective: string;
		readonly steps: readonly { readonly stepId: string; readonly title: string; readonly details: string }[];
	};
	readonly theme: Theme;
	readonly replaceWarning?: string;
	readonly onDone: (action: "approve" | "revise" | "cancel" | null) => void;
}

class PlanReviewOverlay implements Component {
	readonly #options: PlanReviewOverlayOptions;
	#index = 0;
	#scroll: number;

	constructor(options: PlanReviewOverlayOptions) {
		this.#options = options;
		this.#scroll = 0;
	}

	render(width: number): string[] {
		const { proposal, theme } = this.#options;
		const { planId, revision, objective } = proposal;
		const steps = proposal.steps;
		const selected = steps[this.#index];
		const safe = Math.max(1, width);
		const lines: string[] = [];
		lines.push(
			truncateToWidth(
				theme.fg(
					"accent",
					theme.bold(`Plan Review · ${planId} · revision ${revision} · step ${this.#index + 1}/${steps.length}`),
				),
				safe,
			),
		);
		lines.push(truncateToWidth(theme.fg("muted", `Objective: ${objective}`), safe));
		lines.push("");
		for (const [i, step] of steps.entries()) {
			const prefix = i === this.#index ? theme.fg("accent", "▸ ") : theme.fg("dim", "  ");
			const label = truncateToWidth(`${prefix}${step.title}`, safe);
			lines.push(i === this.#index ? theme.fg("text", label) : theme.fg("muted", label));
		}
		lines.push("");
		if (selected !== undefined) {
			const detailLines = selected.details.split("\n");
			const budget = 12;
			const start = Math.min(this.#scroll, Math.max(0, detailLines.length - budget));
			for (const line of detailLines.slice(start, start + budget)) {
				lines.push(truncateToWidth(theme.fg("muted", line), safe));
			}
		}
		lines.push("");
		lines.push(
			truncateToWidth(theme.fg("dim", "↑↓ navigate · a approve · r revise · c cancel · esc close (no change)"), safe),
		);
		return lines;
	}

	handleInput(data: string): void {
		const { proposal, onDone } = this.#options;
		const steps = proposal.steps;
		if (matchesKey(data, Key.up)) {
			if (this.#index > 0) {
				this.#index -= 1;
				this.#scroll = 0;
			}
			return;
		}
		if (matchesKey(data, Key.down)) {
			if (this.#index < steps.length - 1) {
				this.#index += 1;
				this.#scroll = 0;
			}
			return;
		}
		if (matchesKey(data, Key.escape)) {
			onDone(null);
			return;
		}
		if (data === "a" || data === "A") {
			onDone("approve");
			return;
		}
		if (data === "r" || data === "R") {
			onDone("revise");
			return;
		}
		if (data === "c" || data === "C") {
			onDone("cancel");
		}
	}

	invalidate(): void {}
}
