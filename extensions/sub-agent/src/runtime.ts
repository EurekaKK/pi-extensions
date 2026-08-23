import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DESCRIPTOR_VERSION, REPORT_MESSAGE_TYPE, SETTLEMENT_MESSAGE_TYPE } from "./constants.js";
import type {
	ChildMessage,
	ChildRecord,
	ChildSessionFactory,
	ChildStatus,
	SubAgentConfigV2,
	SubAgentDescriptorV1,
	SubagentDelegationToolConfigV2,
	SubagentProviderName,
	SubagentRunOutcome,
	SubagentRunStatus,
	SubagentStartResult,
} from "./domain.js";
import { SubagentError } from "./domain.js";

export interface SubagentManagerOptions {
	readonly config: SubAgentConfigV2;
	readonly pi: Pick<ExtensionAPI, "sendMessage">;
	readonly childFactory: ChildSessionFactory;
	readonly ownerSessionId: string;
	readonly cwd: string;
	readonly depth: number;
	readonly parentSessionFile?: string | undefined;
	readonly parentModel: { readonly provider: string; readonly id: string };
	readonly parentThinkingLevel: string;
	readonly parentToolNames: readonly string[];
	readonly childSessionDir?: string | undefined;
	readonly getForkBoundary?: (() => string | undefined) | undefined;
	readonly now?: (() => number) | undefined;
	readonly onStateChanged?: ((agents: readonly SubagentUiEntry[]) => void) | undefined;
}

export interface SubagentListEntry {
	readonly childId: string;
	readonly label: string;
	readonly status: ChildStatus;
	readonly parentSessionId: string;
	readonly depth: number;
	readonly diagnostic?: "corrupt" | "unsupported" | "unavailable";
}

export interface SubagentUiEntry {
	readonly childId: string;
	readonly label: string;
	readonly status: SubagentRunStatus;
}

interface StartChildInput {
	readonly policy: SubagentDelegationToolConfigV2;
	readonly provider: SubagentProviderName;
	readonly mode: "one-shot" | "continuable";
	readonly label: string;
	readonly prompt: string;
	readonly signal?: AbortSignal | undefined;
}

const managerRegistry = new Map<string, SubagentManager>();

function registerManager(manager: SubagentManager): void {
	const previous = managerRegistry.get(manager.ownerSessionId);
	if (previous !== undefined && previous !== manager) void previous.shutdown();
	managerRegistry.set(manager.ownerSessionId, manager);
}

function unregisterManager(manager: SubagentManager): void {
	if (managerRegistry.get(manager.ownerSessionId) === manager) managerRegistry.delete(manager.ownerSessionId);
}

function freezeDescriptor(descriptor: SubAgentDescriptorV1): SubAgentDescriptorV1 {
	return Object.freeze({
		...descriptor,
		model: Object.freeze({ ...descriptor.model }),
		...(descriptor.toolFilter === undefined
			? {}
			: {
					toolFilter: Object.freeze({
						...(descriptor.toolFilter.allow === undefined
							? {}
							: { allow: Object.freeze([...descriptor.toolFilter.allow]) }),
						...(descriptor.toolFilter.deny === undefined
							? {}
							: { deny: Object.freeze([...descriptor.toolFilter.deny]) }),
					}),
				}),
	});
}

function applyToolFilter(
	tools: readonly string[],
	filter: SubagentDelegationToolConfigV2["toolFilter"],
): readonly string[] {
	if (filter === null) return [...tools];
	let result = [...tools];
	if (filter.allow !== undefined) result = result.filter((tool) => filter.allow?.includes(tool) === true);
	if (filter.deny !== undefined) result = result.filter((tool) => filter.deny?.includes(tool) !== true);
	return Object.freeze(result);
}

function finalChildText(messages: readonly ChildMessage[]): string {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role === "assistant" && message.text.trim().length > 0) return message.text;
	}
	return "";
}

