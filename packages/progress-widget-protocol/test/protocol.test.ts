import { describe, expect, it } from "vitest";
import { parseProgressWidgetAttach, parseProgressWidgetRelease, parseProgressWidgetSnapshot } from "../src/index.js";

describe("progress widget protocol", () => {
	it("accepts versioned ownership messages", () => {
		expect(parseProgressWidgetAttach({ version: 1, sessionId: "session-1" })).toEqual({
			version: 1,
			sessionId: "session-1",
		});
		expect(parseProgressWidgetRelease({ version: 1, sessionId: "session-1" })).toEqual({
			version: 1,
			sessionId: "session-1",
		});
	});

	it("rejects malformed ownership messages", () => {
		expect(parseProgressWidgetAttach({ version: 2, sessionId: "session-1" })).toBeNull();
		expect(parseProgressWidgetAttach({ version: 1, sessionId: "" })).toBeNull();
		expect(parseProgressWidgetAttach({ version: 1, sessionId: "session-1", extra: true })).toBeNull();
	});

	it("parses goal, todo, and sub-agent snapshots", () => {
		expect(
			parseProgressWidgetSnapshot({
				version: 1,
				source: "goal",
				sessionId: "session-1",
				goal: {
					id: "goal-1",
					objective: "Ship it",
					phase: "blocked",
					roundsStarted: 2,
					maxGoalRounds: 4,
					activation: "disarmed",
					blockedReason: { code: "dependency", message: "Waiting" },
				},
			}),
		).toMatchObject({ source: "goal", goal: { id: "goal-1", phase: "blocked" } });

		expect(
			parseProgressWidgetSnapshot({
				version: 1,
				source: "todo",
				sessionId: "session-1",
				todos: [{ content: "Implement", status: "in_progress" }],
			}),
		).toMatchObject({ source: "todo", todos: [{ content: "Implement", status: "in_progress" }] });

		expect(
			parseProgressWidgetSnapshot({
				version: 1,
				source: "sub-agent",
				sessionId: "session-1",
				agents: [{ id: "child-1", description: "Review", status: "interrupting" }],
			}),
		).toMatchObject({ source: "sub-agent", agents: [{ id: "child-1", status: "interrupting" }] });
	});

	it("accepts a goal whose edited round limit is below rounds already started", () => {
		expect(
			parseProgressWidgetSnapshot({
				version: 1,
				source: "goal",
				sessionId: "session-1",
				goal: {
					id: "goal-1",
					objective: "Ship it",
					phase: "paused",
					roundsStarted: 3,
					maxGoalRounds: 2,
					activation: "disarmed",
				},
			}),
		).toMatchObject({ goal: { roundsStarted: 3, maxGoalRounds: 2 } });
	});

	it("rejects malformed or unknown snapshots", () => {
		expect(
			parseProgressWidgetSnapshot({
				version: 1,
				source: "todo",
				sessionId: "session-1",
				todos: [{ content: "", status: "pending" }],
			}),
		).toBeNull();
		expect(
			parseProgressWidgetSnapshot({
				version: 1,
				source: "sub-agent",
				sessionId: "session-1",
				agents: [{ id: "child-1", description: "Review", status: "ready" }],
			}),
		).toBeNull();
		expect(parseProgressWidgetSnapshot({ version: 1, source: "unknown", sessionId: "session-1" })).toBeNull();
	});
});
