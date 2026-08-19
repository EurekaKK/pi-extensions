import type { CompiledRedRule, CompiledYellowRule, PolicySnapshot } from "./config.js";
import { matchingView } from "./matching-view.js";

export interface CommandDecisionGreen {
	readonly color: "green";
}

export interface CommandDecisionRed {
	readonly color: "red";
	readonly matches: readonly CompiledRedRule[];
}

export interface CommandDecisionYellow {
	readonly color: "yellow";
	readonly matches: readonly CompiledYellowRule[];
	readonly allowedByReview: boolean;
}

export type CommandDecision = CommandDecisionGreen | CommandDecisionRed | CommandDecisionYellow;

export function normalizeCommand(command: string): string {
	return command.replaceAll("\r\n", "\n").trim();
}

function matchingRules<T extends CompiledRedRule | CompiledYellowRule>(
	command: string,
	rules: readonly T[],
): readonly T[] {
	const view = matchingView(command);
	return rules.filter((rule) => rule.regexp.test(view));
}

export class YellowReviewState {
	private responseSequence = 0;
	private readonly eligibleResponses = new Map<string, number>();

	startResponse(): void {
		this.responseSequence += 1;
		for (const [command, eligibleResponse] of this.eligibleResponses) {
			if (eligibleResponse < this.responseSequence) {
				this.eligibleResponses.delete(command);
			}
		}
	}

	endResponse(): void {
		for (const [command, eligibleResponse] of this.eligibleResponses) {
			if (eligibleResponse <= this.responseSequence) {
				this.eligibleResponses.delete(command);
			}
		}
	}

	reset(): void {
		this.responseSequence = 0;
		this.eligibleResponses.clear();
	}

	consumeOrCreate(command: string): boolean {
		const normalized = normalizeCommand(command);
		if (this.eligibleResponses.get(normalized) === this.responseSequence) {
			this.eligibleResponses.delete(normalized);
			return true;
		}

		this.eligibleResponses.set(normalized, this.responseSequence + 1);
		return false;
	}
}

export function decideCommand(command: string, snapshot: PolicySnapshot, reviews: YellowReviewState): CommandDecision {
	const redMatches = matchingRules(command, snapshot.redRules);
	if (redMatches.length > 0) {
		return Object.freeze({ color: "red", matches: Object.freeze(redMatches) });
	}

	const yellowMatches = matchingRules(command, snapshot.yellowRules);
	if (yellowMatches.length === 0) {
		return Object.freeze({ color: "green" });
	}

	return Object.freeze({
		color: "yellow",
		matches: Object.freeze(yellowMatches),
		allowedByReview: reviews.consumeOrCreate(command),
	});
}

export function formatYellowReason(matches: readonly CompiledYellowRule[]): string {
	const details = matches.flatMap((rule, index) => {
		const lines = [`${index + 1}. ${rule.name}：${rule.message}`];
		if (rule.type === "suggest") {
			lines.push(`   更安全的命令建议（纯文本，未执行）：${rule.suggestedCommand}`);
		}
		return lines;
	});

	return [
		"原命令没有执行：bash-permissions 将其判定为黄色风险。",
		"命中规则：",
		...details,
		"请重新检查该命令是否确有必要，并优先寻找更安全的方案。extension 不会自动执行任何建议命令。",
		"只有在紧接着的下一次 LLM 响应中原样重试该命令，才会获得一次放行；其他重试或后续响应会重新复审。",
	].join("\n");
}

export function formatRedReason(matches: readonly CompiledRedRule[]): string {
	const details = matches.map((rule, index) => `${index + 1}. ${rule.name}：${rule.message}`);
	return [
		"原命令没有执行且不会被放行：bash-permissions 将其判定为红色风险。",
		"命中规则：",
		...details,
		"请立即停止当前危险方案，反思为什么会产生该命令，并及时改用不会造成灾难性影响的安全方向。",
	].join("\n");
}
