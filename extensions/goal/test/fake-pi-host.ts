import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";

/**
 * Minimal fake Pi host, shaped to move verbatim into a shared test-host
 * package later. One place casts to the real ExtensionAPI/ExtensionContext
 * types; test files stay cast-free and describe scenarios only.
 */

type Handler = (event: Record<string, unknown>, context: ExtensionContext) => unknown | Promise<unknown>;

export interface CapturedCommand {
	readonly description: string;
	handler(argumentsText: string, context: ExtensionContext): unknown | Promise<unknown>;
}

export interface CapturedTool {
	readonly name: string;
	readonly label?: string;
	readonly description?: string;
	readonly parameters?: unknown;
	readonly executionMode?: string;
	execute(
		toolCallId: string,
		parameters: never,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		context: ExtensionContext,
	): Promise<{ details?: unknown; content?: unknown }> | { details?: unknown; content?: unknown };
}

export interface AppendedEntry {
	readonly customType: string;
	readonly data: unknown;
}

export interface SentMessage {
	readonly message: Record<string, unknown>;
	readonly options: Record<string, unknown> | undefined;
}

export interface FakePiHostOptions {
	readonly mode?: ExtensionContext["mode"];
	readonly hasUI?: boolean;
	readonly sessionId?: string;
}

export class FakePiHost {
	readonly tools: CapturedTool[] = [];
	readonly commands = new Map<string, CapturedCommand>();
	readonly appendedEntries: AppendedEntry[] = [];
	readonly sentMessages: SentMessage[] = [];
	readonly ui = {
		setWidget: vi.fn<(key: string, component: unknown, options?: { placement?: string }) => void>(),
		setStatus: vi.fn<(key: string, value: unknown) => void>(),
		notify: vi.fn<(message: string, level?: string) => void>(),
	};
	failAppend = false;
	failSend = false;

	readonly api: ExtensionAPI;
	readonly context: ExtensionContext;

	#handlers = new Map<string, Handler[]>();
	#entries: SessionEntry[] = [];
	#nextId = 1;
	readonly #mode: ExtensionContext["mode"];
	readonly #hasUI: boolean;
	readonly #sessionId: string;

	constructor(options: FakePiHostOptions = {}) {
		this.#mode = options.mode ?? "tui";
		this.#hasUI = options.hasUI ?? true;
		this.#sessionId = options.sessionId ?? "session-1";

		this.api = {
			on: (event: string, handler: Handler) => {
				const handlers = this.#handlers.get(event) ?? [];
				handlers.push(handler);
				this.#handlers.set(event, handlers);
			},
			registerTool: (tool: CapturedTool) => {
				this.tools.push(tool);
			},
			registerCommand: (name: string, command: CapturedCommand) => {
				this.commands.set(name, command);
			},
			appendEntry: (customType: string, data: unknown) => {
				if (this.failAppend) throw new Error("disk unavailable");
				const parent = this.#entries.at(-1);
				const entry = {
					type: "custom",
					id: `entry-${this.#nextId++}`,
					parentId: parent?.id ?? null,
					timestamp: new Date().toISOString(),
					customType,
					data,
				} as SessionEntry;
				this.#entries.push(entry);
				this.appendedEntries.push({ customType, data });
			},
			sendMessage: (message: Record<string, unknown>, options?: Record<string, unknown>) => {
				if (this.failSend) throw new Error("send failed");
				this.sentMessages.push({ message, options });
			},
		} as unknown as ExtensionAPI;

		this.context = {
			mode: this.#mode,
			hasUI: this.#hasUI,
			ui: {
				notify: this.ui.notify,
				setStatus: this.ui.setStatus,
				setWidget: this.ui.setWidget,
			},
			sessionManager: {
				getSessionId: () => this.#sessionId,
				getBranch: () => [...this.#entries],
			},
		} as unknown as ExtensionContext;
	}

	async emit(event: string, payload: Record<string, unknown> = {}): Promise<void> {
		for (const handler of this.#handlers.get(event) ?? []) await handler(payload, this.context);
	}

	branch(): readonly SessionEntry[] {
		return [...this.#entries];
	}

	setBranch(entries: readonly SessionEntry[]): void {
		this.#entries = [...entries];
	}

	branchEntry(id: string, parentId: string | null, data: Record<string, unknown>): void {
		this.#entries.push({ id, parentId, timestamp: new Date().toISOString(), ...data } as SessionEntry);
	}
}
