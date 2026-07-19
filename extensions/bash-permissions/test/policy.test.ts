import { describe, expect, it } from "vitest";
import { type PolicySnapshot, validateRedConfig, validateYellowConfig } from "../src/config.js";
import {
	decideCommand,
	formatRedReason,
	formatYellowReason,
	normalizeCommand,
	YellowReviewState,
} from "../src/policy.js";

function makeSnapshot(): PolicySnapshot {
	return Object.freeze({
		yellowRules: validateYellowConfig(
			{
				version: 1,
				rules: [
					{
						name: "删除",
						pattern: "delete",
						type: "review",
						message: "删除有风险。",
					},
					{
						name: "建议",
						pattern: "danger",
						type: "suggest",
						message: "请使用安全形式。",
						suggestedCommand: "safe $1 command",
					},
				],
			},
			"/yellow.json",
			"/work",
			"/home",
		),
		redRules: validateRedConfig(
			{
				version: 1,
				rules: [
					{ name: "灾难一", pattern: "catastrophe", message: "停止一。" },
					{ name: "灾难二", pattern: "catastrophe|disaster", message: "停止二。" },
				],
			},
			"/red.json",
			"/work",
			"/home",
		),
	});
}

describe("command decisions", () => {
	it("lets green commands pass without changing them", () => {
		const reviews = new YellowReviewState();
		reviews.startResponse();
		expect(decideCommand("printf 'ok'", makeSnapshot(), reviews)).toEqual({ color: "green" });
	});

	it("returns every same-color match in configuration order", () => {
		const reviews = new YellowReviewState();
		reviews.startResponse();
		const decision = decideCommand("catastrophe", makeSnapshot(), reviews);

		expect(decision.color).toBe("red");
		if (decision.color === "red") {
			expect(decision.matches.map((rule) => rule.name)).toEqual(["灾难一", "灾难二"]);
		}
	});

	it("always gives red priority over yellow and never creates a yellow grant", () => {
		const snapshot = makeSnapshot();
		const reviews = new YellowReviewState();
		reviews.startResponse();
		const overlapping: PolicySnapshot = {
			yellowRules: validateYellowConfig(
				{
					version: 1,
					rules: [{ name: "黄色重叠", pattern: "catastrophe", type: "review", message: "黄" }],
				},
				"/yellow.json",
				"/work",
				"/home",
			),
			redRules: snapshot.redRules,
		};

		expect(decideCommand("catastrophe", overlapping, reviews).color).toBe("red");
		reviews.startResponse();
		const retried = decideCommand("catastrophe", overlapping, reviews);
		expect(retried.color).toBe("red");
	});

	it("does not truncate a long command before matching", () => {
		const reviews = new YellowReviewState();
		reviews.startResponse();
		const command = `${"x".repeat(200_000)} catastrophe`;
		expect(decideCommand(command, makeSnapshot(), reviews).color).toBe("red");
	}, 2_000);
});

describe("yellow review state", () => {
	it("blocks duplicates in the same response, then allows one identical retry in the next response", () => {
		const snapshot = makeSnapshot();
		const reviews = new YellowReviewState();
		reviews.startResponse();

		expect(decideCommand("delete file", snapshot, reviews)).toMatchObject({ color: "yellow", allowedByReview: false });
		expect(decideCommand("delete file", snapshot, reviews)).toMatchObject({ color: "yellow", allowedByReview: false });

		reviews.endResponse();
		reviews.startResponse();
		expect(decideCommand("delete file", snapshot, reviews)).toMatchObject({ color: "yellow", allowedByReview: true });
		expect(decideCommand("delete file", snapshot, reviews)).toMatchObject({ color: "yellow", allowedByReview: false });
	});

	it("expires a grant when the immediately following response does not retry it", () => {
		const snapshot = makeSnapshot();
		const reviews = new YellowReviewState();
		reviews.startResponse();
		decideCommand("delete file", snapshot, reviews);
		reviews.endResponse();

		reviews.startResponse();
		decideCommand("printf ok", snapshot, reviews);
		reviews.endResponse();
		reviews.startResponse();

		expect(decideCommand("delete file", snapshot, reviews)).toMatchObject({ color: "yellow", allowedByReview: false });
	});

	it("tracks different yellow commands independently", () => {
		const snapshot = makeSnapshot();
		const reviews = new YellowReviewState();
		reviews.startResponse();
		decideCommand("delete A", snapshot, reviews);
		decideCommand("delete B", snapshot, reviews);
		reviews.endResponse();
		reviews.startResponse();

		expect(decideCommand("delete B", snapshot, reviews)).toMatchObject({ allowedByReview: true });
		expect(decideCommand("delete A", snapshot, reviews)).toMatchObject({ allowedByReview: true });
	});

	it("normalizes only surrounding whitespace and CRLF", () => {
		expect(normalizeCommand("  first\r\nsecond  ")).toBe("first\nsecond");
		const reviews = new YellowReviewState();
		reviews.startResponse();
		expect(reviews.consumeOrCreate("  delete\r\nfile ")).toBe(false);
		reviews.endResponse();
		reviews.startResponse();
		expect(reviews.consumeOrCreate("delete\nfile")).toBe(true);

		reviews.startResponse();
		expect(reviews.consumeOrCreate("delete  file")).toBe(false);
		reviews.endResponse();
		reviews.startResponse();
		expect(reviews.consumeOrCreate("delete file")).toBe(false);
	});

	it("clears every grant on user or session reset", () => {
		const reviews = new YellowReviewState();
		reviews.startResponse();
		reviews.consumeOrCreate("delete A");
		reviews.consumeOrCreate("delete B");
		reviews.reset();
		reviews.startResponse();

		expect(reviews.consumeOrCreate("delete A")).toBe(false);
		expect(reviews.consumeOrCreate("delete B")).toBe(false);
	});
});

describe("blocked tool-result protocol", () => {
	it("includes all yellow matches and keeps suggestions as unexpanded plain text", () => {
		const matches = makeSnapshot().yellowRules;
		const reason = formatYellowReason(matches);

		expect(reason).toContain("原命令没有执行");
		expect(reason).toContain("黄色风险");
		expect(reason).toContain("删除：删除有风险");
		expect(reason).toContain("建议：请使用安全形式");
		expect(reason).toContain("safe $1 command");
		expect(reason).toContain("紧接着的下一次 LLM 响应");
	});

	it("states that red commands are never released and asks for a safer direction", () => {
		const reason = formatRedReason(makeSnapshot().redRules);

		expect(reason).toContain("原命令没有执行且不会被放行");
		expect(reason).toContain("红色风险");
		expect(reason).toContain("灾难一：停止一");
		expect(reason).toContain("灾难二：停止二");
		expect(reason).toContain("反思为什么会产生该命令");
	});
});
