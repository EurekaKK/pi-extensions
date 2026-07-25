import type { DeliveryOutcomeV1, ResultSpoolMetadata, RunFailureCodeV1 } from "../sidecar/protocol.js";
import { readVerifiedResultSpool, removeResultSpool, SpoolIntegrityError } from "./spool.js";

export const MAX_WAIT_CONTENT_BYTES = 1024 * 1024;

export type DeliveryState = "READY" | "CLAIMED" | "AWAITING_PERSISTENCE" | "DELIVERED";
export type PendingRunState = "RUNNING" | "CANCELLING" | "READY";

export interface DeliveryRecord {
	deliveryId: string;
	agentId: string;
	runId: string;
	sequence: number;
	completedAt: number;
	workerGeneration: number;
	outcome: DeliveryOutcomeV1;
	failureCode?: RunFailureCodeV1;
	cancelReason?: string;
	spool?: ResultSpoolMetadata;
	state: DeliveryState;
	toolCallId?: string;
}

export interface TerminalCommit {
	deliveryId: string;
	agentId: string;
	runId: string;
	completedAt: number;
	workerGeneration: number;
	outcome: DeliveryOutcomeV1;
	failureCode?: RunFailureCodeV1;
	cancelReason?: string;
	spool?: ResultSpoolMetadata;
}

export interface WaitPendingItem {
	runId: string;
	state: PendingRunState;
}

export interface WaitTimeout {
	status: "TIMEOUT";
	waitId: string;
	mode: "any" | "all";
	timeoutMs: number;
	pending: WaitPendingItem[];
}

export interface WaitSatisfied {
	status: "SATISFIED";
	waitId: string;
	mode: "any" | "all";
	selectedRunIds: string[];
	remainingRunIds: string[];
}

export type WaitResolution = WaitTimeout | WaitSatisfied;

export interface ClaimedDelivery extends DeliveryRecord {
	report?: string;
}

export interface ClaimedWait {
	waitId: string;
	mode: "any" | "all";
	deliveries: ClaimedDelivery[];
	remainingRunIds: string[];
	content: string;
	isError: boolean;
}

type ActiveWaitState = "ACTIVE" | "SATISFIED" | "TIMED_OUT" | "ABORTED" | "CLAIMED";

interface ActiveWait {
	id: string;
	runIds: string[];
	mode: "any" | "all";
	timeoutMs: number | undefined;
	state: ActiveWaitState;
	selectedRunIds: string[];
	remainingRunIds: string[];
	timer: NodeJS.Timeout | undefined;
	resolve: (resolution: WaitResolution) => void;
	reject: (error: Error) => void;
	abortSignal: AbortSignal | undefined;
	abortListener: (() => void) | undefined;
}

export type MailboxErrorCode =
	| "SUBAGENT_RUN_UNKNOWN"
	| "SUBAGENT_RUN_ALREADY_DELIVERED"
	| "SUBAGENT_WAIT_CONFLICT"
	| "SUBAGENT_WAIT_RESULT_TOO_LARGE"
	| "SUBAGENT_OPERATION_INVALIDATED";

export class MailboxError extends Error {
	constructor(
		readonly code: MailboxErrorCode,
		message: string,
	) {
		super(message);
		this.name = "MailboxError";
	}
}

export interface MailboxOptions {
	spoolRoot: string;
	observeRunState(runId: string): "RUNNING" | "CANCELLING";
	onIntegrityFailure(delivery: DeliveryRecord): Promise<void> | void;
	now?: () => number;
}

