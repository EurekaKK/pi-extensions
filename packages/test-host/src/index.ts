import {
	buildContextEntries as buildPiContextEntries,
	type CustomMessageEntry,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
	type SessionEntryBase,
} from "@earendil-works/pi-coding-agent";

import { vi } from "vitest";

/**
 * FakePiHost — one fake Pi host for every extension's tests.
 *
 * The real ExtensionAPI/ExtensionContext types are satisfied through a single
 * cast inside this module; test files stay cast-free and describe scenarios
 * only. When Pi's interface drifts, this is the one place to update.
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
	readonly promptGuidelines?: readonly string[];
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

export interface CapturedShortcut {
	readonly description: string;
	handler(context: ExtensionContext): unknown | Promise<unknown>;
}

export interface FakePiHostOptions {
	readonly mode?: ExtensionContext["mode"];
	readonly hasUI?: boolean;
	readonly sessionId?: string;
	/** Working Directory exposed through the fake ExtensionContext. */
	readonly cwd?: string;
}

export class FakePiHost {
	readonly tools: CapturedTool[] = [];
	readonly commands = new Map<string, CapturedCommand>();
	readonly shortcuts = new Map<string, CapturedShortcut>();
	readonly messageRenderers = new Map<string, unknown>();
	readonly appendedEntries: AppendedEntry[] = [];
	readonly sentMessages: SentMessage[] = [];
	readonly ui = {
		setWidget: vi.fn<(key: string, component: unknown, options?: { placement?: string }) => void>(),
		setStatus: vi.fn<(key: string, value: unknown) => void>(),
		notify: vi.fn<(message: string, level?: string) => void>(),
	};
	/** When true, api.appendEntry throws before recording anything. */
	failAppend = false;
	/** When true, api.sendMessage throws before recording anything. */
	failSend = false;
	/** When true, context.sessionManager.getBranch throws. */
	failBranchRead = false;

	readonly api: ExtensionAPI;
	readonly context: ExtensionContext;

	#handlers = new Map<string, Handler[]>();
	#eventBusHandlers = new Map<string, Array<(data: unknown) => void>>();
	#entries: SessionEntry[] = [];
	#nextId = 1;
	readonly #mode: ExtensionContext["mode"];
	readonly #hasUI: boolean;
	readonly #sessionId: string;
	readonly #cwd: string;

	constructor(options: FakePiHostOptions = {}) {
		this.#mode = options.mode ?? "tui";
		this.#hasUI = options.hasUI ?? true;
		this.#sessionId = options.sessionId ?? "session-1";
		this.#cwd = options.cwd ?? process.cwd();

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
			registerShortcut: (shortcut: string, definition: CapturedShortcut) => {
				this.shortcuts.set(shortcut, definition);
			},
			registerMessageRenderer: (customType: string, renderer: unknown) => {
				this.messageRenderers.set(customType, renderer);
			},
			events: {
				emit: (channel: string, data: unknown) => {
					for (const handler of this.#eventBusHandlers.get(channel) ?? []) handler(data);
				},
				on: (channel: string, handler: (data: unknown) => void) => {
					const handlers = this.#eventBusHandlers.get(channel) ?? [];
					handlers.push(handler);
					this.#eventBusHandlers.set(channel, handlers);
					return () => {
						const current = this.#eventBusHandlers.get(channel) ?? [];
						this.#eventBusHandlers.set(
							channel,
							current.filter((candidate) => candidate !== handler),
						);
					};
				},
			},
			appendEntry: (customType: string, data: unknown) => {
				if (this.failAppend) throw new Error("disk unavailable");
				const entry = {
					type: "custom",
					...this.#entryBase(),
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
			cwd: this.#cwd,
			mode: this.#mode,
			hasUI: this.#hasUI,
			ui: {
				notify: this.ui.notify,
				setStatus: this.ui.setStatus,
				setWidget: this.ui.setWidget,
			},
			sessionManager: {
				getSessionId: () => this.#sessionId,
				getBranch: () => {
					if (this.failBranchRead) throw new Error("branch unavailable");
					return [...this.#entries];
				},
				getLeafId: () => this.#entries.at(-1)?.id ?? null,
				getLeafEntry: (): SessionEntry | undefined => this.#entries.at(-1),
				getEntry: (id: string): SessionEntry | undefined => this.#entries.find((entry) => entry.id === id),
				buildContextEntries: () => buildPiContextEntries([...this.#entries]),
			},
		} as unknown as ExtensionContext;
	}

	async emit(event: string, payload: Record<string, unknown> = {}): Promise<void> {
		await this.emitResults(event, payload);
	}

	/** Run handlers in registration order and expose each raw lifecycle result. */
	async emitResults(event: string, payload: Record<string, unknown> = {}): Promise<readonly unknown[]> {
		const results: unknown[] = [];
		for (const handler of this.#handlers.get(event) ?? []) results.push(await handler(payload, this.context));
		return results;
	}

	emitBus(channel: string, data: unknown): void {
		for (const handler of this.#eventBusHandlers.get(channel) ?? []) handler(data);
	}

	async invokeShortcut(shortcut: string): Promise<void> {
		await this.shortcuts.get(shortcut)?.handler(this.context);
	}

	branch(): readonly SessionEntry[] {
		return [...this.#entries];
	}

	setBranch(entries: readonly SessionEntry[]): void {
		this.#entries = [...entries];
	}

	/**
	 * Seed an already-persisted custom message directly on the active fake branch.
	 * This fixture helper does not invoke ExtensionAPI append failure or capture controls.
	 */
	appendCustomMessageEntry<T = unknown>(
		customType: string,
		content: CustomMessageEntry<T>["content"],
		display: boolean,
		details?: T,
	): string {
		const entry = {
			type: "custom_message",
			...this.#entryBase(),
			customType,
			content,
			display,
			...(details === undefined ? {} : { details }),
		} as SessionEntry;
		this.#entries.push(entry);
		return entry.id;
	}

	branchEntry(id: string, parentId: string | null, data: Record<string, unknown>): void {
		this.#entries.push({ ...data, ...this.#entryBase({ id, parentId }) } as SessionEntry);
	}

	#entryBase(identity?: { readonly id: string; readonly parentId: string | null }): Omit<SessionEntryBase, "type"> {
		return {
			id: identity?.id ?? this.#nextEntryId(),
			parentId: identity === undefined ? (this.#entries.at(-1)?.id ?? null) : identity.parentId,
			timestamp: new Date().toISOString(),
		};
	}

	#nextEntryId(): string {
		let id = `entry-${this.#nextId++}`;
		while (this.#entries.some((entry) => entry.id === id)) id = `entry-${this.#nextId++}`;
		return id;
	}
}
