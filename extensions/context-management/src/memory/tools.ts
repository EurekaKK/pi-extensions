import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MEMORY_FORGET_TOOL, MEMORY_READ_TOOL, MEMORY_SEARCH_TOOL, MEMORY_WRITE_TOOL } from "../constants.js";
import { ContextManagementError } from "../errors.js";
import type { MemoryKind, MemoryScope } from "./schema.js";
import type { MemoryService } from "./service.js";

function textResult(text: string, details: Readonly<Record<string, unknown>> = {}) {
	return { content: [{ type: "text" as const, text }], details };
}

function scopeText(scope: MemoryScope): string {
	return scope.kind === "repository"
		? `repository; paths=${scope.paths.length === 0 ? "none" : scope.paths.join(", ")}`
		: `branch:${scope.branch}; paths=${scope.paths.length === 0 ? "none" : scope.paths.join(", ")}`;
}

export function registerMemoryTools(pi: ExtensionAPI, memory: MemoryService): void {
	pi.registerTool({
		name: MEMORY_WRITE_TOOL,
		label: "Write repository memory",
		description:
			"Persist a durable repository memory. Use when the user explicitly asks to remember, or when you judge a decision, verified change, reusable learning, or completed milestone will matter in future sessions. Do not store current progress, temporary plans, next steps, easily reconstructed noise, credentials, secrets, or unrelated personal information. Corrections must create a new record and explicitly supersede old IDs.",
		promptSnippet: "Persist durable repository decisions and learnings across sessions.",
		promptGuidelines: [
			"Use context_management_memory_write for genuinely durable repository knowledge, including useful memories you identify without an explicit user request.",
			"Never use repository memory for progress, todos, temporary working state, credentials, secrets, or unrelated personal information.",
			"Correct a memory by writing a replacement with supersedes; never silently rewrite an existing record.",
			"Only call context_management_memory_forget when the current user input or steering explicitly requests removal.",
		],
		parameters: Type.Object({
			kind: Type.Union([
				Type.Literal("decision"),
				Type.Literal("verified-change"),
				Type.Literal("learning"),
				Type.Literal("milestone"),
			]),
			title: Type.String(),
			summary: Type.String(),
			contentMarkdown: Type.String(),
			scope: Type.Optional(
				Type.Object({
					kind: Type.Optional(Type.Union([Type.Literal("repository"), Type.Literal("branch")])),
					paths: Type.Optional(Type.Array(Type.String())),
				}),
			),
			supersedes: Type.Optional(Type.Array(Type.String())),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			await memory.refresh(ctx.cwd, signal);
			const scopeKind = params.scope?.kind ?? "repository";
			const paths = params.scope?.paths ?? [];
			let scope: MemoryScope;
			if (scopeKind === "branch") {
				const branch = memory.identity?.branch ?? null;
				if (branch === null) {
					throw new ContextManagementError(
						"context_management.memory_validation_failure",
						"Branch-scoped memory requires a Git repository on an attached branch.",
					);
				}
				scope = { kind: "branch", branch, paths };
			} else {
				scope = { kind: "repository", paths };
			}
			const result = await memory.write(
				ctx.cwd,
				{
					kind: params.kind as MemoryKind,
					title: params.title,
					summary: params.summary,
					contentMarkdown: params.contentMarkdown,
					scope,
					supersedes: params.supersedes ?? [],
				},
				{
					sessionId: ctx.sessionManager.getSessionId(),
					entryId: ctx.sessionManager.getLeafId(),
					gitBranch: memory.identity?.branch ?? null,
					gitHead: memory.identity?.head ?? null,
					trigger: "primary-agent-tool",
				},
				signal,
			);
			const { record, reused } = result.value;
			const warning = result.durabilityWarning === undefined ? "" : `\nWarning: ${result.durabilityWarning}`;
			return textResult(
				`${reused ? "Reused" : "Created"} Memory ${record.id}\nKind: ${record.kind}\nTitle: ${record.title}\nScope: ${scopeText(record.scope)}\nStore bytes: ${result.currentBytes} -> ${result.candidateBytes}${warning}`,
				{ id: record.id, reused, currentBytes: result.currentBytes, candidateBytes: result.candidateBytes },
			);
		},
	});

	pi.registerTool({
		name: MEMORY_SEARCH_TOOL,
		label: "Search repository memory",
		description:
			"Search active repository memory by a non-empty query. Returns compact metadata stubs only; read an exact ID for the full body.",
		parameters: Type.Object({ query: Type.String() }),
		executionMode: "parallel",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return textResult(await memory.search(ctx.cwd, params.query, signal));
		},
	});

	pi.registerTool({
		name: MEMORY_READ_TOOL,
		label: "Read repository memory",
		description: "Read one active and currently applicable repository memory by its exact mem_ ID.",
		parameters: Type.Object({ id: Type.String() }),
		executionMode: "parallel",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const record = await memory.read(ctx.cwd, params.id, signal);
			return textResult(
				`# ${record.title}\n\n- ID: ${record.id}\n- Kind: ${record.kind}\n- Scope: ${scopeText(record.scope)}\n- Created: ${record.createdAt}\n- Supersedes: ${record.supersedes.length === 0 ? "none" : record.supersedes.join(", ")}\n- Superseded by: ${record.supersededBy ?? "none"}\n- Summary: ${record.summary}\n\n${record.contentMarkdown}`,
				{ id: record.id },
			);
		},
	});

	pi.registerTool({
		name: MEMORY_FORGET_TOOL,
		label: "Forget repository memory",
		description:
			"Physically remove one exact repository Memory ID. Call only when the current user input or steering explicitly requests removal; never invoke from autonomous judgment. Supersession relationships must be resolved explicitly first.",
		parameters: Type.Object({ id: Type.String() }),
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const result = await memory.forget(ctx.cwd, params.id, signal);
			const warning = result.durabilityWarning === undefined ? "" : `\nWarning: ${result.durabilityWarning}`;
			return textResult(
				`Forgot Memory ${result.value.id}: ${result.value.title}\nStore bytes: ${result.currentBytes} -> ${result.candidateBytes}${warning}`,
				{ id: result.value.id, currentBytes: result.currentBytes, candidateBytes: result.candidateBytes },
			);
		},
	});
}
