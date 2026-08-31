import type { ExtensionAPI, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import type { PlanConfigV1 } from "./config.js";
import { PLAN_DEFAULT_ALLOWLIST } from "./constants.js";

const GATE_REASON =
	"planning: workspace mutations and unapproved tools are disabled while the plan workflow is active (use /plan approve, /plan revise, /plan cancel, or /plan retry).";

function notify(
	context: { readonly hasUI?: boolean; readonly ui?: { notify(message: string, level?: string): void } },
	message: string,
): void {
	if (!context.hasUI) return;
	try {
		context.ui?.notify(message, "warning");
	} catch {
		// Advisory only.
	}
}

/**
 * Planning Mode 工具策略：fail-closed allowlist + 第二道 tool_call 守卫。
 * 仅接受默认只读名单与部署者显式追加的只读工具；未知工具一律阻断。
 */
export class PlanGate {
	readonly #pi: ExtensionAPI;
	readonly #config: PlanConfigV1;
	#active = false;
	#toolsBefore: string[] | undefined;
	#allowSet: ReadonlySet<string> | undefined;
	#warnedMissing: boolean = false;
	#warnedSubagentPlan: boolean = false;

	constructor(pi: ExtensionAPI, config: PlanConfigV1) {
		this.#pi = pi;
		this.#config = config;
	}

	get active(): boolean {
		return this.#active;
	}

	/** 计算该运行时当前注册工具下的 allowlist 并在必要时提示缺失的配置项。 */
	#resolveAllowSet(context: {
		readonly hasUI?: boolean;
		readonly ui?: { notify(message: string, level?: string): void };
	}): ReadonlySet<string> {
		const registered = new Set(this.#pi.getAllTools().map((tool) => tool.name));
		const candidates = [...PLAN_DEFAULT_ALLOWLIST, ...this.#config.additionalReadOnlyTools];
		const allow = new Set(candidates.filter((name) => registered.has(name)));
		if (!this.#warnedMissing) {
			const missing = this.#config.additionalReadOnlyTools.filter((name) => !registered.has(name));
			if (missing.length > 0) {
				this.#warnedMissing = true;
				notify(context, `Planning allowlist skipped unregistered tools: ${missing.join(", ")}`);
			}
		}
		if (!this.#warnedSubagentPlan && !registered.has("subagent_plan")) {
			this.#warnedSubagentPlan = true;
			notify(context, "subagent_plan is not registered; planning continues without delegated research.");
		}
		return allow;
	}

	apply(context: { readonly hasUI?: boolean; readonly ui?: { notify(message: string, level?: string): void } }): void {
		if (this.#active) return;
		this.#allowSet = this.#resolveAllowSet(context);
		this.#toolsBefore = this.#pi.getActiveTools();
		try {
			this.#pi.setActiveTools([...this.#allowSet]);
		} catch {
			// 工具集切换失败不改变门禁语义；tool_call 守卫仍然生效。
		}
		this.#active = true;
	}

	restore(): void {
		if (!this.#active) return;
		const registered = new Set(this.#pi.getAllTools().map((tool) => tool.name));
		const restored = (this.#toolsBefore ?? []).filter((name) => registered.has(name));
		try {
			this.#pi.setActiveTools(restored);
		} catch {
			// Advisory: 恢复失败由 tool_call 守卫兜底（此时守卫已随 active=false 关闭）。
		}
		this.#toolsBefore = undefined;
		this.#active = false;
	}

	reset(): void {
		this.#toolsBefore = undefined;
		this.#active = false;
	}

	allows(toolName: string): boolean {
		return this.#allowSet?.has(toolName) ?? false;
	}

	/** 第二道守卫：即使其他 extension 重新激活被禁工具，这里仍然阻断。 */
	registerGuard(pi: ExtensionAPI): void {
		pi.on("tool_call", (event): ToolCallEventResult | undefined => {
			if (!this.#active) return undefined;
			if (this.allows(event.toolName)) return undefined;
			return { block: true, reason: GATE_REASON };
		});
	}
}
