import { describe, expect, it } from "vitest";
import {
	applyGoalChange,
	applyGoalRound,
	emptyGoalState,
	type GoalChange,
	parseGoalChange,
	parseGoalRound,
} from "../src/domain.js";

function createChange(): GoalChange {
	return {
		kind: "goal/change",
		version: 1,
		operation: "create",
		goal: { id: "goal-1", revision: 1, objective: "ship it", phase: "active", maxGoalRounds: 3 },
		roundsStarted: 0,
		createdAt: 10,
		updatedAt: 10,
	};
}

describe("goal v2 domain", () => {
	it("folds create, pause, resume, complete and clear transitions", () => {
		const state = emptyGoalState();
		applyGoalChange(state, createChange());
		expect(state.goal?.phase).toBe("active");

		applyGoalChange(state, {
			kind: "goal/change",
			version: 1,
			operation: "pause",
			goal: { id: "goal-1", revision: 2, objective: "ship it", phase: "paused", maxGoalRounds: 3 },
			roundsStarted: 0,
			createdAt: 10,
			updatedAt: 11,
		});
		expect(state.goal?.phase).toBe("paused");

		applyGoalChange(state, {
			kind: "goal/change",
			version: 1,
			operation: "resume",
			goal: { id: "goal-1", revision: 3, objective: "ship it", phase: "active", maxGoalRounds: 3 },
			roundsStarted: 0,
			createdAt: 10,
			updatedAt: 12,
		});
		expect(state.goal?.phase).toBe("active");

		applyGoalChange(state, {
			kind: "goal/change",
			version: 1,
			operation: "complete",
			goal: { id: "goal-1", revision: 4, objective: "ship it", phase: "complete", maxGoalRounds: 3 },
			roundsStarted: 0,
			createdAt: 10,
			updatedAt: 13,
		});
		expect(state.goal?.phase).toBe("complete");

		applyGoalChange(state, {
			kind: "goal/change",
			version: 1,
			operation: "clear",
			cleared: { id: "goal-1", revision: 5 },
			clearedAt: 14,
		});
		expect(state.goal).toBeUndefined();
		expect(state.lastRef).toEqual({ id: "goal-1", revision: 5 });
	});

	it("folds admitted goal rounds in order", () => {
		const state = emptyGoalState();
		applyGoalChange(state, createChange());
		applyGoalRound(state, { version: 1, goalId: "goal-1", revision: 1, round: 1 });
		applyGoalRound(state, { version: 1, goalId: "goal-1", revision: 1, round: 2 });
		expect(state.roundsStarted).toBe(2);
		expect(() => applyGoalRound(state, { version: 1, goalId: "goal-1", revision: 1, round: 4 })).toThrow();
	});

	it("rejects stale revisions and invalid transitions", () => {
		const state = emptyGoalState();
		applyGoalChange(state, createChange());
		expect(() =>
			applyGoalChange(state, {
				kind: "goal/change",
				version: 1,
				operation: "pause",
				goal: { id: "goal-1", revision: 3, objective: "ship it", phase: "paused", maxGoalRounds: 3 },
				roundsStarted: 0,
				createdAt: 10,
				updatedAt: 11,
			}),
		).toThrow(/advance/);
	});

	it("parses change and round entries", () => {
		expect(parseGoalChange(createChange())).toMatchObject({ status: "valid" });
		expect(parseGoalChange({ kind: "goal/change", version: 1 })).toEqual({ status: "invalid" });
		expect(parseGoalRound({ version: 1, goalId: "g", revision: 1, round: 1 })).toEqual({
			version: 1,
			goalId: "g",
			revision: 1,
			round: 1,
		});
		expect(parseGoalRound({ version: 1, goalId: "g", revision: 0, round: 1 })).toBeNull();
	});
});
