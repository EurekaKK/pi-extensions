import { randomUUID } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { LEDGER_ENTRY_TYPE } from "./constants.js";
import { type TavilyTool, TavilyToolError } from "./errors.js";
import type { CreditReservation, CreditSettlement, TavilyAttemptBudget } from "./tavily.js";
import type { RetrievalDepth } from "./types.js";

const LEDGER_VERSION = 1 as const;
const OPERATION_ID_PREFIX = "tavily_operation_";
const ATTEMPT_ID_PREFIX = "tavily_attempt_";
const TURN_ID_PREFIX = "tavily_turn_operation_";
const AGENT_RUN_ID_PREFIX = "tavily_agent_run_operation_";
const MAX_ID_SUFFIX_LENGTH = 128;
const MAX_ID_GENERATION_ATTEMPTS = 32;

export interface TavilyBudgetLimits {
	readonly maxToolCallsPerTurn: number;
	readonly maxToolCallsPerAgentRun: number;
	readonly maxToolCallsPerBranchLineage: number;
	readonly maxTavilyCreditsPerAgentRun: number;
	readonly maxTavilyCreditsPerBranchLineage: number;
}

export interface TavilyBudgetLedgerOptions {
	readonly limits: TavilyBudgetLimits;
	readonly appendEntry: (customType: typeof LEDGER_ENTRY_TYPE, data: LedgerEvent) => void | Promise<void>;
	readonly randomId?: () => string;
	readonly currentBranch?: readonly SessionEntry[];
}

export interface ToolCallAdmission {
	readonly operationId: string;
	readonly turnOperationId: string;
	readonly agentRunOperationId: string;
	readonly operation: TavilyTool;
	readonly syntheticTurn: boolean;
	readonly syntheticAgentRun: boolean;
}

export interface TavilyBudgetSnapshot {
	readonly branchToolCalls: number;
	readonly branchCredits: number;
	readonly currentTurnOperationId?: string;
	readonly currentAgentRunOperationId?: string;
	readonly currentTurnToolCalls: number;
	readonly currentAgentRunToolCalls: number;
	readonly currentAgentRunCredits: number;
	readonly outstandingReservations: number;
	readonly creditContractOverrun: boolean;
}

export interface ReducedLedger {
	readonly operations: ReadonlyMap<string, ToolCallCommittedEvent>;
	readonly attempts: ReadonlyMap<string, ReducedAttempt>;
	readonly branchToolCalls: number;
	readonly branchCredits: number;
	readonly outstandingReservations: number;
	readonly creditContractOverrun: boolean;
}

export interface ReducedAttempt {
	readonly reservation: CreditReservedEvent;
	readonly settlement?: CreditSettledEvent;
}

export type LedgerEvent = ToolCallCommittedEvent | CreditReservedEvent | CreditSettledEvent;

export interface ToolCallCommittedEvent {
	readonly tavily_ledger_version: 1;
	readonly tavily_event: "tool_call_committed";
	readonly tavily_operation_id: string;
	readonly tavily_turn_operation_id: string;
	readonly tavily_agent_run_operation_id: string;
	readonly tavily_operation: TavilyTool;
	readonly tavily_tool_calls: 1;
}

export interface CreditReservedEvent {
	readonly tavily_ledger_version: 1;
	readonly tavily_event: "credit_reserved";
	readonly tavily_attempt_id: string;
	readonly tavily_operation_id: string;
	readonly tavily_agent_run_operation_id: string;
	readonly tavily_operation: TavilyTool;
	readonly tavily_depth: RetrievalDepth;
	readonly tavily_reserved_credits: number;
}

export interface CreditSettledEvent {
	readonly tavily_ledger_version: 1;
	readonly tavily_event: "credit_settled";
	readonly tavily_attempt_id: string;
	readonly tavily_operation_id: string;
	readonly tavily_agent_run_operation_id: string;
	readonly tavily_operation: TavilyTool;
	readonly tavily_credits: number;
	readonly tavily_usage_estimated: boolean;
}

/** A sanitized startup error: malformed ledger data must never be copied into the message. */
export class TavilyLedgerCorruptionError extends Error {
	constructor(reason: string) {
		super(`The Tavily budget ledger is invalid: ${reason}`);
		this.name = "TavilyLedgerCorruptionError";
	}
}

