export function subagentBackgroundGuideline(toolName: string): string {
	return (
		`Use ${toolName} in the background by default. Start independent delegations together in one assistant message and continue useful work while they run. ` +
		"Set `run_in_background: false` only when your next action depends on that subagent's result. " +
		"When a background run settles, the runtime sends you a notice containing its outcome and any final assistant message."
	);
}

export const SUBAGENT_DESCRIPTION =
	"Delegate a self-contained task to a subagent (a separate agent that works in its own context) " +
	"to offload focused, independent work — research, a scoped implementation, an analysis — so it does " +
	"not consume this conversation's context. The subagent returns its result, not its intermediate steps. " +
	"Give it a complete, standalone prompt: it does not see this conversation. " +
	"This tool runs in the background by default, immediately returns a durable subagent id, and keeps the " +
	"child conversation available for later turns. When that run settles, the runtime sends the parent a " +
	"notice containing its outcome and any final assistant message; `send_message` starts a later turn in " +
	"the same child conversation. Set `run_in_background: false` only when your next action depends on " +
	"receiving the result.";

export const SUBAGENT_FORK_DESCRIPTION =
	"Delegate a task to a subagent that inherits this conversation: a child agent seeded with all " +
	"completed turns so far (it does not see the current in-flight turn). Use this when the subtask " +
	"builds on this conversation's context — a follow-up analysis, a review, a continuation — without " +
	"consuming this conversation's context for the work itself. This call waits for the result by default " +
	"and returns the child's final output.";

export const SEND_MESSAGE_DESCRIPTION =
	"Send a message to a background subagent by its subagent id, continuing the same conversation. It " +
	"becomes the subagent's next turn: if it is still working, the message waits until its current turn " +
	"finishes, so it cannot redirect work already underway. This call returns no answer from the " +
	"subagent — only confirmation that the message was delivered — so use it to give it more work. A " +
	"failure means the message was NOT delivered.";

export const INTERRUPT_AGENT_DESCRIPTION =
	"Request cancellation of a background agent's current turn by its agent id. The target may be your " +
	"direct child or a deeper agent created under you. Only the current turn stops: messages already " +
	"queued for the agent stay parked until a later send_message, agents it started keep running, and " +
	"the agent itself stays available for follow-ups. This call returns as soon as the stop request is " +
	"accepted, so the target may keep running briefly; interrupting an agent that already finished is " +
	"an accepted no-op.";

export const LIST_AGENTS_DESCRIPTION =
	"List your continuable background subagents by durable id and label. Use it to recall which ones " +
	"you started, not to poll for completion — you are told when one finishes. Status is running, idle, " +
	"or ready. Scope `descendants` walks the whole tree below you in stable pre-order, annotating each " +
	"entry with its parent and depth. You may use `send_message` only for depth-1 entries; deeper entries " +
	"are candidates for `interrupt_agent` only.";

export const REPORT_DESCRIPTION =
	"Report selected content to the agent that started you. Call this once before you finish, with a " +
	"self-contained final result, and earlier for progress or findings that change what that agent does " +
	"next. That agent shares your workspace but does not automatically receive your transcript, tool " +
	"output, or reasoning, so finishing your work is not itself a result. Reporting does not end your turn.";

export const CHILD_SYSTEM_PROMPT =
	"You are a delegated subagent created by a parent Pi agent.\n" +
	"\n" +
	"Runtime facts:\n" +
	"- Your role, task, method, and requested deliverable come from the parent's delegation message.\n" +
	"- A spawned subagent does not see the parent conversation; a forked subagent sees only completed turns.\n" +
	"- You share the same working directory with the parent and other agents. Inspect current files before changing them, keep changes scoped to your assignment, and never undo unrelated work.\n" +
	"- You are running headlessly. Do not wait for UI input or ask the user an interactive question.\n" +
	"- Cooperate with cancellation and propagate AbortSignal through long-running operations when supported.\n" +
	"- Your final response must be a self-contained report for the parent agent.\n" +
	"- Do not claim that the parent has received anything unless the runtime confirms delivery.";

export const CONTINUABLE_CHILD_REPORT_INSTRUCTION =
	"Before you finish, call the report tool once with a self-contained final result. " +
	"Report earlier as well whenever a partial finding changes what the parent agent should do next. " +
	"Reporting never ends your turn.";