export class SubagentManager {
	readonly ownerSessionId: string;
	readonly config: SubAgentConfigV2;
	readonly depth: number;
	readonly #pi: SubagentManagerOptions["pi"];
	readonly #childFactory: ChildSessionFactory;
	readonly #cwd: string;
	readonly #parentSessionFile: string | undefined;
	readonly #parentModel: { readonly provider: string; readonly id: string };
	readonly #parentThinkingLevel: string;
	readonly #parentToolNames: readonly string[];
	readonly #childSessionDir: string | undefined;
	readonly #getForkBoundary: (() => string | undefined) | undefined;
	readonly #now: () => number;
	readonly #onStateChanged: ((agents: readonly SubagentUiEntry[]) => void) | undefined;
	readonly #children = new Map<string, ChildRecord>();
	#shutdown = false;

	constructor(options: SubagentManagerOptions) {
		this.ownerSessionId = options.ownerSessionId;
		this.config = options.config;
		this.depth = options.depth;
		this.#pi = options.pi;
		this.#childFactory = options.childFactory;
		this.#cwd = options.cwd;
		this.#parentSessionFile = options.parentSessionFile;
		this.#parentModel = options.parentModel;
		this.#parentThinkingLevel = options.parentThinkingLevel;
		this.#parentToolNames = options.parentToolNames;
		this.#childSessionDir = options.childSessionDir;
		this.#getForkBoundary = options.getForkBoundary;
		this.#now = options.now ?? Date.now;
		this.#onStateChanged = options.onStateChanged;
		registerManager(this);
	}

