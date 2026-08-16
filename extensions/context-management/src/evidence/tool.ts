import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { EVIDENCE_READ_TOOL } from "../constants.js";
import type { EvidenceState } from "./state.js";

export function registerEvidenceTool(pi: ExtensionAPI, evidence: EvidenceState): void {
	pi.registerTool({
		name: EVIDENCE_READ_TOOL,
		label: "Read compacted evidence",
		description:
			"Request exact run-scoped admission of one compacted tool result by its canonical cm-evidence:v1:<entry-id> reference. The full evidence is injected only if the next provider preflight can fit it.",
		parameters: Type.Object({ reference: Type.String() }),
		executionMode: "sequential",
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			evidence.request(toolCallId, ctx.sessionManager.getBranch(), params.reference, signal);
			return {
				content: [
					{
						type: "text" as const,
						text: `[context-management: evidence read requested for ${params.reference}; full content is run-scoped and subject to next-request admission]`,
					},
				],
				details: { reference: params.reference },
			};
		},
	});
}
