import type {
	AgentEndEvent,
	ContextEvent,
	ExtensionAPI,
	ExtensionContext,
	SessionBeforeCompactEvent,
	SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";
import { restoreLatestCheckpoint } from "../compaction/details.js";
import {
	type CheckpointCandidate,
	candidateCompactionResult,
	createCheckpointCandidate,
	isCandidateCompatible,
} from "../compaction/lifecycle.js";
import { type CompactableSelection, messageIndexForEntry } from "../compaction/selection.js";
import { ContextManagementError, errorMessage, throwIfAborted } from "../errors.js";
import { applyEvidenceReductions } from "../evidence/projection.js";
import { planEvidenceReductions } from "../evidence/reducers.js";
import { indexFinalizedToolPairs } from "../evidence/references.js";
import { protectedToolCallIds, selectProtectedTail } from "./branch.js";
import { estimateProjection, evidenceNetSavingsGate } from "./budget.js";
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

function failureMetadata(error: unknown, fallbackCode: string): { readonly code: string; readonly at: string } {
	return Object.freeze({
		code: failureCode(error, fallbackCode),
		at: new Date().toISOString(),
	});
}

async function waitForCandidate(
	promise: Promise<CheckpointCandidate | null>,
	signal: AbortSignal | undefined,
): Promise<CheckpointCandidate | null> {
	throwIfAborted(signal);
	if (signal === undefined) return promise;
	return await new Promise<CheckpointCandidate | null>((resolve, reject) => {
		const aborted = () => {
			cleanup();
			reject(
				new ContextManagementError(
					"context_management.operation_aborted",
					"Context management operation aborted while waiting for checkpoint preparation.",
				),
			);
		};
		const cleanup = () => signal.removeEventListener("abort", aborted);
		signal.addEventListener("abort", aborted, { once: true });
		promise.then(
			(candidate) => {
				cleanup();
				resolve(candidate);
			},
			(error: unknown) => {
				cleanup();
				reject(error);
			},
		);
	});
}

function compatible(
	state: RuntimeState,
	candidate: CheckpointCandidate,
	context: ExtensionContext,
	focus?: string,
): boolean {
	return isCandidateCompatible({
		candidate,
		runtimeGeneration: state.runtimeGeneration,
		branchEpoch: state.branchEpoch,
		installedCheckpointEntryId: activeInstalledId(state),
		contextEntries: context.sessionManager.buildContextEntries(),
		...(focus === undefined ? {} : { focus }),
	});
}

export function selectionFromNative(event: SessionBeforeCompactEvent): CompactableSelection {
	const keptIndex = event.branchEntries.findIndex((entry) => entry.id === event.preparation.firstKeptEntryId);
	const latestCompaction = event.branchEntries
		.slice(0, Math.max(0, keptIndex))
		.findLastIndex((entry) => entry.type === "compaction");
	const previous = latestCompaction < 0 ? undefined : event.branchEntries[latestCompaction];
	const previousKeptIndex =
		previous?.type === "compaction"
			? event.branchEntries.findIndex((entry) => entry.id === previous.firstKeptEntryId)
			: -1;
	const boundaryStart = previousKeptIndex >= 0 ? previousKeptIndex : latestCompaction + 1;
	const firstEligible = event.branchEntries[Math.min(Math.max(0, boundaryStart), Math.max(0, keptIndex - 1))];
	const covered = event.branchEntries[Math.max(0, keptIndex - 1)];
	const messages = [...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages];
	return Object.freeze({
		newlyEligibleMessages: Object.freeze(messages.map((message) => structuredClone(message))),
		...(event.preparation.previousSummary === undefined
			? {}
			: { previousCheckpoint: event.preparation.previousSummary }),
		firstKeptEntryId: event.preparation.firstKeptEntryId,
		coveredThroughEntryId: covered?.id ?? event.preparation.firstKeptEntryId,
		firstEligibleEntryId: firstEligible?.id ?? event.preparation.firstKeptEntryId,
		tail: Object.freeze({
			startIndex: messages.length,
			messages: Object.freeze([]),
			estimatedTokens: 0,
			units: Object.freeze([]),
		}),
	});
}

function reductionIdentity(reduction: import("../evidence/reducers.js").EvidenceReduction): string {
	return reduction.kind === "duplicate"
		? `duplicate\u0000${reduction.old.reference}`
		: `superseded\u0000${reduction.old.reference}\u0000${reduction.replacement.reference}`;
}

export class ContextCoordinator {
	readonly #pi: ExtensionAPI;
	readonly state: RuntimeState;
	#installRequested = false;

	constructor(pi: ExtensionAPI, state: RuntimeState) {
		this.#pi = pi;
		this.state = state;
	}

	async sessionStart(context: ExtensionContext): Promise<void> {
		this.#resetBranch(context);
		const store = await this.state.memory.refresh(context.cwd, this.state.shutdownController.signal);
		if (!store.snapshot.available) {
			throw new ContextManagementError(
				"context_management.memory_unavailable",
				`${store.snapshot.unavailableReason ?? "Repository Memory is unavailable."} Path: ${store.paths.memoryFile}`,
			);
		}
	}

	async beforeAgentStart(prompt: string, context: ExtensionContext): Promise<void> {
		const runGeneration = this.state.runGeneration + 1;
		this.state.runGeneration = runGeneration;
		this.state.runTimestamp = Date.now();
		this.state.currentRunParentEntryId = context.sessionManager.getLeafId();
		this.state.currentRunEntryId = null;
		this.state.evidence.beginRun(this.state.runTimestamp);
		this.state.memoryPackSuppressed = false;
		try {
			const memoryPack = await this.state.memory.buildPack(
				context.cwd,
				prompt,
				this.state.previousMemoryPackIds,
				combinedSignal(this.state, context),
			);
			if (this.state.runGeneration !== runGeneration) return;
			this.state.memory.setActivationPrompt(prompt);
			this.state.memoryPack = memoryPack;
		} catch (error) {
			if (this.state.runGeneration !== runGeneration) return;
			this.state.memoryPack = null;
			if (context.mode === "tui") context.ui.notify(`Repository Memory unavailable: ${errorMessage(error)}`, "warning");
		}
	}

	async context(event: ContextEvent, context: ExtensionContext): Promise<{ messages: AgentMessage[] }> {
		try {
			throwIfAborted(combinedSignal(this.state, context));
			this.#resolveCurrentRunEntry(context);
			await this.#materializeReductions(event.messages, context, false);
			for (const candidate of this.state.evidence.pending) {
				if (this.state.evidence.hasReference(candidate.pair.reference)) {
					this.state.evidence.admit(candidate);
					continue;
				}
				if (candidate.pair.content.some((block) => block.type === "image") && !context.model?.input.includes("image")) {
					const safeInput = context.model === undefined ? 0 : context.model.contextWindow - 20_000;
					this.state.evidence.reject(candidate, safeInput);
					continue;
				}
				const suppressionBefore = this.state.memoryPackSuppressed;
				let attempted = compileContext({
					pi: this.#pi,
					context,
					eventMessages: event.messages,
					state: this.state,
					extraEvidence: candidate,
				});
				if (!attempted.fits || attempted.crossesBlocking) {
					attempted = await this.#recover(event.messages, context, candidate);
				}
				if (attempted.fits && !attempted.crossesBlocking) this.state.evidence.admit(candidate);
				else {
					this.state.evidence.reject(candidate, attempted.budget.safeInput);
					this.state.memoryPackSuppressed = suppressionBefore;
				}
			}

			let compiled = compileContext({
				pi: this.#pi,
				context,
				eventMessages: event.messages,
				state: this.state,
			});
			if (!compiled.fits || compiled.crossesBlocking) compiled = await this.#recover(event.messages, context);
			if (!compiled.fits || compiled.crossesBlocking) {
				throw new ContextManagementError(
					"context_management.context_cannot_fit",
					`Final request estimate ${compiled.correctedEstimate} exceeds safe input ${compiled.budget.safeInput}.`,
				);
			}
			this.state.blockingState = null;
			this.state.lastRawEstimate = compiled.rawEstimate;
			this.state.lastRequestModel =
				context.model === undefined ? null : { provider: context.model.provider, id: context.model.id };
			this.state.lastSafeProjection = compiled.messages.map((message) => structuredClone(message));
			this.#maybeStartPreparation(compiled, context);
			return { messages: compiled.messages };
		} catch (error) {
			const code = failureCode(error, "context_management.context_estimate_failure");
			this.state.blockingState = code;
			this.state.evidence.clear();
			context.abort();
			context.ui.notify(`Context request stopped [${code}]: ${errorMessage(error)}`, "error");
			const safeProjection =
				this.state.lastSafeProjection.length === 0 ? event.messages : this.state.lastSafeProjection;
			return { messages: safeProjection.map((message) => structuredClone(message)) };
		}
	}

	agentEnd(event: AgentEndEvent): void {
		const request = this.state.lastRequestModel;
		const raw = this.state.lastRawEstimate;
		if (request === null || raw === null) return;
		const assistant = [...event.messages].reverse().find((message) => message.role === "assistant");
		if (assistant?.role !== "assistant" || assistant.stopReason === "error" || assistant.stopReason === "aborted")
			return;
		const usage = assistant.usage;
		this.state.calibration.record(request.provider, request.id, raw, usage.input + usage.cacheRead + usage.cacheWrite);
	}

	agentSettled(context: ExtensionContext): void {
		this.state.previousMemoryPackIds = new Set(this.state.memoryPack?.items.map((item) => item.id) ?? []);
		this.state.memoryPack = null;
		this.state.memoryPackSuppressed = false;
		this.state.evidence.clear();
		this.state.currentRunParentEntryId = null;
		this.state.currentRunEntryId = null;
		const pending = this.state.pendingCheckpoint;
		if (pending !== undefined) {
			if (compatible(this.state, pending, context)) this.#requestInstall(context, pending);
			else {
				this.state.pendingCheckpoint = undefined;
				this.state.projectionEpoch += 1;
			}
			return;
		}
		if (this.state.preparation.kind === "ready") {
			if (compatible(this.state, this.state.preparation.candidate, context)) {
				this.#requestInstall(context, this.state.preparation.candidate);
			} else this.#discardPreparation();
		}
	}

	async beforeCompact(
		event: SessionBeforeCompactEvent,
		context: ExtensionContext,
	): Promise<{ cancel?: boolean; compaction?: ReturnType<typeof candidateCompactionResult> }> {
		try {
			const compactionSignal = AbortSignal.any([event.signal, this.state.shutdownController.signal]);
			const focus = event.customInstructions;
			const pending = this.state.pendingCheckpoint;
			if (pending !== undefined && (focus === undefined || pending.snapshot.focus === (focus.trim() || null))) {
				return { compaction: candidateCompactionResult(pending) };
			}
			const currentPreparation = this.state.preparation;
			if (
				(currentPreparation.kind === "ready" || currentPreparation.kind === "installing") &&
				compatible(this.state, currentPreparation.candidate, context, focus)
			) {
				return { compaction: candidateCompactionResult(currentPreparation.candidate) };
			}
			if (currentPreparation.kind === "preparing") {
				const candidate = await waitForCandidate(currentPreparation.promise, compactionSignal);
				if (candidate !== null && compatible(this.state, candidate, context, focus)) {
					return { compaction: candidateCompactionResult(candidate) };
				}
			}
			const evidencePairs = indexFinalizedToolPairs(event.branchEntries);
			const reductions = await planEvidenceReductions(evidencePairs, new Set(), context.cwd, compactionSignal);
			const nativeSelection = selectionFromNative(event);
			const selection: CompactableSelection = Object.freeze({
				...nativeSelection,
				newlyEligibleMessages: Object.freeze(
					applyEvidenceReductions(nativeSelection.newlyEligibleMessages, reductions),
				),
			});
			const budget = context.model === undefined ? null : context.model.contextWindow;
			if (budget === null || budget <= 20_000) throw new Error("The active model has no safe context budget.");
			const candidate = await createCheckpointCandidate({
				context,
				selection,
				contextEntries: event.branchEntries,
				evidencePairs,
				runtimeGeneration: this.state.runtimeGeneration,
				branchEpoch: this.state.branchEpoch,
				installedCheckpointEntryId: activeInstalledId(this.state),
				hardLimit: Math.min(64_000, Math.max(20_000, Math.floor((budget - 20_000) * 0.1))),
				tokensBefore: event.preparation.tokensBefore,
				...(focus === undefined ? {} : { focus }),
				signal: compactionSignal,
				regenerateOnce: true,
			});
			return { compaction: candidateCompactionResult(candidate) };
		} catch (error) {
			const code = failureCode(error, "context_management.compactor_transport_failure");
			context.ui.notify(`Compaction cancelled [${code}]: ${errorMessage(error)}`, "error");
			return { cancel: true };
		}
	}

	sessionCompact(event: SessionCompactEvent, context: ExtensionContext): void {
		this.state.installedCheckpoint = restoreLatestCheckpoint(context.sessionManager.getBranch());
		this.state.pendingCheckpoint = undefined;
		this.#discardPreparation();
		this.state.branchEpoch += 1;
		this.state.projectionEpoch += 1;
		this.state.activeReductions = Object.freeze([]);
		this.state.pendingSupersessions = Object.freeze([]);
		this.#installRequested = false;
		if (!event.fromExtension && context.mode === "tui") {
			context.ui.notify("Context compaction was restored as a legacy checkpoint.", "warning");
		}
	}

	sessionTree(context: ExtensionContext): void {
		this.state.branchEpoch += 1;
		this.#discardPreparation();
		this.state.pendingCheckpoint = undefined;
		this.state.memoryPack = null;
		this.state.memoryPackSuppressed = false;
		this.state.evidence.clear();
		this.state.currentRunParentEntryId = null;
		this.state.currentRunEntryId = null;
		this.state.activeReductions = Object.freeze([]);
		this.state.pendingSupersessions = Object.freeze([]);
		this.state.installedCheckpoint = restoreLatestCheckpoint(context.sessionManager.getBranch());
	}

	shutdown(context: ExtensionContext): void {
		this.state.runtimeGeneration += 1;
		this.state.shutdownController.abort();
		this.#discardPreparation();
		this.state.pendingCheckpoint = undefined;
		this.state.memoryPack = null;
		this.state.evidence.clear();
		this.state.currentRunParentEntryId = null;
		this.state.currentRunEntryId = null;
		this.state.pendingSupersessions = Object.freeze([]);
		context.ui.setWorkingMessage();
	}

	async #recover(
		eventMessages: readonly AgentMessage[],
		context: ExtensionContext,
		extraEvidence?: import("../evidence/state.js").EvidenceAdmissionCandidate,
	): Promise<CompiledContext> {
		this.state.blockingState = "recovering";
		await this.#materializeReductions(eventMessages, context, true);
		let compiled = compileContext({
			pi: this.#pi,
			context,
			eventMessages,
			state: this.state,
			...(extraEvidence === undefined ? {} : { extraEvidence }),
		});
		if (compiled.fits && !compiled.crossesBlocking) return compiled;

		const prepared = await this.#compatiblePrepared(context);
		if (prepared !== null) {
			this.#installInMemory(prepared);
			compiled = compileContext({
				pi: this.#pi,
				context,
				eventMessages,
				state: this.state,
				...(extraEvidence === undefined ? {} : { extraEvidence }),
			});
			if (compiled.fits && !compiled.crossesBlocking) return compiled;
		}

		if (compiled.compactable !== null) {
			if (context.mode === "tui") context.ui.setWorkingMessage("Recovering context with a checkpoint…");
			try {
				const attemptedBoundaries = new Set<string>();
				while ((!compiled.fits || compiled.crossesBlocking) && compiled.compactable !== null) {
					if (compiled.compactableEstimate > compiled.blockingThreshold) {
						throw new ContextManagementError(
							"context_management.compaction_infeasible",
							`Compactable source estimate ${compiled.compactableEstimate} exceeds synchronous compaction capacity ${compiled.blockingThreshold}.`,
						);
					}
					const boundary = `${compiled.compactable.firstEligibleEntryId}\u0000${compiled.compactable.coveredThroughEntryId}\u0000${compiled.compactable.firstKeptEntryId}`;
					if (attemptedBoundaries.has(boundary)) {
						throw new ContextManagementError(
							"context_management.compaction_infeasible",
							"Synchronous compaction did not advance the covered prefix.",
						);
					}
					attemptedBoundaries.add(boundary);
					const candidate = await this.#generate(compiled, context, combinedSignal(this.state, context), true);
					this.#installInMemory(candidate);
					compiled = compileContext({
						pi: this.#pi,
						context,
						eventMessages,
						state: this.state,
						...(extraEvidence === undefined ? {} : { extraEvidence }),
					});
				}
			} finally {
				if (context.mode === "tui") context.ui.setWorkingMessage();
			}
			if (compiled.fits && !compiled.crossesBlocking) return compiled;
		}

		if (
			!compiled.fits &&
			compiled.compactable === null &&
			this.state.memoryPack !== null &&
			!this.state.memoryPackSuppressed
		) {
			this.state.memoryPackSuppressed = true;
			compiled = compileContext({
				pi: this.#pi,
				context,
				eventMessages,
				state: this.state,
				...(extraEvidence === undefined ? {} : { extraEvidence }),
			});
		}
		return compiled;
	}

	async #materializeReductions(
		messages: readonly AgentMessage[],
		context: ExtensionContext,
		force: boolean,
	): Promise<void> {
		if (context.model === undefined) return;
		const target = Math.min(64_000, Math.max(20_000, Math.floor((context.model.contextWindow - 20_000) * 0.1)));
		const currentRunIndex =
			messageIndexForEntry(context.sessionManager.buildContextEntries(), this.state.currentRunEntryId) ??
			messages.length;
		const tail = selectProtectedTail(messages, target, currentRunIndex);
		const pairs = indexFinalizedToolPairs(context.sessionManager.getBranch());
		const protectedIds = protectedToolCallIds(messages, tail.startIndex);
		const allReductions = await planEvidenceReductions(
			pairs,
			new Set(),
			context.cwd,
			combinedSignal(this.state, context),
		);
		const reductions = allReductions.filter((reduction) => !protectedIds.has(reduction.old.toolCallId));
		const allIdentities = new Set(allReductions.map(reductionIdentity));
		const eligibleIdentities = new Set(reductions.map(reductionIdentity));
		const previousPending = this.state.pendingSupersessions.filter((reduction) =>
			allIdentities.has(reductionIdentity(reduction)),
		);
		const carriedSupersessions = previousPending.filter((reduction) =>
			eligibleIdentities.has(reductionIdentity(reduction)),
		);
		const knownIdentities = new Set([
			...this.state.activeReductions.map(reductionIdentity),
			...previousPending.map(reductionIdentity),
		]);
		const newlyDetectedSupersessions = allReductions.filter(
			(reduction) => reduction.kind === "superseded" && !knownIdentities.has(reductionIdentity(reduction)),
		);
		const deferredSupersessions = [
			...previousPending.filter((reduction) => !eligibleIdentities.has(reductionIdentity(reduction))),
			...newlyDetectedSupersessions.filter(
				(reduction) => !force || !eligibleIdentities.has(reductionIdentity(reduction)),
			),
		];
		this.state.pendingSupersessions = Object.freeze(deferredSupersessions);
		this.state.reductionStats.supersessionCount += newlyDetectedSupersessions.filter((reduction) =>
			deferredSupersessions.some((deferred) => reductionIdentity(deferred) === reductionIdentity(reduction)),
		).length;

		const deferredIdentities = new Set(deferredSupersessions.map(reductionIdentity));
		const activeByCall = new Map(this.state.activeReductions.map((reduction) => [reduction.old.toolCallId, reduction]));
		for (const reduction of carriedSupersessions) activeByCall.set(reduction.old.toolCallId, reduction);
		for (const reduction of reductions) {
			if (!deferredIdentities.has(reductionIdentity(reduction))) activeByCall.set(reduction.old.toolCallId, reduction);
		}
		const merged = Object.freeze(
			[...activeByCall.values()].sort((left, right) => left.old.branchIndex - right.old.branchIndex),
		);
		const current = estimateProjection(applyEvidenceReductions(messages, this.state.activeReductions));
		const reduced = estimateProjection(applyEvidenceReductions(messages, merged));
		const savings = Math.max(0, current - reduced);
		const activeIdentities = new Set(this.state.activeReductions.map(reductionIdentity));
		const changed =
			merged.length !== this.state.activeReductions.length ||
			merged.some((reduction) => !activeIdentities.has(reductionIdentity(reduction)));
		if (!changed) return;
		if (!force && carriedSupersessions.length === 0 && savings < evidenceNetSavingsGate(current)) return;
		const prior = new Set([...activeIdentities, ...previousPending.map(reductionIdentity)]);
		for (const reduction of reductions) {
			if (prior.has(reductionIdentity(reduction)) || deferredIdentities.has(reductionIdentity(reduction))) continue;
			if (reduction.kind === "duplicate") this.state.reductionStats.duplicateCount += 1;
			else this.state.reductionStats.supersessionCount += 1;
		}
		this.state.activeReductions = merged;
		this.state.reductionStats.estimatedSavings += savings;
		this.state.projectionEpoch += 1;
	}

	#maybeStartPreparation(compiled: CompiledContext, context: ExtensionContext): void {
		if (
			compiled.compactable === null ||
			compiled.compactableEstimate < compiled.prepareThreshold ||
			compiled.compactableEstimate >= compiled.blockingThreshold ||
			this.state.pendingCheckpoint !== undefined ||
			this.state.preparation.kind !== "idle"
		) {
			return;
		}
		const controller = new AbortController();
		const signal = AbortSignal.any([controller.signal, this.state.shutdownController.signal]);
		const generation = this.state.runtimeGeneration;
		const promise = this.#generate(compiled, context, signal, false)
			.then((candidate) => {
				if (generation !== this.state.runtimeGeneration || signal.aborted) return null;
				if (!compatible(this.state, candidate, context)) return null;
				this.state.preparation = Object.freeze({ kind: "ready", candidate });
				if (context.isIdle()) this.#requestInstall(context, candidate);
				return candidate;
			})
			.catch((error: unknown) => {
				if (generation === this.state.runtimeGeneration && !signal.aborted) {
					this.state.preparation = Object.freeze({
						kind: "idle",
						lastFailure: failureMetadata(error, "context_management.compactor_transport_failure"),
					});
				}
				return null;
			});
		this.state.preparation = Object.freeze({
			kind: "preparing",
			controller,
			promise,
			startedSourceTokens: compiled.compactableEstimate,
		});
	}

	async #compatiblePrepared(context: ExtensionContext): Promise<CheckpointCandidate | null> {
		const preparation = this.state.preparation;
		if (preparation.kind === "ready" || preparation.kind === "installing") {
			return compatible(this.state, preparation.candidate, context) ? preparation.candidate : null;
		}
		if (preparation.kind !== "preparing") return null;
		const candidate = await waitForCandidate(preparation.promise, combinedSignal(this.state, context));
		return candidate !== null && compatible(this.state, candidate, context) ? candidate : null;
	}

	async #generate(
		compiled: CompiledContext,
		context: ExtensionContext,
		signal: AbortSignal,
		regenerateOnce: boolean,
	): Promise<CheckpointCandidate> {
		if (compiled.compactable === null) throw new Error("No compactable prefix is available.");
		return createCheckpointCandidate({
			context,
			selection: compiled.compactable,
			contextEntries: compiled.contextEntries,
			evidencePairs: indexFinalizedToolPairs(context.sessionManager.getBranch()),
			runtimeGeneration: this.state.runtimeGeneration,
			branchEpoch: this.state.branchEpoch,
			installedCheckpointEntryId: activeInstalledId(this.state),
			hardLimit: compiled.budget.checkpointHardLimit,
			tokensBefore: compiled.correctedEstimate,
			signal,
			regenerateOnce,
		});
	}

	#installInMemory(candidate: CheckpointCandidate): void {
		this.state.pendingCheckpoint = candidate;
		this.#discardPreparation();
		this.state.projectionEpoch += 1;
	}

	#requestInstall(context: ExtensionContext, candidate: CheckpointCandidate): void {
		if (this.#installRequested || !context.isIdle()) return;
		this.#installRequested = true;
		this.state.preparation = Object.freeze({ kind: "installing", candidate });
		context.compact({
			onComplete: () => {
				this.#installRequested = false;
			},
			onError: (error) => {
				this.#installRequested = false;
				this.state.preparation = Object.freeze({
					kind: "idle",
					lastFailure: failureMetadata(error, "context_management.checkpoint_persistence_failure"),
				});
				context.ui.notify("Checkpoint remains active in memory but could not be persisted.", "error");
			},
		});
	}

	#discardPreparation(): void {
		if (this.state.preparation.kind === "preparing") this.state.preparation.controller.abort();
		this.state.preparation = Object.freeze({ kind: "idle" });
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
		this.#discardPreparation();
		this.state.pendingCheckpoint = undefined;
		this.state.installedCheckpoint = restoreLatestCheckpoint(context.sessionManager.getBranch());
		this.state.memoryPack = null;
		this.state.evidence.clear();
		this.state.activeReductions = Object.freeze([]);
		this.state.pendingSupersessions = Object.freeze([]);
		this.state.currentRunParentEntryId = null;
		this.state.currentRunEntryId = null;
	}
}
