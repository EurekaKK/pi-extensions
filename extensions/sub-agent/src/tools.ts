import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { INTERRUPT_AGENT_TOOL_NAME, LIST_AGENTS_TOOL_NAME, SEND_MESSAGE_TOOL_NAME } from "./constants.js";
import type { SubAgentConfigV2, SubagentDelegationToolConfigV2 } from "./domain.js";
import {
	INTERRUPT_AGENT_DESCRIPTION,
	LIST_AGENTS_DESCRIPTION,
	SEND_MESSAGE_DESCRIPTION,
	SUBAGENT_DESCRIPTION,
	SUBAGENT_FORK_DESCRIPTION,
	subagentBackgroundGuideline,
} from "./prompts.js";
import type { SubagentListEntry, SubagentManager } from "./runtime.js";

const DelegationParameters = Type.Object(
	{
		description: Type.String(),
		prompt: Type.String(),
		run_in_background: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

interface DelegationResultDetails {
	readonly childId: string;
	readonly background: boolean;
}

function isInteractive(mode: ExtensionContext["mode"]): boolean {
	return mode === "tui" || mode === "rpc";
}

function assertInteractiveMode(context: ExtensionContext): void {
	if (!isInteractive(context.mode)) throw new Error("SUBAGENT_UNSUPPORTED_MODE");
}

function delegationDescription(tool: SubagentDelegationToolConfigV2): string {
	if (tool.provider === "fork") return SUBAGENT_FORK_DESCRIPTION;
	return SUBAGENT_DESCRIPTION;
}

function delegationGuidelines(tool: SubagentDelegationToolConfigV2): string[] | undefined {
	if (tool.backgroundMode !== "continuable") return undefined;
	return [subagentBackgroundGuideline(tool.toolName)];
}

function resultText(result: {
	readonly content: readonly { readonly type: string; readonly text?: string }[];
}): string {
	return result.content
		.filter(
			(block): block is { readonly type: "text"; readonly text: string } =>
				block.type === "text" && typeof block.text === "string",
		)
		.map((block) => block.text)
		.join("\n");
}

function listText(entries: readonly SubagentListEntry[]): string {
	if (entries.length === 0) return "(no subagents)";
	return entries
		.map((entry) => {
			const at = entry.diagnostic === undefined ? "" : ` [diagnostic: ${entry.diagnostic}]`;
			return `${entry.childId} [${entry.status}] parent=${entry.parentSessionId} depth=${entry.depth} — ${entry.label}${at}`;
		})
		.join("\n");
}

export interface ParentToolRuntime {
	manager(context: ExtensionContext): SubagentManager;
}

export function registerParentTools(
	pi: { registerTool(tool: unknown): void },
	runtime: ParentToolRuntime,
	config: SubAgentConfigV2,
): void {
	for (const toolConfig of config.delegationTools) {
		const name = toolConfig.toolName;
		const promptGuidelines = delegationGuidelines(toolConfig);
		pi.registerTool(
			defineTool<typeof DelegationParameters, DelegationResultDetails>({
				name,
				label: name,
				description: delegationDescription(toolConfig),
				parameters: DelegationParameters,
				...(promptGuidelines === undefined ? {} : { promptGuidelines }),
				async execute(_toolCallId, parameters, signal, _onUpdate, context) {
					if (signal?.aborted) throw new Error("Operation aborted");
					const manager = runtime.manager(context);
					const label = parameters.description.trim();
					const prompt = parameters.prompt.trim();
					if (label.length === 0) throw new Error("description must be a non-empty string");
					if (prompt.length === 0) throw new Error("prompt must be a non-empty string");
					const runInBackground = parameters.run_in_background ?? toolConfig.backgroundMode === "continuable";
					if (runInBackground) assertInteractiveMode(context);
					const started = await manager.start(toolConfig, label, prompt, runInBackground, signal);
					if (runInBackground) {
						return {
							content: [{ type: "text" as const, text: `started subagent ${started.childId}` }],
							details: { childId: started.childId, background: true },
						};
					}
					return {
						content: [{ type: "text" as const, text: started.output ?? "" }],
						details: { childId: started.childId, background: false },
					};
				},
				renderCall(args, theme) {
					const label = args.description.trim() || "unnamed delegation";
					return new Text(`${theme.fg("toolTitle", theme.bold(name))} ${theme.fg("muted", `· ${label}`)}`, 0, 0);
				},
				renderResult(result, { expanded }, theme, context) {
					const label = context.args.description.trim() || "unnamed delegation";
					const output = resultText(result);
					if (context.isError) {
						const visible = expanded ? output : (output.split("\n", 1)[0] ?? "Delegation failed");
						return new Text(theme.fg("error", visible), 0, 0);
					}
					if (result.details?.background === true) {
						const summary = theme.fg("success", `Started · ${label}`);
						const child = expanded ? `\n${theme.fg("muted", `Agent: ${result.details.childId}`)}` : "";
						return new Text(`${summary}${child}`, 0, 0);
					}
					const summary = theme.fg("success", `Completed · ${label}`);
					if (output.length === 0) return new Text(summary, 0, 0);
					const visible = expanded ? output : (output.split("\n", 1)[0] ?? "");
					return new Text(`${summary}\n${theme.fg("text", visible)}`, 0, 0);
				},
			}),
		);
	}

	pi.registerTool(
		defineTool({
			name: SEND_MESSAGE_TOOL_NAME,
			label: "Send to subagent",
			description: SEND_MESSAGE_DESCRIPTION,
			parameters: Type.Object(
				{
					subagent_id: Type.String(),
					message: Type.String(),
				},
				{ additionalProperties: false },
			),
			async execute(_toolCallId, parameters, signal, _onUpdate, context) {
				if (signal?.aborted) throw new Error("Operation aborted");
				assertInteractiveMode(context);
				const manager = runtime.manager(context);
				const text = parameters.message.trim();
				if (text.length === 0) throw new Error("message must be a non-empty string");
				const confirmation = await manager.sendMessage(parameters.subagent_id, text);
				return {
					content: [{ type: "text" as const, text: confirmation }],
					details: { subagentId: parameters.subagent_id },
				};
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: INTERRUPT_AGENT_TOOL_NAME,
			label: "Interrupt subagent",
			description: INTERRUPT_AGENT_DESCRIPTION,
			parameters: Type.Object(
				{
					agent_id: Type.String(),
				},
				{ additionalProperties: false },
			),
			async execute(_toolCallId, parameters, signal, _onUpdate, context) {
				if (signal?.aborted) throw new Error("Operation aborted");
				assertInteractiveMode(context);
				runtime.manager(context).interrupt(parameters.agent_id);
				return {
					content: [{ type: "text" as const, text: `interrupt requested for agent ${parameters.agent_id}` }],
					details: { accepted: true },
				};
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: LIST_AGENTS_TOOL_NAME,
			label: "List subagents",
			description: LIST_AGENTS_DESCRIPTION,
			parameters: Type.Object(
				{
					scope: Type.Optional(StringEnum(["children", "descendants"] as const)),
				},
				{ additionalProperties: false },
			),
			async execute(_toolCallId, parameters, signal, _onUpdate, context) {
				if (signal?.aborted) throw new Error("Operation aborted");
				const manager = runtime.manager(context);
				const entries = manager.list(parameters.scope ?? "children");
				return {
					content: [{ type: "text" as const, text: listText(entries) }],
					details: { entries },
				};
			},
		}),
	);
}