	start(
		policy: SubagentDelegationToolConfigV2,
		label: string,
		prompt: string,
		runInBackground: boolean,
		signal?: AbortSignal,
	): Promise<SubagentStartResult> {
		if (runInBackground && policy.backgroundMode === "one-shot") {
			throw new SubagentError(`delegation tool ${policy.toolName} does not support background one-shot jobs`);
		}
		const mode = runInBackground ? "continuable" : "one-shot";
		return this.#startChild(
			{
				policy,
				provider: policy.provider,
				mode,
				label,
				prompt,
				signal,
			},
			!runInBackground,
		);
	}

	async sendMessage(childId: string, text: string): Promise<string> {
		this.#assertMutable();
		const record = this.#requireChild(childId);
		if (record.mode !== "continuable") throw new SubagentError(`subagent ${childId} is not continuable`);
		record.pending.push({ messageId: randomUUID(), text });
		if (record.status === "running" || record.active) {
			return `message queued as the next turn for subagent ${childId}`;
		}
		const next = record.pending.shift();
		if (next !== undefined) void this.#activateContinuable(record, next.text);
		return `message queued as the next turn for subagent ${childId}`;
	}

	interrupt(childId: string): void {
		const record = this.#children.get(childId);
		if (record !== undefined) {
			if ((record.runStatus === "running" || record.runStatus === "interrupting") && !record.interruptRequested) {
				record.interruptRequested = true;
				record.runStatus = "interrupting";
				this.#emitState();
				void record.live?.abort().catch(() => undefined);
			}
			return;
		}
		for (const child of this.#children.values()) {
			if (child.mode !== "continuable") continue;
			const childManager = managerRegistry.get(child.childId);
			if (childManager !== undefined) childManager.interrupt(childId);
		}
	}

	listChildren(): readonly SubagentListEntry[] {
		return [...this.#children.values()]
			.filter((record) => record.mode === "continuable")
			.map((record) => this.#listEntry(record));
	}

	listDescendants(): readonly SubagentListEntry[] {
		const entries: SubagentListEntry[] = [];
		const queue = [...this.listChildren()];
		while (queue.length > 0) {
			const entry = queue.shift();
			if (entry === undefined) continue;
			entries.push(entry);
			const childManager = managerRegistry.get(entry.childId);
			if (childManager === undefined) continue;
			queue.push(...childManager.listChildren());
		}
		return Object.freeze(entries);
	}

	list(scope: "children" | "descendants"): readonly SubagentListEntry[] {
		return scope === "children" ? this.listChildren() : this.listDescendants();
	}

	listUiAgents(): readonly SubagentUiEntry[] {
		return Object.freeze(
			[...this.#children.values()].map((record) =>
				Object.freeze({ childId: record.childId, label: record.label, status: record.runStatus }),
			),
		);
	}

	acceptChildMessage(input: {
		readonly record: ChildRecord;
		readonly customType: typeof REPORT_MESSAGE_TYPE | typeof SETTLEMENT_MESSAGE_TYPE;
		readonly text: string;
		readonly wakeup: boolean;
		readonly runId?: string;
		readonly outcome?: SubagentRunOutcome;
	}): Promise<void> {
		const content =
			input.customType === REPORT_MESSAGE_TYPE
				? `Background subagent ${input.record.childId} reported:\n${input.text}`
				: `Background subagent ${input.record.childId} finished:\n${input.text}`;
		this.#pi.sendMessage(
			{
				customType: input.customType,
				content,
				display: true,
				details: {
					version: 1,
					childId: input.record.childId,
					label: input.record.label,
					...(input.runId === undefined ? {} : { runId: input.runId }),
					...(input.outcome === undefined ? {} : { outcome: input.outcome }),
				},
			},
			{ triggerTurn: input.wakeup },
		);
		return Promise.resolve();
	}

	async shutdown(): Promise<void> {
		this.#shutdown = true;
		const records = [...this.#children.values()];
		for (const record of records) {
			if (record.active) await record.live?.abort().catch(() => undefined);
		}
		for (const record of records) {
			if (record.live !== undefined) await record.live.dispose().catch(() => undefined);
		}
		this.#children.clear();
		unregisterManager(this);
	}

	#listEntry(record: ChildRecord): SubagentListEntry {
		return Object.freeze({
			childId: record.childId,
			label: record.label,
			status: record.status,
			parentSessionId: record.parentSessionId,
			depth: record.depth,
		});
	}

	#emitState(): void {
		if (this.#shutdown || this.#onStateChanged === undefined) return;
		try {
			this.#onStateChanged(this.listUiAgents());
		} catch {
			// Advisory UI projection only.
		}
	}

	#settle(record: ChildRecord, outcome: SubagentRunOutcome): void {
		record.active = false;
		record.interruptRequested = false;
		record.runStatus = outcome;
		record.status = record.mode === "continuable" ? "ready" : "idle";
		this.#emitState();
		if (
			[...this.#children.values()].some((child) => child.runStatus === "running" || child.runStatus === "interrupting")
		) {
			return;
		}
		let removed = false;
		for (const [childId, child] of this.#children) {
			if (child.mode === "one-shot") {
				this.#children.delete(childId);
				removed = true;
			}
		}
		if (removed) this.#emitState();
	}

	async #disposeLive(record: ChildRecord): Promise<void> {
		const live = record.live;
		record.live = undefined;
		if (live !== undefined) await live.dispose().catch(() => undefined);
	}

	#beginRun(record: ChildRecord): void {
		record.active = true;
		record.interruptRequested = false;
		record.runId = randomUUID();
		record.runStatus = "running";
		record.status = "running";
		this.#emitState();
	}

	async #startChild(input: StartChildInput, foreground: boolean): Promise<SubagentStartResult> {
		this.#assertMutable();
		input.signal?.throwIfAborted();
		const childDepth = this.depth + 1;
		if (!Number.isSafeInteger(childDepth)) throw new RangeError("subagent child depth exceeds the safe-integer range");
		if (childDepth > input.policy.maxDepth) {
			throw new SubagentError(`subagent depth ${childDepth} exceeds maxDepth ${input.policy.maxDepth}`);
		}

		const childId = randomUUID();
		const model = this.#resolveModel(input.policy);
		const thinkingLevel = this.#resolveThinkingLevel(input.policy);
		const toolNames = applyToolFilter(this.#parentToolNames, input.policy.toolFilter);
		const descriptor = freezeDescriptor({
			version: DESCRIPTOR_VERSION,
			childId,
			parentSessionId: this.ownerSessionId,
			provider: input.provider,
			mode: input.mode,
			depth: childDepth,
			model,
			thinkingLevel,
			...(input.policy.toolFilter === null ? {} : { toolFilter: input.policy.toolFilter }),
			...(input.policy.persona === null ? {} : { persona: input.policy.persona }),
			createdAt: this.#now(),
		});
		const record: ChildRecord = {
			childId,
			parentSessionId: this.ownerSessionId,
			provider: input.provider,
			mode: input.mode,
			depth: childDepth,
			label: input.label,
			active: false,
			interruptRequested: false,
			runId: randomUUID(),
			runStatus: "running",
			pending: [],
			status: "ready",
			descriptor,
		};
		this.#children.set(childId, record);
		this.#emitState();

		let handle: Awaited<ReturnType<ChildSessionFactory["create"]>>;
		try {
			handle = await this.#childFactory.create({
				childId,
				provider: input.provider,
				mode: input.mode,
				parentSessionId: this.ownerSessionId,
				parentSessionFile: this.#parentSessionFile,
				...(input.provider === "fork" && this.#getForkBoundary !== undefined
					? { forkBeforeEntryId: this.#getForkBoundary() }
					: {}),
				cwd: this.#cwd,
				...(input.mode === "continuable" && this.#childSessionDir !== undefined
					? { sessionDir: this.#childSessionDir }
					: {}),
				depth: childDepth,
				model,
				thinkingLevel,
				toolNames,
				...(input.policy.toolFilter === null ? {} : { toolFilter: input.policy.toolFilter }),
				...(input.policy.persona === null ? {} : { persona: input.policy.persona }),
				prompt: input.prompt,
				signal: input.signal,
				onReport: (output) => this.#acceptChildReport(childId, output),
			});
		} catch (error) {
			this.#children.delete(childId);
			this.#emitState();
			throw error;
		}

		record.live = handle;
		record.sessionFile = handle.sessionFile;
		record.status = "idle";

		if (record.interruptRequested) {
			record.active = true;
			const runId = record.runId;
			await handle.abort().catch(() => undefined);
			await this.#disposeLive(record);
			this.#settle(record, "interrupted");
			if (foreground) {
				const error = new Error("Subagent run interrupted before start");
				error.name = "AbortError";
				throw error;
			}
			void this.#notifySettlement(record, runId, "interrupted", "subagent run cancelled: interrupted before start");
			return { childId, foreground: false };
		}

		if (foreground) {
			record.active = true;
			record.status = "running";
			this.#emitState();
			try {
				await handle.prompt(input.prompt);
				const output = finalChildText(handle.messages());
				const outcome: SubagentRunOutcome = record.interruptRequested ? "interrupted" : "completed";
				await this.#disposeLive(record);
				this.#settle(record, outcome);
				return { childId, foreground: true, output };
			} catch (error) {
				const interrupted = record.interruptRequested || (error instanceof Error && error.name === "AbortError");
				await this.#disposeLive(record);
				this.#settle(record, interrupted ? "interrupted" : "failed");
				throw error;
			}
		}

		void this.#activateContinuable(record, input.prompt);
		return { childId, foreground: false };
	}

	async #activateContinuable(record: ChildRecord, text: string): Promise<void> {
		if (record.active) {
			record.pending.push({ messageId: randomUUID(), text });
			return;
		}
		this.#beginRun(record);
		let turnText = text;
		try {
			let handle = record.live;
			if (handle === undefined) {
				handle = await this.#childFactory.create({
					childId: record.childId,
					provider: record.provider,
					mode: record.mode,
					parentSessionId: record.parentSessionId,
					parentSessionFile: this.#parentSessionFile,
					cwd: this.#cwd,
					...(this.#childSessionDir === undefined ? {} : { sessionDir: this.#childSessionDir }),
					depth: record.depth,
					model: record.descriptor.model,
					thinkingLevel: record.descriptor.thinkingLevel,
					toolNames: applyToolFilter(this.#parentToolNames, record.descriptor.toolFilter ?? null),
					...(record.descriptor.toolFilter === undefined ? {} : { toolFilter: record.descriptor.toolFilter }),
					...(record.descriptor.persona === undefined ? {} : { persona: record.descriptor.persona }),
					prompt: turnText,
					onReport: (output) => this.#acceptChildReport(record.childId, output),
				});
				record.live = handle;
				record.sessionFile = handle.sessionFile;
			}

			if (record.interruptRequested) {
				const runId = record.runId;
				await handle.abort().catch(() => undefined);
				await this.#disposeLive(record);
				this.#settle(record, "interrupted");
				void this.#notifySettlement(record, runId, "interrupted", "subagent run cancelled: interrupted before start");
				return;
			}

			while (record.active) {
				await handle.prompt(turnText);
				if (record.interruptRequested) break;
				const next = record.pending.shift();
				if (next === undefined) break;
				turnText = next.text;
			}

			const output = finalChildText(handle.messages());
			const outcome: SubagentRunOutcome = record.interruptRequested ? "interrupted" : "completed";
			const runId = record.runId;
			await this.#disposeLive(record);
			this.#settle(record, outcome);
			void this.#notifySettlement(record, runId, outcome, output);
			if (outcome === "completed") {
				const next = record.pending.shift();
				if (next !== undefined) void this.#activateContinuable(record, next.text);
			}
		} catch (error) {
			const interrupted = record.interruptRequested || (error instanceof Error && error.name === "AbortError");
			const outcome: SubagentRunOutcome = interrupted ? "interrupted" : "failed";
			const runId = record.runId;
			await this.#disposeLive(record);
			this.#settle(record, outcome);
			const reason = interrupted ? "cancelled" : "failed";
			void this.#notifySettlement(
				record,
				runId,
				outcome,
				`subagent run ${reason}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	#resolveModel(policy: SubagentDelegationToolConfigV2): { readonly provider: string; readonly id: string } {
		return policy.agentOptions.model === "inherit" ? this.#parentModel : policy.agentOptions.model;
	}

	#resolveThinkingLevel(policy: SubagentDelegationToolConfigV2): string {
		return policy.agentOptions.thinkingLevel === "inherit"
			? this.#parentThinkingLevel
			: policy.agentOptions.thinkingLevel;
	}

	#requireChild(childId: string): ChildRecord {
		const record = this.#children.get(childId);
		if (record === undefined) throw new SubagentError(`subagent ${childId} was not found`);
		return record;
	}

	#assertMutable(): void {
		if (this.#shutdown) throw new SubagentError("sub-agent runtime is shut down");
	}

	async #acceptChildReport(childId: string, output: string): Promise<string> {
		const record = this.#requireChild(childId);
		await this.acceptChildMessage({
			record,
			customType: REPORT_MESSAGE_TYPE,
			text: output,
			wakeup: this.config.reportDelivery === "wakeup",
			runId: record.runId,
		});
		return "message queued for parent";
	}

	async #notifySettlement(
		record: ChildRecord,
		runId: string,
		outcome: SubagentRunOutcome,
		output: string,
	): Promise<void> {
		try {
			await this.acceptChildMessage({
				record,
				customType: SETTLEMENT_MESSAGE_TYPE,
				text: output,
				wakeup: true,
				runId,
				outcome,
			});
		} catch {
			// Settlement is best-effort when the parent session is no longer live.
		}
	}
}
