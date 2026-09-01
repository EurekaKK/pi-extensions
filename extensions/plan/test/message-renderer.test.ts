import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { beforeAll, describe, expect, it } from "vitest";
import { PLAN_PROPOSAL_CARD_MESSAGE_TYPE } from "../src/constants.js";
import { renderPlanMessage } from "../src/message-renderer.js";

const theme = {
	fg: (_color: string, value: string) => value,
} as unknown as Theme;

describe("Plan Proposal transcript rendering", () => {
	beforeAll(() => initTheme("dark", false));

	it("renders the complete Proposal and decision commands even when transcript details are collapsed", () => {
		const proposal = {
			planId: "plan-1",
			revision: 2,
			objective: "Improve planning UX",
			overview: "Keep the review **inside** the normal transcript.",
			steps: [
				{
					stepId: "step-1",
					title: "Render inline",
					details: "Show all review details without covering prior output.",
				},
			],
		};
		const rendered = renderPlanMessage(
			PLAN_PROPOSAL_CARD_MESSAGE_TYPE,
			{
				content: "compact fallback",
				details: { proposal, replaceWarning: "Approval replaces the current Todo list." },
			},
			{ expanded: false, outputPad: 0 },
			theme,
		)
			.render(120)
			.join("\n");

		expect(rendered).toContain("Plan Proposal");
		expect(rendered).toContain("Improve planning UX");
		expect(rendered).toContain("Keep the review");
		expect(rendered).toContain("Render inline");
		expect(rendered).toContain("Show all review details");
		expect(rendered).toContain("Approval replaces the current Todo list");
		expect(rendered).toContain("/plan approve");
		expect(rendered).toContain("/plan revise [feedback]");
		expect(rendered).toContain("/plan cancel");
	});
});
