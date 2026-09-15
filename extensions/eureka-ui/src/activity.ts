import {
	type ActivityToolLike,
	failureDetail,
	formatActivityFailed,
	formatActivityRan,
	formatActivityRunning,
	type ToolResultLike,
} from "./format.js";

interface RunningTool extends ActivityToolLike {
	readonly toolCallId: string;
	readonly startedAt: number;
}

interface FinishedTool extends ActivityToolLike {
	readonly durationMs: number;
}

export type ActivityState =
	| { readonly kind: "idle" }
	| { readonly kind: "running"; readonly tools: readonly ActivityToolLike[] }
	| { readonly kind: "ran"; readonly tool: FinishedTool }
	| { readonly kind: "failed"; readonly tool: ActivityToolLike; readonly detail?: string };

/**
 * Session-scoped activity state for the pinned line.
 *
 * - running tools win while any tool executes
 * - a failure stays visible until the next user message
 * - a successful summary survives until the agent settles
 */
export class ActivityTracker {
	readonly #running = new Map<string, RunningTool>();
	#finished: FinishedTool | undefined;
	#failure: { readonly tool: ActivityToolLike; readonly detail?: string } | undefined;

	start(toolCallId: string, toolName: string, args: unknown, now: number): void {
		this.#running.set(toolCallId, { toolCallId, toolName, args, startedAt: now });
	}

	end(toolCallId: string, isError: boolean, result: ToolResultLike | undefined, now: number): void {
		const running = this.#running.get(toolCallId);
		if (running === undefined) return;
		this.#running.delete(toolCallId);
		const tool: ActivityToolLike = { toolName: running.toolName, args: running.args };
		if (isError) {
			const detail = failureDetail(result);
			this.#failure = detail === undefined ? { tool } : { tool, detail };
			return;
		}
		this.#finished = { ...tool, durationMs: Math.max(0, now - running.startedAt) };
	}

	/** The agent stopped; a pending failure keeps its place until the user speaks. */
	settle(): void {
		this.#finished = undefined;
	}

	/** A new user message clears the previous failure. */
	clear(): void {
		this.#failure = undefined;
		this.#finished = undefined;
	}

	reset(): void {
		this.#running.clear();
		this.clear();
	}

	snapshot(): ActivityState {
		if (this.#running.size > 0) {
			return { kind: "running", tools: [...this.#running.values()] };
		}
		if (this.#failure !== undefined) {
			return this.#failure.detail === undefined
				? { kind: "failed", tool: this.#failure.tool }
				: { kind: "failed", tool: this.#failure.tool, detail: this.#failure.detail };
		}
		if (this.#finished !== undefined) return { kind: "ran", tool: this.#finished };
		return { kind: "idle" };
	}
}

/** One plain-text line for the state, or undefined when the line stays empty. */
export function activityLineText(state: ActivityState): string | undefined {
	switch (state.kind) {
		case "idle":
			return undefined;
		case "running": {
			const text = formatActivityRunning(state.tools);
			return text.length === 0 ? undefined : text;
		}
		case "ran":
			return formatActivityRan(state.tool, state.tool.durationMs);
		case "failed":
			return formatActivityFailed(state.tool, state.detail);
	}
}
