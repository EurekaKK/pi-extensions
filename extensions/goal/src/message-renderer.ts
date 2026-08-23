import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Text, truncateToWidth } from "@earendil-works/pi-tui";

interface GoalRoundDetails {
	readonly round: number;
	readonly maxGoalRounds: number;
	readonly objective: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDetails(value: unknown): GoalRoundDetails | null {
	if (!isRecord(value)) return null;
	if (
		!Number.isSafeInteger(value.round) ||
		typeof value.round !== "number" ||
		value.round < 1 ||
		!Number.isSafeInteger(value.maxGoalRounds) ||
		typeof value.maxGoalRounds !== "number" ||
		value.maxGoalRounds < value.round ||
		typeof value.objective !== "string" ||
		value.objective.trim().length === 0
	)
		return null;
	return { round: value.round, maxGoalRounds: value.maxGoalRounds, objective: value.objective };
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(
			(block): block is { readonly type: "text"; readonly text: string } =>
				isRecord(block) && block.type === "text" && typeof block.text === "string",
		)
		.map((block) => block.text)
		.join("\n");
}

class OneLineComponent implements Component {
	readonly #line: string;

	constructor(line: string) {
		this.#line = line;
	}

	render(width: number): string[] {
		return [truncateToWidth(this.#line, Math.max(1, width))];
	}

	invalidate(): void {}
}

export function renderGoalRoundMessage(
	message: { readonly content: unknown; readonly details?: unknown },
	options: { readonly expanded: boolean; readonly outputPad: number },
	theme: Theme,
): Component {
	const content = messageText(message.content);
	if (options.expanded) return new Text(theme.fg("customMessageText", content), options.outputPad, 0);
	const details = parseDetails(message.details);
	const summary =
		details === null ? "Goal round" : `Goal round ${details.round}/${details.maxGoalRounds} · ${details.objective}`;
	return new OneLineComponent(theme.fg("customMessageLabel", theme.bold(summary)));
}
