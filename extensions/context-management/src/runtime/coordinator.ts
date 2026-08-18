import {
	type AgentEndEvent,
	type ContextEvent,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
	type SessionCompactEvent,
	type SessionEntry,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { restoreLatestCheckpoint } from "../compaction/details.js";
import {
	type CheckpointCandidate,
	candidateCompactionResult,
	createCheckpointCandidate,
	isCandidateCompatible,
} from "../compaction/lifecycle.js";
import { type CompactableSelection, selectCompactable } from "../compaction/selection.js";
import type { ContextManagementConfigV1 } from "../config.js";
import { ContextManagementError, errorMessage, throwIfAborted } from "../errors.js";
import { applyPruneToMessages } from "../prune.js";
import { deriveContextBudget } from "./budget.js";
import { type CompiledContext, compileContext } from "./compiler.js";
import type { RuntimeState } from "./state.js";

type AgentMessage = ContextEvent["messages"][number];

function combinedSignal(state: RuntimeState, context: ExtensionContext): AbortSignal {
	const signals = [state.shutdownController.signal, context.signal].filter(
		(signal): signal is AbortSignal => signal !== undefined,
	);
	return signals.length === 1 ? (signals[0] as AbortSignal) : AbortSignal.any(signals);
}

function activeInstalledId(state: RuntimeState): string | null {
	return state.installedCheckpoint?.entryId ?? null;
}

function failureCode(error: unknown, fallbackCode: string): string {
	return error instanceof ContextManagementError ? error.code : fallbackCode;
}

function notify(context: ExtensionContext, message: string, type: "info" | "warning" | "error"): void {
	if (!context.hasUI) return;
	try {
		context.ui.notify(message, type);
	} catch {
		// Advisory UI only.
	}
}

function compatible(state: RuntimeState, candidate: CheckpointCandidate, context: ExtensionContext): boolean {
	return isCandidateCompatible({
		candidate,
		runtimeGeneration: state.runtimeGeneration,
		branchEpoch: state.branchEpoch,
		installedCheckpointEntryId: activeInstalledId(state),
		contextEntries: context.sessionManager.buildContextEntries(),
	});
}

function nativeTailTarget(
	reason: SessionBeforeCompactEvent["reason"],
	contextWindow: number,
	config: ContextManagementConfigV1,
): number {
	if (reason === "manual" || reason === "overflow") return 0;
	return deriveContextBudget(contextWindow, config).retainTokens;
}

function selectVisibleCompactable(
	context: ExtensionContext,
	reason: SessionBeforeCompactEvent["reason"],
	config: ContextManagementConfigV1,
	currentRunEntryId: string | null,
): CompactableSelection | null {
	const model = context.model;
	if (model === undefined) {
		throw new ContextManagementError("context_management.compaction_infeasible", "No active model is selected.");
	}
	const contextEntries = context.sessionManager.buildContextEntries();
	return selectCompactable({
		messages: contextEntries.flatMap((entry) => sessionEntryToContextMessages(entry)),
		contextEntries,
		tailTarget: nativeTailTarget(reason, model.contextWindow, config),
		currentRunEntryId,
	});
}

export class ContextCoordinator {
	readonly #pi: ExtensionAPI;
	readonly #config: ContextManagementConfigV1;
	readonly state: RuntimeState;
	#installRequested = false;
	#compacting = false;

	constructor(pi: ExtensionAPI, state: RuntimeState, config: ContextManagementConfigV1) {
		this.#pi = pi;
		this.state = state;
		this.#config = config;
	}

	sessionStart(context: ExtensionContext): void {
		this.#resetBranch(context);
	}

	beforeAgentStart(_prompt: string, context: ExtensionContext): void {
		this.state.runGeneration += 1;
		this.state.currentRunParentEntryId = context.sessionManager.getLeafId();
		this.state.currentRunEntryId = null;
	}

	async context(event: ContextEvent, context: ExtensionContext): Promise<{ messages: AgentMessage[] }> {
		try {
			throwIfAborted(combinedSignal(this.state, context));
			this.#resolveCurrentRunEntry(context);
			if (context.model === undefined) {
				return { messages: event.messages.map((message) => structuredClone(message)) };
			}

			let messages = this.#prune(event.messages, false);
			let compiled = compileContext({
				pi: this.#pi,
				context,
				eventMessages: messages,
				state: this.state,
				config: this.#config,
			});
			if (this.#config.auto && compiled.overThreshold) {
				messages = this.#prune(messages, true);
				compiled = compileContext({
					pi: this.#pi,
					context,
					eventMessages: messages,
					state: this.state,
					config: this.#config,
				});
			}

			if (this.#config.auto && compiled.overThreshold && compiled.compactable !== null && !this.#compacting) {
				compiled = await this.#compactCompiled(compiled, context);
			}

			this.state.blockingState = null;
			this.state.lastRawEstimate = compiled.rawEstimate;
			this.state.lastRequestModel =
				context.model === undefined ? null : { provider: context.model.provider, id: context.model.id };
			this.state.lastSafeProjection = compiled.messages.map((message) => structuredClone(message));
			return { messages: compiled.messages };
		} catch (error) {
			if (error instanceof ContextManagementError && error.code === "context_management.operation_aborted") {
				throw error;
			}
			const code = failureCode(error, "context_management.context_estimate_failure");
			this.state.blockingState = code;
			notify(context, `Context compaction skipped [${code}]: ${errorMessage(error)}`, "warning");
			const fallback =
				this.state.lastSafeProjection.length === 0
					? event.messages.map((message) => structuredClone(message))
					: this.state.lastSafeProjection.map((message) => structuredClone(message));
			return { messages: fallback };
		}
	}

	agentEnd(event: AgentEndEvent): void {
		const request = this.state.lastRequestModel;
		const raw = this.state.lastRawEstimate;
		if (request === null || raw === null) return;
		const assistant = [...event.messages].reverse().find((message) => message.role === "assistant");
		if (assistant?.role !== "assistant" || assistant.stopReason === "error" || assistant.stopReason === "aborted") {
			return;
		}
		this.state.calibration.record(
			request.provider,
			request.id,
			raw,
			assistant.usage.input + assistant.usage.cacheRead + assistant.usage.cacheWrite,
		);
	}

	agentSettled(context: ExtensionContext): void {
		this.state.currentRunParentEntryId = null;
		this.state.currentRunEntryId = null;
		const pending = this.state.pendingCheckpoint;
		if (pending !== undefined && compatible(this.state, pending, context)) {
			this.#requestInstall(context, pending);
		}
	}

	async beforeCompact(
		event: SessionBeforeCompactEvent,
		context: ExtensionContext,
	): Promise<{ cancel?: boolean; compaction?: ReturnType<typeof candidateCompactionResult> }> {
		try {
			const compactionSignal = AbortSignal.any([event.signal, this.state.shutdownController.signal]);
			const pending = this.state.pendingCheckpoint;
			if (pending !== undefined && compatible(this.state, pending, context)) {
				return { compaction: candidateCompactionResult(pending) };
			}

			if (!this.#config.auto && event.reason !== "manual") return { cancel: true };

			const nativeSelection = selectVisibleCompactable(
				context,
				event.reason,
				this.#config,
				this.state.currentRunEntryId,
			);
			if (nativeSelection === null) return { cancel: true };

			const pruned = applyPruneToMessages(
				nativeSelection.newlyEligibleMessages,
				this.#config.prune,
				this.state.prunedToolCallIds,
				true,
			);
			for (const id of pruned.newlyPrunedIds) this.state.prunedToolCallIds.add(id);
			const selection: CompactableSelection = Object.freeze({
				...nativeSelection,
				newlyEligibleMessages: Object.freeze(pruned.messages),
			});
			if (selection.newlyEligibleMessages.length === 0) return { cancel: true };

			const candidate = await this.#generateFromSelection(
				context,
				selection,
				context.sessionManager.buildContextEntries(),
				event.preparation.tokensBefore,
				compactionSignal,
			);
			this.#installInMemory(candidate);
			return { compaction: candidateCompactionResult(candidate) };
		} catch (error) {
			const code = failureCode(error, "context_management.compactor_transport_failure");
			notify(context, `Compaction cancelled [${code}]: ${errorMessage(error)}`, "error");
			return { cancel: true };
		}
	}

	sessionCompact(event: SessionCompactEvent, context: ExtensionContext): void {
		this.state.installedCheckpoint = restoreLatestCheckpoint(context.sessionManager.getBranch());
		this.state.pendingCheckpoint = undefined;
		this.state.branchEpoch += 1;
		this.#installRequested = false;
		if (!event.fromExtension && context.mode === "tui") {
			notify(context, "Context compaction was restored as a legacy checkpoint.", "warning");
		}
	}

	sessionTree(context: ExtensionContext): void {
		this.state.branchEpoch += 1;
		this.#resetBranch(context);
	}

	shutdown(context: ExtensionContext): void {
		this.state.runtimeGeneration += 1;
		this.state.shutdownController.abort();
		this.state.pendingCheckpoint = undefined;
		this.state.currentRunParentEntryId = null;
		this.state.currentRunEntryId = null;
		if (context.hasUI) {
			try {
				context.ui.setWorkingMessage();
			} catch {
				// Advisory UI only.
			}
		}
	}

	#prune(messages: readonly AgentMessage[], pruneOversized: boolean): AgentMessage[] {
		const pruned = applyPruneToMessages(messages, this.#config.prune, this.state.prunedToolCallIds, pruneOversized);
		for (const id of pruned.newlyPrunedIds) this.state.prunedToolCallIds.add(id);
		return pruned.messages;
	}

	async #compactCompiled(compiled: CompiledContext, context: ExtensionContext): Promise<CompiledContext> {
		this.#compacting = true;
		if (context.mode === "tui") {
			try {
				context.ui.setWorkingMessage("Compacting conversation…");
			} catch {
				// Advisory UI only.
			}
		}
		try {
			let current = compiled;
			for (let attempt = 0; attempt <= this.#config.compactionRetries; attempt += 1) {
				if (!current.overThreshold || current.compactable === null) return current;
				const candidate = await this.#generateFromSelection(
					context,
					current.compactable,
					current.contextEntries,
					current.correctedEstimate,
					combinedSignal(this.state, context),
				);
				this.#installInMemory(candidate);
				current = compileContext({
					pi: this.#pi,
					context,
					eventMessages: current.messages,
					state: this.state,
					config: this.#config,
				});
			}
			return current;
		} catch (error) {
			notify(context, `Step compaction failed: ${errorMessage(error)}; continuing the turn`, "warning");
			return compiled;
		} finally {
			this.#compacting = false;
			if (context.mode === "tui") {
				try {
					context.ui.setWorkingMessage();
				} catch {
					// Advisory UI only.
				}
			}
		}
	}

	async #generateFromSelection(
		context: ExtensionContext,
		selection: CompactableSelection,
		contextEntries: readonly SessionEntry[],
		tokensBefore: number,
		signal: AbortSignal,
	): Promise<CheckpointCandidate> {
		const model = context.model;
		if (model === undefined) {
			throw new ContextManagementError("context_management.compaction_infeasible", "No active model is selected.");
		}
		return createCheckpointCandidate({
			pi: this.#pi,
			context,
			selection,
			contextEntries,
			runtimeGeneration: this.state.runtimeGeneration,
			branchEpoch: this.state.branchEpoch,
			installedCheckpointEntryId: activeInstalledId(this.state),
			tokensBefore,
			maxTokens: this.#config.maxTokens,
			calibration: this.state.calibration.get(model.provider, model.id),
			signal,
			regenerateOnce: true,
		});
	}

	#installInMemory(candidate: CheckpointCandidate): void {
		this.state.pendingCheckpoint = candidate;
	}

	#requestInstall(context: ExtensionContext, _candidate: CheckpointCandidate): void {
		if (this.#installRequested || !context.isIdle()) return;
		this.#installRequested = true;
		context.compact({
			onComplete: () => {
				this.#installRequested = false;
			},
			onError: (error) => {
				this.#installRequested = false;
				notify(context, `Checkpoint remains active in memory but could not be persisted: ${error.message}`, "error");
			},
		});
	}

	#resolveCurrentRunEntry(context: ExtensionContext): void {
		if (this.state.runGeneration === 0 || this.state.currentRunEntryId !== null) return;
		const entries = context.sessionManager.buildContextEntries();
		const parentId = this.state.currentRunParentEntryId;
		const parentIndex = parentId === null ? -1 : entries.findIndex((entry) => entry.id === parentId);
		if (parentId !== null && parentIndex < 0) return;
		const root = entries
			.slice(parentIndex + 1)
			.find((entry) => entry.type === "message" && entry.message.role === "user");
		this.state.currentRunEntryId = root?.id ?? null;
	}

	#resetBranch(context: ExtensionContext): void {
		this.state.pendingCheckpoint = undefined;
		this.state.installedCheckpoint = restoreLatestCheckpoint(context.sessionManager.getBranch());
		this.state.prunedToolCallIds.clear();
		this.state.currentRunParentEntryId = null;
		this.state.currentRunEntryId = null;
	}
}
