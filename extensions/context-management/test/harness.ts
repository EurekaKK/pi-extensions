import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type {
	ContextEvent,
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
	SessionEntry,
	ToolInfo,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { registerContextManagementExtension } from "../src/index.js";

type AgentMessage = ContextEvent["messages"][number];
type Handler = (event: Record<string, unknown>, context: ExtensionContext) => unknown | Promise<unknown>;

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function userMessage(text: string, timestamp = 1): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp };
}

export function toolTurn(toolCallId: string, text: string, toolName = "bash"): AgentMessage[] {
	return [
		{
			role: "assistant",
			content: [{ type: "toolCall", id: toolCallId, name: toolName, arguments: { command: "echo" } }],
			api: "faux",
			provider: "faux",
			model: "faux-1",
			usage: EMPTY_USAGE,
			stopReason: "toolUse",
			timestamp: 2,
		},
		{
			role: "toolResult",
			toolCallId,
			toolName,
			content: [{ type: "text", text }],
			isError: false,
			timestamp: 3,
		},
	];
}

export function structuredCheckpointText(): string {
	return [
		"## Primary Request and Intent",
		"- continue",
		"",
		"## Key Technical Concepts",
		"- (none)",
		"",
		"## Files and Code",
		"- (none)",
		"",
		"## Errors and Fixes",
		"- (none)",
		"",
		"## Pending Jobs",
		"- (none)",
		"",
		"## Current Work",
		"- in progress",
		"",
		"## Next Step",
		"- keep going",
		"",
		"## Critical Context",
		"- (none)",
	].join("\n");
}

export class ContextHarness {
	readonly notify = vi.fn();
	readonly compact = vi.fn();
	readonly registeredCommands: Array<{ readonly name: string; readonly description?: string }> = [];
	readonly registeredTools: unknown[] = [];
	readonly api: ExtensionAPI;
	readonly context: ExtensionContext;
	readonly faux;
	#handlers = new Map<string, Handler[]>();
	#branch: SessionEntry[] = [];
	#nextId = 1;

	constructor(
		readonly window: number,
		readonly agentDir: string,
		options: { readonly auto?: boolean; readonly hasUI?: boolean } = {},
	) {
		this.faux = fauxProvider({
			models: [{ id: "faux-1", name: "Faux", contextWindow: window, maxTokens: 16_384 }],
		});
		const model = this.faux.getModel();
		this.context = {
			mode: "tui",
			hasUI: options.hasUI ?? true,
			ui: { notify: this.notify, setWorkingMessage: () => undefined },
			model,
			isIdle: () => true,
			getSystemPrompt: () => "system prompt",
			compact: this.compact,
			sessionManager: {
				getSessionId: () => "session-1",
				getLeafId: () => this.#branch.at(-1)?.id ?? null,
				getBranch: () => [...this.#branch],
				buildContextEntries: () => [...this.#branch],
			},
			modelRegistry: {
				getProvider: (provider: string) => (provider === model.provider ? this.faux.provider : undefined),
				getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "test-key" }),
			},
		} as unknown as ExtensionContext;
		this.api = {
			on: (event: string, handler: Handler) => {
				const handlers = this.#handlers.get(event) ?? [];
				handlers.push(handler);
				this.#handlers.set(event, handlers);
			},
			registerCommand: (name: string, command: { description?: string }) => {
				this.registeredCommands.push(
					command.description === undefined ? { name } : { name, description: command.description },
				);
			},
			registerTool: (tool: unknown) => {
				this.registeredTools.push(tool);
			},
			getActiveTools: () => ["bash"],
			getAllTools: () =>
				[
					{
						name: "bash",
						description: "Run a command",
						parameters: { type: "object", properties: {} },
						sourceInfo: { path: "/bash", source: "pi", scope: "temporary", origin: "top-level" },
					},
				] as ToolInfo[],
		} as unknown as ExtensionAPI;
		this.queueSuccessfulSummary();
		registerContextManagementExtension(this.api, Object.freeze({ ...DEFAULT_CONFIG, auto: options.auto ?? true }), {
			agentDir,
			withFileMutationQueue: async (_path, mutation) => mutation(),
		});
	}

	queueSuccessfulSummary(): void {
		this.faux.setResponses([() => fauxAssistantMessage(structuredCheckpointText())]);
	}

	messages(): AgentMessage[] {
		return this.#branch.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
	}

	addUser(text: string): string {
		return this.#appendMessage(userMessage(text, this.#nextId));
	}

	addToolResult(toolCallId: string, text: string): void {
		for (const message of toolTurn(toolCallId, text)) this.#appendMessage(message);
	}

	async emit(event: string, payload: Record<string, unknown>): Promise<unknown> {
		let result: unknown;
		for (const handler of this.#handlers.get(event) ?? []) {
			result = await handler(payload, this.context);
		}
		return result;
	}

	async project(messages = this.messages()): Promise<{ messages: AgentMessage[] }> {
		return (await this.emit("context", { type: "context", messages })) as { messages: AgentMessage[] };
	}

	async beforeCompact(
		reason: SessionBeforeCompactEvent["reason"],
		piFirstKeptEntryId: string,
		options: { readonly customInstructions?: string } = {},
	): Promise<{ cancel?: boolean; compaction?: { summary: string; firstKeptEntryId: string } }> {
		return (await this.emit("session_before_compact", {
			type: "session_before_compact",
			reason,
			willRetry: false,
			signal: new AbortController().signal,
			branchEntries: [...this.#branch],
			...(options.customInstructions === undefined ? {} : { customInstructions: options.customInstructions }),
			preparation: {
				firstKeptEntryId: piFirstKeptEntryId,
				messagesToSummarize: [],
				turnPrefixMessages: [],
				isSplitTurn: false,
				tokensBefore: 10_000,
				fileOps: { read: new Set(), written: new Set(), edited: new Set() },
				settings: { enabled: true, reserveTokens: 1, keepRecentTokens: 20_000 },
			},
		})) as { cancel?: boolean; compaction?: { summary: string; firstKeptEntryId: string } };
	}

	async toolResult(event: ToolResultEvent): Promise<unknown> {
		return this.emit("tool_result", event as unknown as Record<string, unknown>);
	}

	#appendMessage(message: AgentMessage): string {
		const id = `entry-${this.#nextId++}`;
		const parent = this.#branch.at(-1);
		this.#branch.push({
			type: "message",
			id,
			parentId: parent?.id ?? null,
			timestamp: new Date(this.#nextId * 1_000).toISOString(),
			message,
		});
		return id;
	}
}
