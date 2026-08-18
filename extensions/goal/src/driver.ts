import type { AgentEndEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GOAL_ROUND_MESSAGE_TYPE } from "./constants.js";
import { renderGoalRoundPrompt } from "./prompts.js";
import type { GoalService } from "./service.js";
import type { GoalToolAuthority } from "./tools.js";

export interface GoalRoundIdentity {
	readonly goalId: string;
	readonly revision: number;
	readonly round: number;
}

export class GoalDriver {
	readonly #pi: ExtensionAPI;
	readonly #service: GoalService;
	#humanTurn = false;
	#goalRound: GoalRoundIdentity | undefined;
	#pendingGoalRound: GoalRoundIdentity | undefined;

	constructor(pi: ExtensionAPI, service: GoalService) {
		this.#pi = pi;
		this.#service = service;
	}

	notifyInput(source: string): void {
		if (source === "interactive" || source === "rpc") this.#humanTurn = true;
	}

	resetTurn(): void {
		this.#humanTurn = false;
		this.#goalRound = undefined;
		this.#pendingGoalRound = undefined;
	}

	beginTurn(): void {
		// Pi can emit several turn_start events inside one agent run. Authority
		// therefore spans the whole run, not one internal Pi turn.
	}

	finishRun(): void {
		this.#humanTurn = false;
		this.#goalRound = undefined;
	}

	observeGoalRoundMessage(content: unknown): void {
		const pending = this.#pendingGoalRound;
		if (pending !== undefined && typeof content === "string" && content.startsWith("<goal_round>")) {
			this.#goalRound = pending;
			this.#humanTurn = false;
		} else {
			this.#humanTurn = true;
		}
		this.#pendingGoalRound = undefined;
	}

	authority(context: ExtensionContext): GoalToolAuthority {
		if (this.#humanTurn) return { kind: "direct-human" };
		const current = this.#service.get(context);
		const round = this.#goalRound;
		if (
			current !== undefined &&
			round !== undefined &&
			round.goalId === current.id &&
			round.revision === current.revision &&
			round.round === current.roundsStarted
		) {
			return { kind: "goal-round", goal: current };
		}
		throw new Error("complete and blocked require a direct human turn or the current goal round");
	}

	async maybeDrive(context: ExtensionContext): Promise<void> {
		if (context.mode !== "tui" && context.mode !== "rpc") return;
		const goal = this.#service.get(context);
		if (goal === undefined || goal.phase !== "active" || goal.activation !== "armed") return;
		if (goal.roundsStarted >= goal.maxGoalRounds) {
			this.#service.block(
				context,
				{ id: goal.id, revision: goal.revision },
				{
					code: "round-limit",
					message: `Goal reached its configured limit of ${goal.maxGoalRounds} rounds.`,
				},
			);
			return;
		}
		const round = goal.roundsStarted + 1;
		const content = renderGoalRoundPrompt(goal, round);
		try {
			this.#service.admitRound(context, goal, round);
			this.#pendingGoalRound = { goalId: goal.id, revision: goal.revision, round };
			this.#pi.sendMessage(
				{
					customType: GOAL_ROUND_MESSAGE_TYPE,
					content,
					display: true,
					details: { goalId: goal.id, revision: goal.revision, round },
				},
				{ triggerTurn: true },
			);
		} catch (error) {
			this.#pendingGoalRound = undefined;
			this.#service.block(
				context,
				{ id: goal.id, revision: goal.revision },
				{
					code: "queue-failed",
					message: `Could not queue goal round ${round}: ${error instanceof Error ? error.message : String(error)}`,
				},
			);
		}
	}

	handleAgentEnd(event: AgentEndEvent, context: ExtensionContext): void {
		const assistant = [...event.messages].reverse().find((message) => message.role === "assistant");
		if (assistant !== undefined && assistant.role === "assistant") {
			if (assistant.stopReason === "length" || assistant.stopReason === "error") {
				this.#service.disarm(context.sessionManager.getSessionId());
			}
		}
	}
}
