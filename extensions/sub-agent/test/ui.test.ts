import type { Theme } from "@earendil-works/pi-coding-agent";
import { PROGRESS_WIDGET_ATTACH_EVENT, PROGRESS_WIDGET_STATE_EVENT } from "progress-widget-protocol";
import { FakePiHost } from "test-host";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { REPORT_MESSAGE_TYPE, SETTLEMENT_MESSAGE_TYPE, SUBAGENT_WIDGET_KEY } from "../src/constants.js";
import { registerSubAgent } from "../src/index.js";
import { renderSubagentMessage } from "../src/message-renderer.js";
import { buildSubagentWidgetLines } from "../src/widget.js";

const theme = {
	fg: (_color: string, value: string) => value,
} as unknown as Theme;

describe("sub-agent compact UI", () => {
	it("shows one fallback line only while a direct run is active", () => {
		expect(
			buildSubagentWidgetLines([
				{ childId: "a", label: "review", status: "running" },
				{ childId: "b", label: "audit", status: "completed" },
			]),
		).toEqual(["Subagents · 1 running · 0 interrupting · 1 completed · 0 interrupted · 0 failed"]);
		expect(buildSubagentWidgetLines([{ childId: "a", label: "review", status: "completed" }])).toEqual([]);
	});

	it("collapses report and settlement bodies and expands the original content", () => {
		const report = {
			content: "Background subagent child-1 reported:\nFirst finding\nLong report body",
			details: { version: 1, childId: "child-1", label: "cache review", runId: "run-1" },
		};
		const collapsedReport = renderSubagentMessage(REPORT_MESSAGE_TYPE, report, { expanded: false, outputPad: 1 }, theme)
			.render(120)
			.join("\n");
		expect(collapsedReport).toBe("cache review reported · First finding");
		expect(collapsedReport).not.toContain("child-1");
		expect(collapsedReport).not.toContain("Long report body");

		const settlement = {
			content: "Background subagent child-1 finished:\nFinal answer\nDetails",
			details: {
				version: 1,
				childId: "child-1",
				label: "cache review",
				runId: "run-1",
				outcome: "failed",
			},
		};
		expect(
			renderSubagentMessage(SETTLEMENT_MESSAGE_TYPE, settlement, { expanded: false, outputPad: 1 }, theme).render(120),
		).toEqual(["cache review failed · Final answer"]);
		expect(
			renderSubagentMessage(SETTLEMENT_MESSAGE_TYPE, settlement, { expanded: true, outputPad: 1 }, theme)
				.render(120)
				.join("\n"),
		).toContain("Background subagent child-1 finished:");

		expect(
			renderSubagentMessage(
				SETTLEMENT_MESSAGE_TYPE,
				{
					content: "Background subagent child-old finished:\nsubagent run cancelled: aborted",
					details: { childId: "child-old" },
				},
				{ expanded: false, outputPad: 1 },
				theme,
			).render(120),
		).toEqual(["Subagent child-ol interrupted · subagent run cancelled: aborted"]);
	});

	it("hands widget ownership to progress-widget and publishes an empty snapshot", async () => {
		const host = new FakePiHost({ mode: "rpc" });
		const snapshots: unknown[] = [];
		host.api.events.on(PROGRESS_WIDGET_STATE_EVENT, (value) => snapshots.push(value));
		registerSubAgent(host.api, DEFAULT_CONFIG);
		await host.emit("session_start");

		host.emitBus(PROGRESS_WIDGET_ATTACH_EVENT, { version: 1, sessionId: "session-1" });

		expect(host.ui.setWidget).toHaveBeenLastCalledWith(SUBAGENT_WIDGET_KEY, undefined, {
			placement: "aboveEditor",
		});
		expect(snapshots).toContainEqual({
			version: 1,
			source: "sub-agent",
			sessionId: "session-1",
			agents: [],
		});
	});
});