function copyDelivery(record: DeliveryRecord): DeliveryRecord {
	return {
		...record,
		...(record.spool ? { spool: { ...record.spool } } : {}),
	};
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

function abortError(): MailboxError {
	const error = new MailboxError("SUBAGENT_OPERATION_INVALIDATED", "The wait operation was aborted.");
	error.name = "AbortError";
	return error;
}

export class Mailbox {
	readonly #deliveriesByRunId = new Map<string, DeliveryRecord>();
	readonly #knownRunIds = new Set<string>();
	readonly #reservations = new Map<string, string>();
	readonly #waits = new Map<string, ActiveWait>();
	readonly #options: MailboxOptions;
	#nextDeliverySequence = 0;
	#nextWaitSequence = 0;

	constructor(options: MailboxOptions) {
		this.#options = options;
	}

	registerRun(runId: string): void {
		this.#knownRunIds.add(runId);
	}

	hasTerminalRecord(runId: string): boolean {
		return this.#deliveriesByRunId.has(runId);
	}

	get(runId: string): DeliveryRecord | undefined {
		const record = this.#deliveriesByRunId.get(runId);
		return record ? copyDelivery(record) : undefined;
	}

	commitTerminal(commit: TerminalCommit): DeliveryRecord {
		this.#knownRunIds.add(commit.runId);
		const existing = this.#deliveriesByRunId.get(commit.runId);
		if (existing) return copyDelivery(existing);

		const record: DeliveryRecord = {
			...commit,
			sequence: this.#nextDeliverySequence++,
			state: "READY",
		};
		this.#deliveriesByRunId.set(record.runId, record);
		this.#checkActiveWaits();
		return copyDelivery(record);
	}

	async wait(
		runIds: readonly string[],
		mode: "any" | "all",
		timeoutMs: number | undefined,
		signal?: AbortSignal,
	): Promise<WaitResolution> {
		if (new Set(runIds).size !== runIds.length) {
			throw new MailboxError("SUBAGENT_OPERATION_INVALIDATED", "runIds must not contain duplicates.");
		}
		for (const runId of runIds) {
			if (!this.#knownRunIds.has(runId)) {
				throw new MailboxError("SUBAGENT_RUN_UNKNOWN", `Unknown sub-agent run: ${runId}`);
			}
			const delivery = this.#deliveriesByRunId.get(runId);
			if (delivery?.state === "DELIVERED") {
				throw new MailboxError("SUBAGENT_RUN_ALREADY_DELIVERED", `Sub-agent run was already delivered: ${runId}`);
			}
			if (this.#reservations.has(runId)) {
				throw new MailboxError(
					"SUBAGENT_WAIT_CONFLICT",
					"At least one requested run is already reserved by another wait.",
				);
			}
		}
		if (signal?.aborted) throw abortError();

		const waitId = `wait_${this.#nextWaitSequence++}`;
		let resolveWait!: (resolution: WaitResolution) => void;
		let rejectWait!: (error: Error) => void;
		const promise = new Promise<WaitResolution>((resolve, reject) => {
			resolveWait = resolve;
			rejectWait = reject;
		});
		const wait: ActiveWait = {
			id: waitId,
			runIds: [...runIds],
			mode,
			timeoutMs,
			state: "ACTIVE",
			selectedRunIds: [],
			remainingRunIds: [],
			timer: undefined,
			resolve: resolveWait,
			reject: rejectWait,
			abortSignal: signal,
			abortListener: undefined,
		};
		this.#waits.set(waitId, wait);
		for (const runId of runIds) this.#reservations.set(runId, waitId);

		if (signal) {
			wait.abortListener = () => this.#abortWait(wait);
			signal.addEventListener("abort", wait.abortListener, { once: true });
		}

		if (this.#trySatisfy(wait)) return promise;
		if (timeoutMs === 0) {
			this.#timeOut(wait);
		} else if (timeoutMs !== undefined) {
			wait.timer = setTimeout(() => this.#timeOut(wait), timeoutMs);
		}
		return promise;
	}

	async claimAndRender(
		waitId: string,
		toolCallId: string,
		render: (deliveries: readonly ClaimedDelivery[], remainingRunIds: readonly string[]) => string,
	): Promise<ClaimedWait> {
		const wait = this.#waits.get(waitId);
		if (wait?.state !== "SATISFIED") {
			throw new MailboxError("SUBAGENT_OPERATION_INVALIDATED", "The wait is no longer claimable.");
		}

		const claimed: ClaimedDelivery[] = [];
		try {
			for (const runId of wait.selectedRunIds) {
				const record = this.#deliveriesByRunId.get(runId);
				if (record?.state !== "READY") {
					throw new MailboxError(
						"SUBAGENT_OPERATION_INVALIDATED",
						"The selected delivery changed before it could be claimed.",
					);
				}
				let report: string | undefined;
				if (record.outcome === "RESULT") {
					if (!record.spool) {
						await this.#downgradeIntegrityFailure(record);
					} else {
						try {
							const verified = await readVerifiedResultSpool(this.#options.spoolRoot, record.deliveryId, record.spool);
							report = verified.bytes.toString("utf8");
						} catch (error) {
							if (!(error instanceof SpoolIntegrityError) && !isAbortError(error)) {
								// File-system failures are indistinguishable from tampering at
								// this trust boundary.
							}
							await this.#downgradeIntegrityFailure(record);
						}
					}
				}
				claimed.push({
					...copyDelivery(record),
					...(report === undefined ? {} : { report }),
				});
			}

			const content = render(claimed, wait.remainingRunIds);
			if (Buffer.byteLength(content, "utf8") > MAX_WAIT_CONTENT_BYTES) {
				throw new MailboxError(
					"SUBAGENT_WAIT_RESULT_TOO_LARGE",
					"The combined wait result exceeds the 1 MiB delivery limit; wait for fewer runs.",
				);
			}

			for (const runId of wait.selectedRunIds) {
				const record = this.#deliveriesByRunId.get(runId);
				if (record?.state !== "READY") {
					throw new MailboxError(
						"SUBAGENT_OPERATION_INVALIDATED",
						"The selected delivery changed before claim commit.",
					);
				}
				record.state = "CLAIMED";
				record.toolCallId = toolCallId;
			}
			for (const runId of wait.remainingRunIds) this.#reservations.delete(runId);
			wait.state = "CLAIMED";
			this.#detachWaitSignals(wait);

			return {
				waitId,
				mode: wait.mode,
				deliveries: claimed,
				remainingRunIds: [...wait.remainingRunIds],
				content,
				isError: claimed.some((delivery) => delivery.outcome !== "RESULT"),
			};
		} catch (error) {
			this.release(waitId);
			throw error;
		}
	}

	markAwaitingPersistence(toolCallId: string): void {
		const wait = this.#findWaitForToolCall(toolCallId, "CLAIMED");
		if (!wait) {
			throw new MailboxError("SUBAGENT_OPERATION_INVALIDATED", "No matching claimed wait exists.");
		}
		for (const runId of wait.selectedRunIds) {
			const delivery = this.#deliveriesByRunId.get(runId);
			if (delivery?.state === "CLAIMED" && delivery.toolCallId === toolCallId) {
				delivery.state = "AWAITING_PERSISTENCE";
			}
		}
	}

	rollback(toolCallId: string): void {
		const wait = this.#findWaitForToolCall(toolCallId);
		if (!wait) return;
		for (const runId of wait.selectedRunIds) {
			const delivery = this.#deliveriesByRunId.get(runId);
			if (
				delivery &&
				delivery.toolCallId === toolCallId &&
				(delivery.state === "CLAIMED" || delivery.state === "AWAITING_PERSISTENCE")
			) {
				delivery.state = "READY";
				delete delivery.toolCallId;
			}
		}
		this.release(wait.id);
		this.#checkActiveWaits();
	}

	async confirmPersisted(toolCallId: string): Promise<void> {
		const wait = this.#findWaitForToolCall(toolCallId);
		if (!wait) return;
		const spools: Array<{ deliveryId: string }> = [];
		for (const runId of wait.selectedRunIds) {
			const delivery = this.#deliveriesByRunId.get(runId);
			if (delivery?.state === "AWAITING_PERSISTENCE" && delivery.toolCallId === toolCallId) {
				delivery.state = "DELIVERED";
				if (delivery.outcome === "RESULT") spools.push({ deliveryId: delivery.deliveryId });
			}
		}
		this.release(wait.id, false);
		await Promise.allSettled(spools.map(({ deliveryId }) => removeResultSpool(this.#options.spoolRoot, deliveryId)));
	}

	async reconcile(toolCallId: string, persisted: boolean): Promise<void> {
		if (persisted) {
			await this.confirmPersisted(toolCallId);
		} else {
			this.rollback(toolCallId);
		}
	}

	release(waitId: string, restoreClaims = true): void {
		const wait = this.#waits.get(waitId);
		if (!wait) return;
		if (restoreClaims) {
			for (const runId of wait.selectedRunIds) {
				const delivery = this.#deliveriesByRunId.get(runId);
				if (delivery?.state === "CLAIMED") {
					delivery.state = "READY";
					delete delivery.toolCallId;
				}
			}
		}
		for (const runId of wait.runIds) {
			if (this.#reservations.get(runId) === wait.id) this.#reservations.delete(runId);
		}
		this.#detachWaitSignals(wait);
		this.#waits.delete(wait.id);
	}

	listPending(): DeliveryRecord[] {
		return [...this.#deliveriesByRunId.values()]
			.filter((delivery) => delivery.state !== "DELIVERED")
			.sort((left, right) => left.sequence - right.sequence)
			.map(copyDelivery);
	}

	listAll(): DeliveryRecord[] {
		return [...this.#deliveriesByRunId.values()]
			.sort((left, right) => left.sequence - right.sequence)
			.map(copyDelivery);
	}

	readyCountForAgent(agentId: string): number {
		let count = 0;
		for (const delivery of this.#deliveriesByRunId.values()) {
			if (delivery.agentId === agentId && delivery.state === "READY") count++;
		}
		return count;
	}

	retainedSpoolBasenames(): Set<string> {
		const retained = new Set<string>();
		for (const delivery of this.#deliveriesByRunId.values()) {
			if (delivery.state !== "DELIVERED" && delivery.spool) {
				retained.add(delivery.spool.basename);
			}
		}
		return retained;
	}

	shutdown(): void {
		for (const wait of [...this.#waits.values()]) {
			if (wait.state === "ACTIVE") this.#abortWait(wait);
			else this.release(wait.id);
		}
	}

	#trySatisfy(wait: ActiveWait): boolean {
		if (wait.state !== "ACTIVE") return false;
		const ready = wait.runIds.filter((runId) => this.#deliveriesByRunId.get(runId)?.state === "READY");
		if ((wait.mode === "all" && ready.length !== wait.runIds.length) || ready.length === 0) {
			return false;
		}

		wait.state = "SATISFIED";
		if (wait.timer) clearTimeout(wait.timer);
		if (wait.mode === "all") {
			wait.selectedRunIds = [...wait.runIds];
			wait.remainingRunIds = [];
		} else {
			let selected = ready[0];
			if (selected === undefined) return false;
			for (const runId of ready.slice(1)) {
				const candidate = this.#deliveriesByRunId.get(runId);
				const current = this.#deliveriesByRunId.get(selected);
				if (candidate && current && candidate.sequence < current.sequence) selected = runId;
			}
			wait.selectedRunIds = [selected];
			wait.remainingRunIds = wait.runIds.filter((runId) => runId !== selected);
		}
		wait.resolve({
			status: "SATISFIED",
			waitId: wait.id,
			mode: wait.mode,
			selectedRunIds: [...wait.selectedRunIds],
			remainingRunIds: [...wait.remainingRunIds],
		});
		return true;
	}

	#checkActiveWaits(): void {
		for (const wait of this.#waits.values()) this.#trySatisfy(wait);
	}

	#timeOut(wait: ActiveWait): void {
		if (wait.state !== "ACTIVE") return;
		if (this.#trySatisfy(wait)) return;
		wait.state = "TIMED_OUT";
		const pending = wait.runIds.map((runId): WaitPendingItem => {
			const delivery = this.#deliveriesByRunId.get(runId);
			return {
				runId,
				state: delivery?.state === "READY" ? "READY" : this.#options.observeRunState(runId),
			};
		});
		for (const runId of wait.runIds) this.#reservations.delete(runId);
		this.#detachWaitSignals(wait);
		this.#waits.delete(wait.id);
		wait.resolve({
			status: "TIMEOUT",
			waitId: wait.id,
			mode: wait.mode,
			timeoutMs: wait.timeoutMs ?? 0,
			pending,
		});
	}

	#abortWait(wait: ActiveWait): void {
		if (wait.state !== "ACTIVE" && wait.state !== "SATISFIED") return;
		wait.state = "ABORTED";
		this.release(wait.id);
		wait.reject(abortError());
	}

	#detachWaitSignals(wait: ActiveWait): void {
		if (wait.timer) clearTimeout(wait.timer);
		if (wait.abortSignal && wait.abortListener) {
			wait.abortSignal.removeEventListener("abort", wait.abortListener);
		}
		wait.timer = undefined;
		wait.abortListener = undefined;
	}

	#findWaitForToolCall(toolCallId: string, requiredState?: ActiveWaitState): ActiveWait | undefined {
		for (const wait of this.#waits.values()) {
			if (requiredState && wait.state !== requiredState) continue;
			for (const runId of wait.selectedRunIds) {
				const delivery = this.#deliveriesByRunId.get(runId);
				if (delivery?.toolCallId === toolCallId) return wait;
			}
		}
		return undefined;
	}

	async #downgradeIntegrityFailure(record: DeliveryRecord): Promise<void> {
		record.outcome = "FAILED";
		record.failureCode = "SUBAGENT_DELIVERY_INTEGRITY_FAILED";
		delete record.spool;
		delete record.cancelReason;
		await this.#options.onIntegrityFailure(copyDelivery(record));
	}
}
