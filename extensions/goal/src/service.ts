import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GOAL_CHANGE_ENTRY_TYPE, GOAL_ROUND_ENTRY_TYPE } from "./constants.js";
import {
	buildView,
	foldGoalEntries,
	type GoalActivation,
	type GoalBlockReason,
	type GoalChange,
	GoalError,
	type GoalRef,
	type GoalRoundEntryV1,
	type GoalServiceState,
	type GoalSnapshot,
	type GoalView,
	normalizeBlockReason,
	normalizeMaxGoalRounds,
	normalizeObjective,
} from "./domain.js";

export class GoalService {
	readonly #pi: Pick<ExtensionAPI, "appendEntry">;
	readonly #defaultMaxGoalRounds: number;
	readonly #activation = new Map<string, GoalActivation>();
	readonly #now: () => number;

	constructor(pi: Pick<ExtensionAPI, "appendEntry">, defaultMaxGoalRounds: number, now: () => number = Date.now) {
		this.#pi = pi;
		this.#defaultMaxGoalRounds = defaultMaxGoalRounds;
		this.#now = now;
	}

	state(context: Pick<ExtensionContext, "sessionManager">): GoalServiceState {
		return foldGoalEntries(context.sessionManager.getBranch()).state;
	}

	activation(sessionId: string): GoalActivation {
		return this.#activation.get(sessionId) ?? "disarmed";
	}

	get(context: Pick<ExtensionContext, "sessionManager">): GoalView | undefined {
		return buildView(this.state(context), this.activation(context.sessionManager.getSessionId()));
	}

	disarm(sessionId: string): void {
		this.#activation.set(sessionId, "disarmed");
	}

	create(context: Pick<ExtensionContext, "sessionManager">, objective: string, maxGoalRounds?: number): GoalView {
		const state = this.state(context);
		if (state.goal !== undefined && state.goal.phase !== "complete") {
			throw new GoalError(
				`goal "${state.goal.id}" already exists with phase "${state.goal.phase}"`,
				"GOAL_ALREADY_EXISTS",
			);
		}
		const now = this.#now();
		const goal: GoalSnapshot = {
			id: `goal-${randomUUID()}`,
			revision: 1,
			objective: normalizeObjective(objective),
			phase: "active",
			maxGoalRounds: normalizeMaxGoalRounds(maxGoalRounds ?? this.#defaultMaxGoalRounds),
		};
		return this.#commitSnapshot(context, "create", goal, 0, now, now, "armed");
	}

	edit(
		context: Pick<ExtensionContext, "sessionManager">,
		ref: GoalRef,
		objective?: string,
		maxGoalRounds?: number,
	): GoalView {
		const state = this.state(context);
		const current = this.#expectCurrent(state, ref);
		if (objective === undefined && maxGoalRounds === undefined) {
			throw new GoalError("goal edit requires objective and/or maxGoalRounds", "GOAL_INVALID_EDIT");
		}
		const goal: GoalSnapshot = {
			...current,
			revision: current.revision + 1,
			...(objective === undefined ? {} : { objective: normalizeObjective(objective) }),
			...(maxGoalRounds === undefined ? {} : { maxGoalRounds: normalizeMaxGoalRounds(maxGoalRounds) }),
		};
		return this.#commitCurrent(context, state, "edit", goal, this.activation(context.sessionManager.getSessionId()));
	}

	pause(context: Pick<ExtensionContext, "sessionManager">, ref: GoalRef): GoalView {
		return this.#transition(context, ref, "pause", ["active"], "paused", "disarmed");
	}

	resume(context: Pick<ExtensionContext, "sessionManager">, ref: GoalRef): GoalView {
		const state = this.state(context);
		const current = this.#expectCurrent(state, ref);
		if (current.phase !== "active" && current.phase !== "paused" && current.phase !== "blocked") {
			throw new GoalError(`cannot resume goal from phase "${current.phase}"`, "GOAL_INVALID_TRANSITION");
		}
		if (current.phase === "active" && this.activation(context.sessionManager.getSessionId()) === "armed") {
			throw new GoalError(`goal "${current.id}" is already active and armed`, "GOAL_INVALID_TRANSITION");
		}
		if (state.roundsStarted >= current.maxGoalRounds) {
			throw new GoalError(
				`goal "${current.id}" exhausted ${current.maxGoalRounds} goal rounds; increase maxGoalRounds before resuming`,
				"GOAL_INVALID_TRANSITION",
			);
		}
		return this.#commitCurrent(
			context,
			state,
			"resume",
			{
				id: current.id,
				revision: current.revision + 1,
				objective: current.objective,
				phase: "active",
				maxGoalRounds: current.maxGoalRounds,
			},
			"armed",
		);
	}

