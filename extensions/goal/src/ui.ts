import {
	type GoalEvaluationReportV1,
	type GoalPhase,
	type GoalVisibleStatus,
	isGoalVisibleStatus,
	parseGoalEvaluationReport,
	summarizeGoalText,
} from "./domain.js";

const STATUS_FIELD_WIDTH = 12;

export interface GoalStatusLineInput {
	readonly status: GoalVisibleStatus;
	readonly activeElapsedMs: number;
	readonly goalSummary: string;
}

export interface GoalEvaluationTextInput {
	readonly evaluationNumber: number;
	readonly report: GoalEvaluationReportV1;
	readonly expanded: boolean;
}

export interface GoalErrorTextInput {
	readonly phase: GoalPhase;
	readonly sanitizedMessage: string;
	readonly expanded: boolean;
}

function requireNonNegativeNumber(value: number, name: string): void {
	if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a finite non-negative number.`);
}

function requirePositiveInteger(value: number, name: string): void {
	if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer.`);
}

export function formatGoalElapsed(activeElapsedMs: number): string {
	requireNonNegativeNumber(activeElapsedMs, "activeElapsedMs");
	const totalSeconds = Math.floor(activeElapsedMs / 1_000);
	const seconds = totalSeconds % 60;
	const totalMinutes = Math.floor(totalSeconds / 60);
	const minutes = totalMinutes % 60;
	const hours = Math.floor(totalMinutes / 60);
	return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function renderGoalStatusLine(input: GoalStatusLineInput): string {
	if (!isGoalVisibleStatus(input.status)) throw new TypeError("Invalid visible goal status.");
	return `Goal: ${input.status.padEnd(STATUS_FIELD_WIDTH)}${formatGoalElapsed(input.activeElapsedMs)}  ${summarizeGoalText(input.goalSummary)}`;
}

function singleLine(value: string): string {
	return value.replace(/\s+/gu, " ").trim();
}

export function renderGoalEvaluationText(input: GoalEvaluationTextInput): string {
	requirePositiveInteger(input.evaluationNumber, "evaluationNumber");
	const report = parseGoalEvaluationReport(input.report);
	if (report === null) throw new TypeError("Invalid goal evaluation report.");
	const heading = `Evaluation #${input.evaluationNumber}: ${report.decision}`;
	if (!input.expanded) return `${heading} — ${singleLine(report.reason)}`;

	const evidence = report.evidence.map((item) => `- ${item}`).join("\n");
	return `${heading}

Progress:
${report.progress}

Reason:
${report.reason}

Next action:
${report.next_action ?? "null"}

Evidence:
${evidence}`;
}

export function renderGoalErrorText(input: GoalErrorTextInput): string {
	const message = singleLine(input.sanitizedMessage);
	const safeMessage = message.length === 0 ? "Unknown infrastructure failure." : message;
	const heading = `Goal ${input.phase} error`;
	if (!input.expanded) return `${heading} — ${safeMessage}`;
	return `${heading}

${safeMessage}

Use /goal resume to retry this phase or /goal cancel to stop the goal.`;
}
