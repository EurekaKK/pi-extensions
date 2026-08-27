import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type Theme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { MemoryWriteAuthority } from "./authority.js";
import { MEMORY_ABORTED, MEMORY_WRITE_DENIED, MEMORY_WRITE_TOOL } from "./constants.js";
import { MemoryError } from "./errors.js";
import { compactLines, makeWriteReceipt, renderMemoryToolResult, renderWriteReceiptText } from "./receipt.js";
import type { MemoryService } from "./service.js";

export interface MemoryToolRuntime {
	readonly service: MemoryService;
	readonly authority: MemoryWriteAuthority;
}

const MEMORY_WRITE_PARAMETERS = Type.Object(
	{
		operation: StringEnum(["add"] as const),
		summary: Type.String({ minLength: 1 }),
		content: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

export function registerMemoryWriteTool(pi: { registerTool(tool: unknown): void }, runtime: MemoryToolRuntime): void {
	const { service, authority } = runtime;
	const guidelines = [
		"Use memory_write only for verified, durable, directory-specific knowledge that would be hard to rediscover.",
		"Never use memory_write for global preferences, secrets, credentials, raw logs, large outputs, temporary paths, unresolved failures, Plans, Todos, session summaries, or content already authoritative in project documentation.",
		"Set memory_write.operation to add; supersede is not available yet.",
	];
	pi.registerTool(
		defineTool({
			name: MEMORY_WRITE_TOOL,
			label: "Write memory",
			description:
				"Commit one verified Memory Record for the current Working Directory during a direct foreground human turn, then return a full-content receipt with immutable provenance.",
			parameters: MEMORY_WRITE_PARAMETERS,
			promptGuidelines: guidelines,
			async execute(_toolCallId, parameters, signal, _onUpdate, context) {
				if (signal?.aborted) throw new MemoryError(MEMORY_ABORTED, "memory write was aborted");
				const status = authority.check(context);
				if (status.kind === "denied") {
					throw new MemoryError(MEMORY_WRITE_DENIED, denyMessage(status.reason));
				}
				const outcome = await service.add(context, parameters, signal);
				const receipt = makeWriteReceipt(outcome);
				return {
					content: [{ type: "text", text: renderWriteReceiptText(receipt) }],
					details: receipt,
				};
			},
			renderCall(args, theme: Theme) {
				const summary = args.summary.trim();
				return compactLines([
					`${theme.fg("toolTitle", theme.bold(MEMORY_WRITE_TOOL))}${summary.length === 0 ? "" : ` ${theme.fg("muted", `· ${summary}`)}`}`,
				]);
			},
			renderResult(result, { expanded }, theme, context) {
				return renderMemoryToolResult(result, expanded, theme, context.isError);
			},
		}),
	);
}

export function denyMessage(reason: "no-direct-human-turn" | "subagent-context" | "proactive-writes-disabled"): string {
	switch (reason) {
		case "no-direct-human-turn":
			return "memory_write requires a direct foreground human turn; extension follow-up and bookkeeping turns cannot write.";
		case "subagent-context":
			return "memory_write is not available to subagents; only the primary foreground Agent can write directory memory.";
		case "proactive-writes-disabled":
			return "proactive writes are disabled by the memory deployment configuration (proactiveWrites: false).";
	}
}
