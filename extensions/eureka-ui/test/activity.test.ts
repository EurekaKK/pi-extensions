import { describe, expect, it } from "vitest";
import { ActivityTracker, activityLineText } from "../src/activity.js";

describe("eureka-ui activity tracker", () => {
	it("reports running tools with a (+N) tail", () => {
		const tracker = new ActivityTracker();
		tracker.start("1", "bash", { command: "npm test" }, 0);
		tracker.start("2", "read", { path: "src/auth.ts" }, 0);
		tracker.start("3", "grep", { pattern: "token" }, 0);

		const state = tracker.snapshot();
		expect(state.kind).toBe("running");
		expect(activityLineText(state)).toBe("Running npm test, src/auth.ts… (+1)");
	});

	it("replaces running tools with a finished summary", () => {
		const tracker = new ActivityTracker();
		tracker.start("1", "bash", { command: "npm test" }, 100);
		tracker.end("1", false, { content: [{ type: "text", text: "ok\nsecond line" }] }, 400);

		const state = tracker.snapshot();
		expect(state.kind).toBe("ran");
		expect(activityLineText(state)).toBe("Ran npm test · 0.3s");
	});

	it("keeps a failure visible across settle until the user speaks", () => {
		const tracker = new ActivityTracker();
		tracker.start("1", "bash", { command: "npm test" }, 0);
		tracker.end("1", true, { content: [{ type: "text", text: "boom\n\nCommand exited with code 1" }] }, 200);

		tracker.settle();
		const state = tracker.snapshot();
		expect(state.kind).toBe("failed");
		expect(activityLineText(state)).toBe("Failed npm test · exit 1");

		tracker.clear();
		expect(activityLineText(tracker.snapshot())).toBeUndefined();
	});

	it("clears a successful summary when the agent settles", () => {
		const tracker = new ActivityTracker();
		tracker.start("1", "read", { path: "src/index.ts" }, 0);
		tracker.end("1", false, { content: [{ type: "text", text: "a" }] }, 50);
		expect(tracker.snapshot().kind).toBe("ran");

		tracker.settle();
		expect(activityLineText(tracker.snapshot())).toBeUndefined();
	});

	it("ignores ends for unknown tool calls and resets cleanly", () => {
		const tracker = new ActivityTracker();
		tracker.end("ghost", false, undefined, 10);
		expect(activityLineText(tracker.snapshot())).toBeUndefined();

		tracker.start("1", "bash", { command: "sleep 1" }, 0);
		tracker.reset();
		expect(activityLineText(tracker.snapshot())).toBeUndefined();
	});
});
