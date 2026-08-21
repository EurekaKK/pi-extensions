import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GOAL_ROUND_MESSAGE_TYPE } from "./constants.js";
import { renderGoalRoundPrompt } from "./prompts.js";
import type { GoalService } from "./service.js";
import type { GoalToolAuthority } from "./tools.js";

export interface GoalRoundIdentity {
	readonly goalId: string;
	readonly revision: number;
	readonly round: number;
}

export interface GoalDriverOptions {
	/**
	 * Called after an agent run settles and the driver finished its own
	 * settled-run work (turn reset plus possible next-round admission). The
	 * extension uses it to refresh advisory UI; the driver does not know
	 * widgets exist.
	 */
	readonly onSettled: (context: ExtensionContext) => void;
}

/**
 * Goal Round Driver: owns Turn Authority for the goal toolset and drives
 * automatic continuation rounds.
 *
 * The driver subscribes to the Pi lifecycle itself, so every fact about event
 * ordering lives in this one module: which events mark a direct human turn,
 * how a queued goal round is recognized on its way back, when run state
 * resets, and what happens after a run settles. Callers see only
 * `authority()` — the single question the toolset may ask.
 */
export class GoalDriver {
	readonly #pi: ExtensionAPI;
	readonly #service: GoalService;
	readonly #onSettled: (context: ExtensionContext) => void;
	#humanTurn = false;
	#goalRound: GoalRoundIdentity | undefined;
	#pendingGoalRound: GoalRoundIdentity | undefined;

	constructor(pi: ExtensionAPI, service: GoalService, options: GoalDriverOptions) {
		this.#pi = pi;
		this.#service = service;
		this.#onSettled = options.onSettled;
		this.#subscribe();
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

	#subscribe(): void {
		// Pi can emit several turn_start events inside one agent run; authority
		// spans the whole run, so turn_start carries no information and is
		// deliberately not subscribed.
		this.#pi.on("input", (event) => {
			if (event.source === "interactive" || event.source === "rpc") this.#humanTurn = true;
		});

		this.#pi.on("message_start", (event) => {
			const { role } = event.message;
			if (role !== "user" && !(role === "custom" && event.message.customType === GOAL_ROUND_MESSAGE_TYPE)) return;
			this.#observeMessage(event.message.content);
		});

		this.#pi.on("agent_end", (event, context) => {
			// A run cut off by length or error cannot be trusted to carry a
			// round forward; disarm so the next human turn decides what happens.
			const assistant = [...event.messages].reverse().find((message) => message.role === "assistant");
			if (assistant?.role === "assistant" && (assistant.stopReason === "length" || assistant.stopReason === "error")) {
				this.#service.disarm(context.sessionManager.getSessionId());
			}
		});

		this.#pi.on("agent_settled", async (_event, context) => {
			await this.#settle(context);
		});

		this.#pi.on("session_start", () => this.#reset());
		this.#pi.on("session_tree", () => this.#reset());
		this.#pi.on("session_shutdown", () => this.#reset());
	}

	#observeMessage(content: unknown): void {
		const pending = this.#pendingGoalRound;
		if (pending !== undefined && typeof content === "string" && content.startsWith("<goal_round>")) {
			this.#goalRound = pending;
			this.#humanTurn = false;
		} else {
			this.#humanTurn = true;
		}
		this.#pendingGoalRound = undefined;
	}

	async #settle(context: ExtensionContext): Promise<void> {
		// The run being settled loses its identity here; whatever happens next
		// must re-establish authority through a fresh round or a human turn.
		this.#humanTurn = false;
		this.#goalRound = undefined;
		await this.#driveNextRound(context);
		try {
			this.#onSettled(context);
		} catch {
			// Settled-run notification is advisory; it must never break driving.
		}
	}

	async #driveNextRound(context: ExtensionContext): Promise<void> {
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

	#reset(): void {
		this.#humanTurn = false;
		this.#goalRound = undefined;
		this.#pendingGoalRound = undefined;
	}
}
