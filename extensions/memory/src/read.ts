import { defineTool, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MEMORY_ABORTED, MEMORY_READ_COMMAND, MEMORY_READ_TOOL } from "./constants.js";
import { MemoryError } from "./errors.js";
import {
	compactLines,
	makeReadResult,
	renderMemoryFailure,
	renderMemoryToolResult,
	renderReadResultText,
} from "./receipt.js";
import type { MemoryReadInput, MemoryService } from "./service.js";

const MEMORY_READ_PARAMETERS = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description: "Exact record id from a recall, search result, or write receipt.",
		}),
		revision: Type.Optional(
			Type.Integer({
				minimum: 1,
				description: "Exact revision to read; omit to address the record by id alone.",
			}),
		),
	},
	{ additionalProperties: false },
);

function readInput(input: { readonly id: string; readonly revision?: number }): MemoryReadInput {
	return input.revision === undefined ? { id: input.id } : { id: input.id, revision: input.revision };
}

function notify(context: ExtensionContext, text: string, type: "info" | "error" = "info"): void {
	if (!context.hasUI) return;
	try {
		context.ui.notify(text, type);
	} catch {
		// Advisory UI projection must never change Memory semantics.
	}
}

export function registerMemoryReadTool(pi: { registerTool(tool: unknown): void }, service: MemoryService): void {
	pi.registerTool(
		defineTool({
			name: MEMORY_READ_TOOL,
			label: "Read memory",
			description:
				"Read the full content and provenance of one record in the current Working Directory's Memory Store by exact `id` and optional `revision`.",
			parameters: MEMORY_READ_PARAMETERS,
			async execute(_toolCallId, parameters, signal, _onUpdate, context) {
				if (signal?.aborted) throw new MemoryError(MEMORY_ABORTED, "memory read was aborted");
				const outcome = await service.read(context, readInput(parameters), signal);
				const result = makeReadResult(outcome);
				return {
					content: [{ type: "text", text: renderReadResultText(result) }],
					details: result,
				};
			},
			renderCall(args, theme: Theme) {
				return compactLines([
					`${theme.fg("toolTitle", theme.bold(MEMORY_READ_TOOL))} ${theme.fg("muted", `· ${args.id}`)}`,
				]);
			},
			renderResult(result, { expanded }, theme, context) {
				return renderMemoryToolResult(result, expanded, theme, context.isError);
			},
		}),
	);
}

const READ_USAGE = `Usage: /${MEMORY_READ_COMMAND} <record-id> [<revision>]`;

/**
 * Convenience command adapter over the exact same Store read the
 * `memory_read` tool uses. It defines no alternate read semantics.
 */
export function registerMemoryReadCommand(pi: ExtensionAPI, service: MemoryService): void {
	pi.registerCommand(MEMORY_READ_COMMAND, {
		description:
			"Read one exact Memory Record for this Working Directory by record identity and optional revision, and show its full persisted content",
		async handler(argumentsText, context) {
			const tokens = argumentsText
				.trim()
				.split(/\s+/u)
				.filter((token) => token.length > 0);
			try {
				if (tokens.length === 0 || tokens.length > 2) {
					notify(context, READ_USAGE, "error");
					return;
				}
				const id = tokens[0] ?? "";
				let revision: number | undefined;
				if (tokens.length === 2) {
					const parsed = parseRevision(tokens[1] ?? "");
					if (parsed === undefined) {
						notify(context, READ_USAGE, "error");
						return;
					}
					revision = parsed;
				}
				const outcome = await service.read(
					context,
					readInput({ id, ...(revision === undefined ? {} : { revision }) }),
					context.signal,
				);
				notify(context, renderReadResultText(makeReadResult(outcome)), "info");
			} catch (error) {
				notify(context, renderMemoryFailure(error), "error");
			}
		},
	});
}

function parseRevision(token: string): number | undefined {
	if (!/^[0-9]+$/u.test(token)) return undefined;
	const value = Number.parseInt(token, 10);
	return Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}