	complete(context: Pick<ExtensionContext, "sessionManager">, ref: GoalRef): GoalView {
		return this.#transition(context, ref, "complete", ["active", "paused", "blocked"], "complete", "disarmed");
	}

	block(context: Pick<ExtensionContext, "sessionManager">, ref: GoalRef, reason: GoalBlockReason): GoalView {
		const state = this.state(context);
		const current = this.#expectCurrent(state, ref);
		if (current.phase !== "active")
			throw new GoalError("only an active goal can be blocked", "GOAL_INVALID_TRANSITION");
		return this.#commitCurrent(
			context,
			state,
			"block",
			{
				...current,
				revision: current.revision + 1,
				phase: "blocked",
				blockedReason: normalizeBlockReason(reason),
			},
			"disarmed",
		);
	}

	clear(context: Pick<ExtensionContext, "sessionManager">, ref: GoalRef): GoalRef {
		const state = this.state(context);
		const current = this.#expectCurrent(state, ref);
		const cleared: GoalRef = { id: current.id, revision: current.revision + 1 };
		const change: GoalChange = {
			kind: "goal/change",
			version: 1,
			operation: "clear",
			cleared,
			clearedAt: this.#now(),
		};
		this.#pi.appendEntry(GOAL_CHANGE_ENTRY_TYPE, change);
		this.#activation.set(context.sessionManager.getSessionId(), "disarmed");
		return { ...cleared };
	}

	admitRound(_context: Pick<ExtensionContext, "sessionManager">, goal: GoalView, round: number): void {
		const entry: GoalRoundEntryV1 = { version: 1, goalId: goal.id, revision: goal.revision, round };
		this.#pi.appendEntry(GOAL_ROUND_ENTRY_TYPE, entry);
	}

	#expectCurrent(state: GoalServiceState, ref: GoalRef): GoalSnapshot {
		const current = state.goal;
		if (current === undefined) throw new GoalError("no current goal", "GOAL_NOT_FOUND");
		if (ref.id !== current.id || ref.revision !== current.revision) {
			throw new GoalError(
				`stale goal ref "${ref.id}" revision ${ref.revision}; current is "${current.id}" revision ${current.revision}`,
				"GOAL_STALE_REVISION",
			);
		}
		return current;
	}

	#transition(
		context: Pick<ExtensionContext, "sessionManager">,
		ref: GoalRef,
		operation: "pause" | "complete",
		allowed: readonly GoalSnapshot["phase"][],
		phase: GoalSnapshot["phase"],
		activation: GoalActivation,
	): GoalView {
		const state = this.state(context);
		const current = this.#expectCurrent(state, ref);
		if (!allowed.includes(current.phase)) {
			throw new GoalError("invalid goal phase transition", "GOAL_INVALID_TRANSITION");
		}
		return this.#commitCurrent(
			context,
			state,
			operation,
			{ ...current, revision: current.revision + 1, phase },
			activation,
		);
	}

	#commitCurrent(
		context: Pick<ExtensionContext, "sessionManager">,
		state: GoalServiceState,
		operation: "edit" | "pause" | "resume" | "complete" | "block",
		goal: GoalSnapshot,
		activation: GoalActivation,
	): GoalView {
		if (state.createdAt === undefined || state.updatedAt === undefined) throw new Error("goal state lacks timestamps");
		return this.#commitSnapshot(
			context,
			operation,
			goal,
			state.roundsStarted,
			state.createdAt,
			Math.max(this.#now(), state.updatedAt),
			activation,
		);
	}

	#commitSnapshot(
		context: Pick<ExtensionContext, "sessionManager">,
		operation: "create" | "edit" | "pause" | "resume" | "complete" | "block",
		goal: GoalSnapshot,
		roundsStarted: number,
		createdAt: number,
		updatedAt: number,
		activation: GoalActivation,
	): GoalView {
		const change: GoalChange = {
			kind: "goal/change",
			version: 1,
			operation,
			goal,
			roundsStarted,
			createdAt,
			updatedAt,
		};
		this.#pi.appendEntry(GOAL_CHANGE_ENTRY_TYPE, change);
		this.#activation.set(context.sessionManager.getSessionId(), activation);
		const view = this.get(context);
		if (view === undefined) throw new Error("goal commit unexpectedly cleared the goal");
		return view;
	}
}