/**
 * Session/branch-local budget state. All append-before-mutate transitions run through
 * one mutex, so an append failure can only leave the in-memory view more conservative.
 */
export class TavilyBudgetLedger implements TavilyAttemptBudget {
	readonly #limits: TavilyBudgetLimits;
	readonly #appendEntry: TavilyBudgetLedgerOptions["appendEntry"];
	readonly #randomId: () => string;
	readonly #mutex = new AsyncMutex();
	#state: MutableLedgerState;
	#currentTurnOperationId: string | undefined;
	#currentAgentRunOperationId: string | undefined;

	constructor(options: TavilyBudgetLedgerOptions) {
		validateLimits(options.limits);
		this.#limits = Object.freeze({ ...options.limits });
		this.#appendEntry = options.appendEntry;
		this.#randomId = options.randomId ?? randomUUID;
		this.#state = mutableStateFromReduced(reduceCurrentBranchLedger(options.currentBranch ?? []));
	}

	/** Repeated agent_start events before agent_settled deliberately reuse the same run. */
	async onAgentStart(): Promise<string> {
		return this.#mutex.runExclusive(() => {
			if (this.#currentAgentRunOperationId !== undefined) return this.#currentAgentRunOperationId;
			const id = this.#allocateId(AGENT_RUN_ID_PREFIX);
			this.#state.allocatedIds.add(id);
			this.#currentAgentRunOperationId = id;
			this.#currentTurnOperationId = undefined;
			return id;
		});
	}

	async onAgentSettled(): Promise<void> {
		await this.#mutex.runExclusive(() => {
			this.#currentAgentRunOperationId = undefined;
			this.#currentTurnOperationId = undefined;
		});
	}

	async onTurnStart(): Promise<string> {
		return this.#mutex.runExclusive(() => {
			const id = this.#allocateId(TURN_ID_PREFIX);
			this.#state.allocatedIds.add(id);
			this.#currentTurnOperationId = id;
			return id;
		});
	}

	/**
	 * Atomically checks all three tool-call limits, persists the commitment, and only
	 * then exposes it in memory. Calls without lifecycle IDs receive per-invocation
	 * synthetic IDs which are never installed as reusable current lifecycle state.
	 */
	async commitToolCall(operation: TavilyTool): Promise<ToolCallAdmission> {
		return this.#mutex.runExclusive(async () => {
			const syntheticTurn = this.#currentTurnOperationId === undefined;
			const syntheticAgentRun = this.#currentAgentRunOperationId === undefined;
			const turnOperationId = this.#currentTurnOperationId ?? this.#allocateId(TURN_ID_PREFIX);
			const agentRunOperationId = this.#currentAgentRunOperationId ?? this.#allocateId(AGENT_RUN_ID_PREFIX);

			const turnCalls = countOperationsBy(this.#state.operations.values(), "tavily_turn_operation_id", turnOperationId);
			const runCalls = countOperationsBy(
				this.#state.operations.values(),
				"tavily_agent_run_operation_id",
				agentRunOperationId,
			);
			if (
				turnCalls >= this.#limits.maxToolCallsPerTurn ||
				runCalls >= this.#limits.maxToolCallsPerAgentRun ||
				this.#state.operations.size >= this.#limits.maxToolCallsPerBranchLineage
			) {
				throw new TavilyToolError(
					operation,
					"tavily_tool_budget_exhausted",
					"stop_turn",
					"The Tavily tool-call budget for this turn, agent run, or branch lineage is exhausted.",
				);
			}

			const operationId = this.#allocateId(OPERATION_ID_PREFIX);
			const event: ToolCallCommittedEvent = {
				tavily_ledger_version: LEDGER_VERSION,
				tavily_event: "tool_call_committed",
				tavily_operation_id: operationId,
				tavily_turn_operation_id: turnOperationId,
				tavily_agent_run_operation_id: agentRunOperationId,
				tavily_operation: operation,
				tavily_tool_calls: 1,
			};
			await this.#appendEntry(LEDGER_ENTRY_TYPE, event);
			this.#state.operations.set(operationId, event);
			this.#state.allocatedIds.add(operationId);
			this.#state.allocatedIds.add(turnOperationId);
			this.#state.allocatedIds.add(agentRunOperationId);

			return {
				operationId,
				turnOperationId,
				agentRunOperationId,
				operation,
				syntheticTurn,
				syntheticAgentRun,
			};
		});
	}

	/** Implements TavilyAttemptBudget for TavilyClient. */
	async reserve(operationId: string, operation: TavilyTool, depth: RetrievalDepth): Promise<CreditReservation> {
		return this.#mutex.runExclusive(async () => {
			if (this.#state.creditContractOverrun) {
				throw new TavilyToolError(
					operation,
					"tavily_credit_budget_exhausted",
					"stop_turn",
					"Further Tavily requests are disabled after a supplier credit-contract overrun.",
				);
			}
			const committed = this.#state.operations.get(operationId);
			if (committed === undefined || committed.tavily_operation !== operation) {
				throw new TavilyToolError(
					operation,
					"tavily_internal_error",
					"stop_turn",
					"The Tavily request was not associated with a committed tool operation.",
				);
			}

			const reservedCredits = worstCaseCredits(depth);
			const runCredits = creditsForRun(this.#state, committed.tavily_agent_run_operation_id);
			const branchCredits = creditsForBranch(this.#state);
			if (
				runCredits + reservedCredits > this.#limits.maxTavilyCreditsPerAgentRun ||
				branchCredits + reservedCredits > this.#limits.maxTavilyCreditsPerBranchLineage
			) {
				throw new TavilyToolError(
					operation,
					"tavily_credit_budget_exhausted",
					"stop_turn",
					"The Tavily credit admission budget for this agent run or branch lineage is exhausted.",
				);
			}

			const attemptId = this.#allocateId(ATTEMPT_ID_PREFIX);
			const event: CreditReservedEvent = {
				tavily_ledger_version: LEDGER_VERSION,
				tavily_event: "credit_reserved",
				tavily_attempt_id: attemptId,
				tavily_operation_id: operationId,
				tavily_agent_run_operation_id: committed.tavily_agent_run_operation_id,
				tavily_operation: operation,
				tavily_depth: depth,
				tavily_reserved_credits: reservedCredits,
			};
			await this.#appendEntry(LEDGER_ENTRY_TYPE, event);
			this.#state.attempts.set(attemptId, { reservation: event });
			this.#state.allocatedIds.add(attemptId);

			return { attemptId, reservedCredits };
		});
	}

	/** Implements TavilyAttemptBudget for TavilyClient. */
	async settle(attemptId: string, actualCredits: number | undefined): Promise<CreditSettlement> {
		return this.#mutex.runExclusive(async () => {
			const attempt = this.#state.attempts.get(attemptId);
			if (attempt === undefined) {
				throw new TavilyLedgerCorruptionError("a settlement referenced an unknown reservation");
			}
			if (actualCredits !== undefined && !isNonNegativeSafeInteger(actualCredits)) {
				throw new TavilyLedgerCorruptionError("a settlement contained an invalid credit value");
			}

			const estimated = actualCredits === undefined;
			const credits = actualCredits ?? attempt.reservation.tavily_reserved_credits;
			const contractOverrun = credits > attempt.reservation.tavily_reserved_credits;
			const previousCredits = attempt.settlement?.tavily_credits ?? attempt.reservation.tavily_reserved_credits;
			const prospectiveBranchCredits = creditsForBranch(this.#state) - previousCredits + credits;
			const prospectiveRunCredits =
				creditsForRun(this.#state, attempt.reservation.tavily_agent_run_operation_id) - previousCredits + credits;
			if (!Number.isSafeInteger(prospectiveBranchCredits) || !Number.isSafeInteger(prospectiveRunCredits)) {
				throw new TavilyLedgerCorruptionError("a settlement would make accumulated credits unsafe");
			}
			const event: CreditSettledEvent = {
				tavily_ledger_version: LEDGER_VERSION,
				tavily_event: "credit_settled",
				tavily_attempt_id: attemptId,
				tavily_operation_id: attempt.reservation.tavily_operation_id,
				tavily_agent_run_operation_id: attempt.reservation.tavily_agent_run_operation_id,
				tavily_operation: attempt.reservation.tavily_operation,
				tavily_credits: credits,
				tavily_usage_estimated: estimated,
			};

			if (attempt.settlement !== undefined) {
				if (!eventsEqual(attempt.settlement, event)) {
					throw new TavilyLedgerCorruptionError("an attempt received conflicting settlements");
				}
				return { credits, estimated, contractOverrun, persisted: true };
			}

			await this.#appendEntry(LEDGER_ENTRY_TYPE, event);
			this.#state.attempts.set(attemptId, { reservation: attempt.reservation, settlement: event });
			this.#state.creditContractOverrun ||= contractOverrun;
			return { credits, estimated, contractOverrun, persisted: true };
		});
	}

	/** Replace all branch-lineage counts after a session_tree/reload barrier. */
	async restoreCurrentBranch(currentBranch: readonly SessionEntry[]): Promise<void> {
		await this.#mutex.runExclusive(() => {
			this.#state = mutableStateFromReduced(reduceCurrentBranchLedger(currentBranch));
			this.#currentTurnOperationId = undefined;
			this.#currentAgentRunOperationId = undefined;
		});
	}

	async snapshot(): Promise<TavilyBudgetSnapshot> {
		return this.#mutex.runExclusive(() => {
			const currentTurnOperationId = this.#currentTurnOperationId;
			const currentAgentRunOperationId = this.#currentAgentRunOperationId;
			return {
				branchToolCalls: this.#state.operations.size,
				branchCredits: creditsForBranch(this.#state),
				...(currentTurnOperationId === undefined ? {} : { currentTurnOperationId }),
				...(currentAgentRunOperationId === undefined ? {} : { currentAgentRunOperationId }),
				currentTurnToolCalls:
					currentTurnOperationId === undefined
						? 0
						: countOperationsBy(this.#state.operations.values(), "tavily_turn_operation_id", currentTurnOperationId),
				currentAgentRunToolCalls:
					currentAgentRunOperationId === undefined
						? 0
						: countOperationsBy(
								this.#state.operations.values(),
								"tavily_agent_run_operation_id",
								currentAgentRunOperationId,
							),
				currentAgentRunCredits:
					currentAgentRunOperationId === undefined ? 0 : creditsForRun(this.#state, currentAgentRunOperationId),
				outstandingReservations: countOutstandingReservations(this.#state.attempts.values()),
				creditContractOverrun: this.#state.creditContractOverrun,
			};
		});
	}

	#allocateId(prefix: string): string {
		for (let attempt = 0; attempt < MAX_ID_GENERATION_ATTEMPTS; attempt += 1) {
			const suffix = this.#randomId();
			if (!isIdSuffix(suffix)) {
				throw new Error("The Tavily random ID source returned an invalid value.");
			}
			const id = `${prefix}${suffix}`;
			if (!this.#state.allocatedIds.has(id)) return id;
		}
		throw new Error("The Tavily random ID source repeatedly returned duplicate values.");
	}
}

/**
 * Reduce only the entries supplied by `ctx.sessionManager.getBranch()`. Foreign
 * custom-entry types are ignored; malformed entries under our namespace fail closed.
 */
export function reduceCurrentBranchLedger(currentBranch: readonly SessionEntry[]): ReducedLedger {
	const operations = new Map<string, ToolCallCommittedEvent>();
	const reservations = new Map<string, CreditReservedEvent>();
	const settlements = new Map<string, CreditSettledEvent>();

	for (const entry of currentBranch) {
		if (entry.type !== "custom" || entry.customType !== LEDGER_ENTRY_TYPE) continue;
		const event = parseLedgerEvent(entry.data);
		switch (event.tavily_event) {
			case "tool_call_committed":
				insertIdempotent(operations, event.tavily_operation_id, event, "tool operation");
				break;
			case "credit_reserved":
				insertIdempotent(reservations, event.tavily_attempt_id, event, "credit reservation");
				break;
			case "credit_settled":
				insertIdempotent(settlements, event.tavily_attempt_id, event, "credit settlement");
				break;
		}
	}

	const attempts = new Map<string, ReducedAttempt>();
	let branchCredits = 0;
	let outstandingReservations = 0;
	let creditContractOverrun = false;
	for (const [attemptId, reservation] of reservations) {
		const operation = operations.get(reservation.tavily_operation_id);
		if (operation === undefined) {
			throw new TavilyLedgerCorruptionError("a credit reservation referenced an unknown tool operation");
		}
		assertAttemptOwnership(operation, reservation);

		const settlement = settlements.get(attemptId);
		if (settlement !== undefined) assertSettlementOwnership(reservation, settlement);
		const credits = settlement?.tavily_credits ?? reservation.tavily_reserved_credits;
		branchCredits += credits;
		if (!Number.isSafeInteger(branchCredits)) {
			throw new TavilyLedgerCorruptionError("the accumulated credit total is not a safe integer");
		}
		if (settlement === undefined) outstandingReservations += 1;
		creditContractOverrun ||= credits > reservation.tavily_reserved_credits;
		attempts.set(attemptId, settlement === undefined ? { reservation } : { reservation, settlement });
	}

	for (const attemptId of settlements.keys()) {
		if (!reservations.has(attemptId)) {
			throw new TavilyLedgerCorruptionError("a settlement did not have a matching reservation");
		}
	}

	return {
		operations,
		attempts,
		branchToolCalls: operations.size,
		branchCredits,
		outstandingReservations,
		creditContractOverrun,
	};
}

function parseLedgerEvent(value: unknown): LedgerEvent {
	if (!isRecord(value)) throw new TavilyLedgerCorruptionError("an entry was not an object");
	if (value.tavily_ledger_version !== LEDGER_VERSION) {
		throw new TavilyLedgerCorruptionError("an entry used an unsupported schema version");
	}
	switch (value.tavily_event) {
		case "tool_call_committed":
			return parseToolCallCommitted(value);
		case "credit_reserved":
			return parseCreditReserved(value);
		case "credit_settled":
			return parseCreditSettled(value);
		default:
			throw new TavilyLedgerCorruptionError("an entry used an unknown event type");
	}
}

function parseToolCallCommitted(value: Record<string, unknown>): ToolCallCommittedEvent {
	assertExactKeys(value, [
		"tavily_ledger_version",
		"tavily_event",
		"tavily_operation_id",
		"tavily_turn_operation_id",
		"tavily_agent_run_operation_id",
		"tavily_operation",
		"tavily_tool_calls",
	]);
	if (!isPrefixedId(value.tavily_operation_id, OPERATION_ID_PREFIX)) invalidField("tavily_operation_id");
	if (!isPrefixedId(value.tavily_turn_operation_id, TURN_ID_PREFIX)) invalidField("tavily_turn_operation_id");
	if (!isPrefixedId(value.tavily_agent_run_operation_id, AGENT_RUN_ID_PREFIX)) {
		invalidField("tavily_agent_run_operation_id");
	}
	if (!isTavilyTool(value.tavily_operation)) invalidField("tavily_operation");
	if (value.tavily_tool_calls !== 1) invalidField("tavily_tool_calls");
	return {
		tavily_ledger_version: LEDGER_VERSION,
		tavily_event: "tool_call_committed",
		tavily_operation_id: value.tavily_operation_id,
		tavily_turn_operation_id: value.tavily_turn_operation_id,
		tavily_agent_run_operation_id: value.tavily_agent_run_operation_id,
		tavily_operation: value.tavily_operation,
		tavily_tool_calls: 1,
	};
}

function parseCreditReserved(value: Record<string, unknown>): CreditReservedEvent {
	assertExactKeys(value, [
		"tavily_ledger_version",
		"tavily_event",
		"tavily_attempt_id",
		"tavily_operation_id",
		"tavily_agent_run_operation_id",
		"tavily_operation",
		"tavily_depth",
		"tavily_reserved_credits",
	]);
	if (!isPrefixedId(value.tavily_attempt_id, ATTEMPT_ID_PREFIX)) invalidField("tavily_attempt_id");
	if (!isPrefixedId(value.tavily_operation_id, OPERATION_ID_PREFIX)) invalidField("tavily_operation_id");
	if (!isPrefixedId(value.tavily_agent_run_operation_id, AGENT_RUN_ID_PREFIX)) {
		invalidField("tavily_agent_run_operation_id");
	}
	if (!isTavilyTool(value.tavily_operation)) invalidField("tavily_operation");
	if (!isRetrievalDepth(value.tavily_depth)) invalidField("tavily_depth");
	if (value.tavily_reserved_credits !== worstCaseCredits(value.tavily_depth)) {
		invalidField("tavily_reserved_credits");
	}
	return {
		tavily_ledger_version: LEDGER_VERSION,
		tavily_event: "credit_reserved",
		tavily_attempt_id: value.tavily_attempt_id,
		tavily_operation_id: value.tavily_operation_id,
		tavily_agent_run_operation_id: value.tavily_agent_run_operation_id,
		tavily_operation: value.tavily_operation,
		tavily_depth: value.tavily_depth,
		tavily_reserved_credits: value.tavily_reserved_credits,
	};
}

function parseCreditSettled(value: Record<string, unknown>): CreditSettledEvent {
	assertExactKeys(value, [
		"tavily_ledger_version",
		"tavily_event",
		"tavily_attempt_id",
		"tavily_operation_id",
		"tavily_agent_run_operation_id",
		"tavily_operation",
		"tavily_credits",
		"tavily_usage_estimated",
	]);
	if (!isPrefixedId(value.tavily_attempt_id, ATTEMPT_ID_PREFIX)) invalidField("tavily_attempt_id");
	if (!isPrefixedId(value.tavily_operation_id, OPERATION_ID_PREFIX)) invalidField("tavily_operation_id");
	if (!isPrefixedId(value.tavily_agent_run_operation_id, AGENT_RUN_ID_PREFIX)) {
		invalidField("tavily_agent_run_operation_id");
	}
	if (!isTavilyTool(value.tavily_operation)) invalidField("tavily_operation");
	if (!isNonNegativeSafeInteger(value.tavily_credits)) invalidField("tavily_credits");
	if (typeof value.tavily_usage_estimated !== "boolean") invalidField("tavily_usage_estimated");
	return {
		tavily_ledger_version: LEDGER_VERSION,
		tavily_event: "credit_settled",
		tavily_attempt_id: value.tavily_attempt_id,
		tavily_operation_id: value.tavily_operation_id,
		tavily_agent_run_operation_id: value.tavily_agent_run_operation_id,
		tavily_operation: value.tavily_operation,
		tavily_credits: value.tavily_credits,
		tavily_usage_estimated: value.tavily_usage_estimated,
	};
}

interface MutableLedgerState {
	readonly operations: Map<string, ToolCallCommittedEvent>;
	readonly attempts: Map<string, ReducedAttempt>;
	readonly allocatedIds: Set<string>;
	creditContractOverrun: boolean;
}

function mutableStateFromReduced(reduced: ReducedLedger): MutableLedgerState {
	const operations = new Map(reduced.operations);
	const attempts = new Map(reduced.attempts);
	const allocatedIds = new Set<string>();
	for (const operation of operations.values()) {
		allocatedIds.add(operation.tavily_operation_id);
		allocatedIds.add(operation.tavily_turn_operation_id);
		allocatedIds.add(operation.tavily_agent_run_operation_id);
	}
	for (const attemptId of attempts.keys()) allocatedIds.add(attemptId);
	return { operations, attempts, allocatedIds, creditContractOverrun: reduced.creditContractOverrun };
}

function assertAttemptOwnership(operation: ToolCallCommittedEvent, reservation: CreditReservedEvent): void {
	if (
		operation.tavily_agent_run_operation_id !== reservation.tavily_agent_run_operation_id ||
		operation.tavily_operation !== reservation.tavily_operation
	) {
		throw new TavilyLedgerCorruptionError("a reservation did not belong to its referenced tool operation");
	}
}

function assertSettlementOwnership(reservation: CreditReservedEvent, settlement: CreditSettledEvent): void {
	if (
		reservation.tavily_attempt_id !== settlement.tavily_attempt_id ||
		reservation.tavily_operation_id !== settlement.tavily_operation_id ||
		reservation.tavily_agent_run_operation_id !== settlement.tavily_agent_run_operation_id ||
		reservation.tavily_operation !== settlement.tavily_operation
	) {
		throw new TavilyLedgerCorruptionError("a settlement did not belong to its reservation");
	}
	if (settlement.tavily_usage_estimated && settlement.tavily_credits !== reservation.tavily_reserved_credits) {
		throw new TavilyLedgerCorruptionError("an estimated settlement did not retain the reservation worst case");
	}
}

function insertIdempotent<T extends LedgerEvent>(map: Map<string, T>, id: string, event: T, label: string): void {
	const existing = map.get(id);
	if (existing === undefined) {
		map.set(id, event);
		return;
	}
	if (!eventsEqual(existing, event)) {
		throw new TavilyLedgerCorruptionError(`duplicate ${label} entries conflicted`);
	}
}

function creditsForBranch(state: MutableLedgerState): number {
	let credits = 0;
	for (const attempt of state.attempts.values()) {
		credits += attempt.settlement?.tavily_credits ?? attempt.reservation.tavily_reserved_credits;
	}
	return credits;
}

function creditsForRun(state: MutableLedgerState, agentRunOperationId: string): number {
	let credits = 0;
	for (const attempt of state.attempts.values()) {
		if (attempt.reservation.tavily_agent_run_operation_id !== agentRunOperationId) continue;
		credits += attempt.settlement?.tavily_credits ?? attempt.reservation.tavily_reserved_credits;
	}
	return credits;
}

function countOutstandingReservations(attempts: Iterable<ReducedAttempt>): number {
	let count = 0;
	for (const attempt of attempts) {
		if (attempt.settlement === undefined) count += 1;
	}
	return count;
}

function countOperationsBy(
	operations: Iterable<ToolCallCommittedEvent>,
	key: "tavily_turn_operation_id" | "tavily_agent_run_operation_id",
	value: string,
): number {
	let count = 0;
	for (const operation of operations) {
		if (operation[key] === value) count += 1;
	}
	return count;
}

function worstCaseCredits(depth: RetrievalDepth): number {
	return depth === "advanced" ? 2 : 1;
}

function validateLimits(limits: TavilyBudgetLimits): void {
	const values = [
		limits.maxToolCallsPerTurn,
		limits.maxToolCallsPerAgentRun,
		limits.maxToolCallsPerBranchLineage,
		limits.maxTavilyCreditsPerAgentRun,
		limits.maxTavilyCreditsPerBranchLineage,
	];
	if (values.some((value) => !Number.isSafeInteger(value) || value < 1)) {
		throw new Error("Tavily budget limits must be positive safe integers.");
	}
	if (
		limits.maxToolCallsPerAgentRun < limits.maxToolCallsPerTurn ||
		limits.maxToolCallsPerBranchLineage < limits.maxToolCallsPerAgentRun ||
		limits.maxTavilyCreditsPerBranchLineage < limits.maxTavilyCreditsPerAgentRun
	) {
		throw new Error("Tavily budget limits violate their required ordering.");
	}
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
	const actual = Object.keys(value).sort();
	const canonical = [...expected].sort();
	if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) {
		throw new TavilyLedgerCorruptionError("an entry contained missing or unknown fields");
	}
}

function invalidField(field: string): never {
	throw new TavilyLedgerCorruptionError(`field ${field} was invalid`);
}

function eventsEqual(left: LedgerEvent, right: LedgerEvent): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function isTavilyTool(value: unknown): value is TavilyTool {
	return value === "search" || value === "open";
}

function isRetrievalDepth(value: unknown): value is RetrievalDepth {
	return value === "basic" || value === "advanced";
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPrefixedId(value: unknown, prefix: string): value is string {
	return typeof value === "string" && value.startsWith(prefix) && isIdSuffix(value.slice(prefix.length));
}

function isIdSuffix(value: string): boolean {
	return value.length >= 1 && value.length <= MAX_ID_SUFFIX_LENGTH && /^[A-Za-z0-9_-]+$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

class AsyncMutex {
	#tail: Promise<void> = Promise.resolve();

	async runExclusive<T>(operation: () => T | Promise<T>): Promise<T> {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const predecessor = this.#tail;
		this.#tail = predecessor.then(
			() => gate,
			() => gate,
		);
		await predecessor;
		try {
			return await operation();
		} finally {
			release?.();
		}
	}
}
