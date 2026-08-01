import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { parseGoalCommand } from "./commands.js";
import { GOAL_ERROR_MESSAGE_TYPE, GOAL_EVALUATION_MESSAGE_TYPE } from "./constants.js";
import { GoalCoordinator, type GoalEvaluationMessageDetailsV1, parseGoalErrorEntry } from "./coordinator.js";
import { parseGoalEvaluationReport } from "./domain.js";
import { renderGoalErrorText, renderGoalEvaluationText } from "./ui.js";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEvaluationDetails(value: unknown): GoalEvaluationMessageDetailsV1 | null {
	if (!isRecord(value)) return null;
	const report = parseGoalEvaluationReport(value.report);
	if (
		value.schemaVersion !== 1 ||
		typeof value.ownerSessionId !== "string" ||
		typeof value.goalId !== "string" ||
		typeof value.evaluationId !== "string" ||
		typeof value.evaluationNumber !== "number" ||
		!Number.isSafeInteger(value.evaluationNumber) ||
		value.evaluationNumber < 1 ||
		report === null
	) {
		return null;
	}
	return {
		schemaVersion: 1,
		ownerSessionId: value.ownerSessionId,
		goalId: value.goalId,
		evaluationId: value.evaluationId,
		evaluationNumber: value.evaluationNumber,
		report,
	};
}

export function registerGoalExtension(pi: ExtensionAPI): void {
	const coordinator = new GoalCoordinator(pi);

	pi.registerCommand("goal", {
		description: "Create, resume, or cancel an autonomous session goal",
		async handler(args, context) {
			const parsed = parseGoalCommand(args);
			if (!parsed.ok) {
				context.ui.notify(parsed.message, "error");
				return;
			}
			if (parsed.command === "create") await coordinator.create(context);
			if (parsed.command === "resume") await coordinator.resume(context);
			if (parsed.command === "cancel") await coordinator.cancel(context);
		},
	});

	pi.registerMessageRenderer(GOAL_EVALUATION_MESSAGE_TYPE, (message, options, theme) => {
		const details = parseEvaluationDetails(message.details);
		if (details === null)
			return new Text(theme.fg("warning", "Invalid goal evaluation projection."), options.outputPad, 0);
		return new Text(
			renderGoalEvaluationText({
				evaluationNumber: details.evaluationNumber,
				report: details.report,
				expanded: options.expanded,
			}),
			options.outputPad,
			0,
		);
	});

	pi.registerEntryRenderer(GOAL_ERROR_MESSAGE_TYPE, (entry, options, theme) => {
		const detail = parseGoalErrorEntry(entry.data);
		if (detail === null) return undefined;
		return new Text(
			theme.fg(
				"error",
				renderGoalErrorText({ phase: detail.phase, sanitizedMessage: detail.message, expanded: options.expanded }),
			),
			0,
			0,
		);
	});

	pi.on("session_start", async (_event, context) => {
		await coordinator.handleSessionStart(context);
	});
	pi.on("session_tree", (_event, context) => {
		coordinator.handleSessionTree(context);
	});
	pi.on("session_shutdown", async (_event, context) => {
		await coordinator.handleSessionShutdown(context);
	});
	pi.on("session_before_switch", (_event, context) => coordinator.guardNavigation(context));
	pi.on("session_before_fork", (_event, context) => coordinator.guardNavigation(context));
	pi.on("session_before_tree", (_event, context) => coordinator.guardNavigation(context));

	pi.on("before_agent_start", (event, context) => coordinator.handleBeforeAgentStart(event, context));
	pi.on("agent_start", (_event, context) => {
		coordinator.handleAgentStart(context);
	});
	pi.on("agent_end", (event) => {
		coordinator.handleAgentEnd(event);
	});
	pi.on("agent_settled", async (_event, context) => {
		await coordinator.handleAgentSettled(context);
	});
	pi.on("input", async (event, context) => await coordinator.handleInput(event, context));
	pi.on("tool_call", () => coordinator.handleToolCall());
}

export default registerGoalExtension;
