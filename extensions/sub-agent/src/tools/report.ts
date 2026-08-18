import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { REPORT_TOOL_NAME } from "../constants.js";
import { REPORT_DESCRIPTION } from "../prompts.js";

const MAX_REPORT_BYTES = 256 * 1024;

export function createReportToolDefinition(onReport: (output: string) => Promise<string>) {
	return defineTool({
		name: REPORT_TOOL_NAME,
		label: "Report to parent",
		description: REPORT_DESCRIPTION,
		parameters: Type.Object(
			{
				output: Type.String(),
			},
			{ additionalProperties: false },
		),
		async execute(_toolCallId, parameters, signal) {
			if (signal?.aborted) throw new Error("Operation aborted");
			const output = parameters.output.trim();
			if (output.length === 0) throw new Error("report output must be a non-empty string");
			if (Buffer.byteLength(output, "utf8") > MAX_REPORT_BYTES) {
				throw new Error(`report output exceeds ${MAX_REPORT_BYTES} UTF-8 bytes`);
			}
			const messageId = await onReport(output);
			return {
				content: [{ type: "text" as const, text: messageId }],
				details: { messageId },
			};
		},
	});
}
