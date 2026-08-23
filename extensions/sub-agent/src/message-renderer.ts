import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { REPORT_MESSAGE_TYPE, type SETTLEMENT_MESSAGE_TYPE } from "./constants.js";
import type { SubagentRunOutcome } from "./domain.js";

interface SubagentMessageDetails {
	readonly childId?: string;
	readonly label?: string;
	readonly outcome?: SubagentRunOutcome;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDetails(value: unknown): SubagentMessageDetails | null {
	if (!isRecord(value)) return null;
	const childId = typeof value.childId === "string" && value.childId.trim().length > 0 ? value.childId : undefined;
	const label = typeof value.label === "string" && value.label.trim().length > 0 ? value.label : undefined;
	if (childId === undefined && label === undefined) return null;
	if (
		value.outcome !== undefined &&
		value.outcome !== "completed" &&
		value.outcome !== "interrupted" &&
		value.outcome !== "failed"
	)
		return null;
	return {
		...(childId === undefined ? {} : { childId }),
		...(label === undefined ? {} : { label }),
		...(value.outcome === undefined ? {} : { outcome: value.outcome }),
	};
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

function bodyFirstLine(content: string): string {
	const lines = content.split("\n");
	return (
		lines
			.slice(1)
			.find((line) => line.trim().length > 0)
			?.trim() ?? ""
	);
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

export function renderSubagentMessage(
	customType: typeof REPORT_MESSAGE_TYPE | typeof SETTLEMENT_MESSAGE_TYPE,
	message: { readonly content: unknown; readonly details?: unknown },
	options: { readonly expanded: boolean; readonly outputPad: number },
	theme: Theme,
): Component {
	const content = messageText(message.content);
	if (options.expanded) return new Text(theme.fg("customMessageText", content), options.outputPad, 0);
	const details = parseDetails(message.details);
	const label =
		details?.label ?? (details?.childId === undefined ? "Subagent" : `Subagent ${details.childId.slice(0, 8)}`);
	const firstLine = bodyFirstLine(content);
	const suffix = firstLine.length === 0 ? "" : ` · ${firstLine}`;
	if (customType === REPORT_MESSAGE_TYPE) {
		return new OneLineComponent(theme.fg("accent", `${label} reported${suffix}`));
	}
	const legacyOutcome = firstLine.startsWith("subagent run failed:")
		? "failed"
		: firstLine.startsWith("subagent run cancelled:")
			? "interrupted"
			: "completed";
	const outcome = details?.outcome ?? legacyOutcome;
	const color = outcome === "failed" ? "error" : outcome === "interrupted" ? "warning" : "success";
	return new OneLineComponent(theme.fg(color, `${label} ${outcome}${suffix}`));
}
