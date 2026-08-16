import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import { CHECKPOINT_SYSTEM_PROMPT } from "../constants.js";
import { estimateProjection, estimateTextTokens } from "../runtime/budget.js";

type AgentMessage = ContextEvent["messages"][number];

export const COMPACTOR_SOURCE_PREAMBLE = "Covered conversation prefix follows. Produce only the checkpoint.\n\n";

export function estimateCompactorPromptOverhead(): number {
	const wrapper: AgentMessage = {
		role: "user",
		content: [{ type: "text", text: COMPACTOR_SOURCE_PREAMBLE }],
		timestamp: 0,
	};
	return estimateTextTokens(CHECKPOINT_SYSTEM_PROMPT) + estimateProjection([wrapper]);
}
