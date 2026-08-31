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
		operation: StringEnum(["add", "supersede"] as const, {
			description: "`add` creates a new record; `supersede` corrects one active record.",
		}),
		summary: Type.String({
			minLength: 1,
			description: "Concise, searchable terms likely to appear in future queries.",
		}),
		content: Type.String({
			minLength: 1,
			description: "Complete, self-contained durable knowledge and its rationale.",
		}),
		targetId: Type.Optional(
			Type.String({
				minLength: 1,
				description: "Required for `supersede`: exact id of the active record. Omit for `add`.",
			}),
		),
		targetRevision: Type.Optional(
			Type.Integer({
				minimum: 1,
				description: "Required for `supersede`: exact active revision. Omit for `add`.",
			}),
		),
	},
	{ additionalProperties: false },
);

export function registerMemoryWriteTool(pi: { registerTool(tool: unknown): void }, runtime: MemoryToolRuntime): void {
	const { service, authority } = runtime;
	const guidelines = [
		"Before completing a direct foreground task, check whether it produced knowledge matching memory_write's durability criteria; persist that knowledge if so.",
		"Keep memory_write records concise and self-contained. Leave global preferences, raw logs or large outputs, temporary paths, unresolved failures, Plans/Todos, and session summaries out of Directory Memory; never store secrets or credentials.",
	];
	pi.registerTool(
		defineTool({
			name: MEMORY_WRITE_TOOL,
			label: "Write memory",
			description:
				"Persist verified, durable, directory-specific knowledge for the current Working Directory when it is hard to rediscover and absent from authoritative project documentation. Available only in a direct foreground human turn.",
			parameters: MEMORY_WRITE_PARAMETERS,
			promptGuidelines: guidelines,
			async execute(_toolCallId, parameters, signal, _onUpdate, context) {
				if (signal?.aborted) throw new MemoryError(MEMORY_ABORTED, "memory write was aborted");
				const status = authority.check(context);
				if (status.kind === "denied") {
					throw new MemoryError(MEMORY_WRITE_DENIED, denyMessage(status.reason));
				}
				const outcome = await service.write(context, parameters, signal);
				const receipt = makeWriteReceipt(outcome, parameters.operation);
				return {
					content: [{ type: "text", text: renderWriteReceiptText(receipt) }],
					details: receipt,
				};
			},
			renderCall(args, theme: Theme) {
				const summary = args.summary.trim();
				const modifier = args.operation === "supersede" ? ` ${theme.fg("muted", "· supersede")}` : "";
				return compactLines([
					`${theme.fg("toolTitle", theme.bold(MEMORY_WRITE_TOOL))}${summary.length === 0 ? "" : ` ${theme.fg("muted", `· ${summary}`)}`}${modifier}`,
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
