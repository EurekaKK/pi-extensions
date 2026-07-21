import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	type CreditReservedEvent,
	type CreditSettledEvent,
	type LedgerEvent,
	reduceCurrentBranchLedger,
	TavilyBudgetLedger,
	type TavilyBudgetLimits,
	TavilyLedgerCorruptionError,
	type ToolCallCommittedEvent,
} from "../src/budgets.js";
import { LEDGER_ENTRY_TYPE } from "../src/constants.js";
import { TavilyToolError } from "../src/errors.js";

const DEFAULT_LIMITS: TavilyBudgetLimits = {
	maxToolCallsPerTurn: 2,
	maxToolCallsPerAgentRun: 3,
	maxToolCallsPerBranchLineage: 4,
	maxTavilyCreditsPerAgentRun: 3,
	maxTavilyCreditsPerBranchLineage: 5,
};

describe("TavilyBudgetLedger tool-call admission", () => {
	it("enforces turn, agent-run, and branch-lineage limits without resetting a busy run", async () => {
		const recorder = createRecorder();
		const ledger = createLedger(recorder, DEFAULT_LIMITS);

		const firstRun = await ledger.onAgentStart();
		expect(await ledger.onAgentStart()).toBe(firstRun);
		await ledger.onTurnStart();
		await ledger.commitToolCall("search");
		await ledger.commitToolCall("open");
		await expect(ledger.commitToolCall("search")).rejects.toMatchObject({
			code: "tavily_tool_budget_exhausted",
		});

		await ledger.onTurnStart();
		await ledger.commitToolCall("search");
		await expect(ledger.commitToolCall("open")).rejects.toMatchObject({
			code: "tavily_tool_budget_exhausted",
		});
		expect(await ledger.onAgentStart()).toBe(firstRun);
		await expect(ledger.commitToolCall("open")).rejects.toBeInstanceOf(TavilyToolError);

		await ledger.onAgentSettled();
		const secondRun = await ledger.onAgentStart();
		expect(secondRun).not.toBe(firstRun);
		await ledger.onTurnStart();
		await ledger.commitToolCall("open");
		await expect(ledger.commitToolCall("search")).rejects.toMatchObject({
			code: "tavily_tool_budget_exhausted",
		});

		const snapshot = await ledger.snapshot();
		expect(snapshot.branchToolCalls).toBe(4);
		expect(recorder.events.filter((event) => event.tavily_event === "tool_call_committed")).toHaveLength(4);
	});

	it("uses unique, non-reusable synthetic turn and run IDs for direct execute calls", async () => {
		const recorder = createRecorder();
		const ledger = createLedger(recorder, {
			...DEFAULT_LIMITS,
			maxToolCallsPerTurn: 1,
			maxToolCallsPerAgentRun: 1,
			maxToolCallsPerBranchLineage: 3,
		});

		const first = await ledger.commitToolCall("search");
		const second = await ledger.commitToolCall("open");
		const third = await ledger.commitToolCall("search");
		expect(first.syntheticTurn).toBe(true);
		expect(first.syntheticAgentRun).toBe(true);
		expect(new Set([first.turnOperationId, second.turnOperationId, third.turnOperationId])).toHaveLength(3);
		expect(new Set([first.agentRunOperationId, second.agentRunOperationId, third.agentRunOperationId])).toHaveLength(3);
		await expect(ledger.commitToolCall("open")).rejects.toMatchObject({
			code: "tavily_tool_budget_exhausted",
		});
	});

	it("does not mutate memory when appendEntry fails", async () => {
		const recorder = createRecorder();
		let fail = true;
		const ledger = createLedger(recorder, DEFAULT_LIMITS, async (customType, event) => {
			if (fail) {
				fail = false;
				throw new Error("disk failed");
			}
			recorder.append(customType, event);
		});
		await ledger.onAgentStart();
		await ledger.onTurnStart();

		await expect(ledger.commitToolCall("search")).rejects.toThrow("disk failed");
		expect((await ledger.snapshot()).branchToolCalls).toBe(0);
		await ledger.commitToolCall("search");
		expect((await ledger.snapshot()).branchToolCalls).toBe(1);
		expect(recorder.events).toHaveLength(1);
	});

	it("serializes concurrent commits so an append delay cannot oversell a limit", async () => {
		const recorder = createRecorder();
		let releaseAppend: (() => void) | undefined;
		let firstAppend = true;
		const ledger = createLedger(
			recorder,
			{
				...DEFAULT_LIMITS,
				maxToolCallsPerTurn: 1,
				maxToolCallsPerAgentRun: 1,
				maxToolCallsPerBranchLineage: 1,
			},
			async (customType, event) => {
				if (firstAppend) {
					firstAppend = false;
					await new Promise<void>((resolve) => {
						releaseAppend = resolve;
					});
				}
				recorder.append(customType, event);
			},
		);
		await ledger.onAgentStart();
		await ledger.onTurnStart();

		const first = ledger.commitToolCall("search");
		const second = ledger.commitToolCall("open");
		await waitUntil(() => releaseAppend !== undefined);
		releaseAppend?.();
		await expect(first).resolves.toMatchObject({ operation: "search" });
		await expect(second).rejects.toMatchObject({ code: "tavily_tool_budget_exhausted" });
		expect((await ledger.snapshot()).branchToolCalls).toBe(1);
	});
});

describe("TavilyBudgetLedger credit admission and settlement", () => {
	it("counts in-flight reservations in both budgets and releases excess after settlement", async () => {
		const recorder = createRecorder();
		const ledger = createLedger(recorder, {
			...DEFAULT_LIMITS,
			maxTavilyCreditsPerAgentRun: 2,
			maxTavilyCreditsPerBranchLineage: 3,
		});
		await ledger.onAgentStart();
		await ledger.onTurnStart();
		const operation = await ledger.commitToolCall("search");

		const first = await ledger.reserve(operation.operationId, "search", "basic");
		await ledger.reserve(operation.operationId, "search", "basic");
		await expect(ledger.reserve(operation.operationId, "search", "basic")).rejects.toMatchObject({
			code: "tavily_credit_budget_exhausted",
		});
		const zero = await ledger.settle(first.attemptId, 0);
		expect(zero).toEqual({ credits: 0, estimated: false, contractOverrun: false, persisted: true });
		await expect(ledger.reserve(operation.operationId, "search", "basic")).resolves.toMatchObject({
			reservedCredits: 1,
		});
		expect((await ledger.snapshot()).branchCredits).toBe(2);
	});

	it("reserves each retry separately and uses the depth worst case", async () => {
		const recorder = createRecorder();
		const ledger = createLedger(recorder, DEFAULT_LIMITS);
		await ledger.onAgentStart();
		await ledger.onTurnStart();
		const operation = await ledger.commitToolCall("open");

		const first = await ledger.reserve(operation.operationId, "open", "advanced");
		expect(first.reservedCredits).toBe(2);
		await ledger.settle(first.attemptId, 1);
		const retry = await ledger.reserve(operation.operationId, "open", "advanced");
		expect(retry.attemptId).not.toBe(first.attemptId);
		expect((await ledger.snapshot()).branchCredits).toBe(3);
	});

	it("uses the reservation as an estimated settlement when usage is absent", async () => {
		const recorder = createRecorder();
		const ledger = createLedger(recorder, DEFAULT_LIMITS);
		const operation = await ledger.commitToolCall("search");
		const reservation = await ledger.reserve(operation.operationId, "search", "advanced");

		await expect(ledger.settle(reservation.attemptId, undefined)).resolves.toEqual({
			credits: 2,
			estimated: true,
			contractOverrun: false,
			persisted: true,
		});
		expect((await ledger.snapshot()).outstandingReservations).toBe(0);
	});

	it("records contract overruns without discarding the actual value", async () => {
		const recorder = createRecorder();
		const ledger = createLedger(recorder, DEFAULT_LIMITS);
		const operation = await ledger.commitToolCall("search");
		const reservation = await ledger.reserve(operation.operationId, "search", "basic");

		await expect(ledger.settle(reservation.attemptId, 4)).resolves.toEqual({
			credits: 4,
			estimated: false,
			contractOverrun: true,
			persisted: true,
		});
		expect(await ledger.snapshot()).toMatchObject({
			branchCredits: 4,
			creditContractOverrun: true,
		});
		await expect(ledger.reserve(operation.operationId, "search", "basic")).rejects.toMatchObject({
			code: "tavily_credit_budget_exhausted",
		});
		const restored = createLedger(createRecorder(), DEFAULT_LIMITS, undefined, recorder.branch());
		await expect(restored.reserve(operation.operationId, "search", "basic")).rejects.toMatchObject({
			code: "tavily_credit_budget_exhausted",
		});
	});

	it("does not release a reservation in memory when settlement persistence fails", async () => {
		const recorder = createRecorder();
		const ledger = createLedger(recorder, DEFAULT_LIMITS, (customType, event) => {
			if (event.tavily_event === "credit_settled") throw new Error("settlement write failed");
			recorder.append(customType, event);
		});
		const operation = await ledger.commitToolCall("search");
		const reservation = await ledger.reserve(operation.operationId, "search", "basic");

		await expect(ledger.settle(reservation.attemptId, 0)).rejects.toThrow("settlement write failed");
		expect(await ledger.snapshot()).toMatchObject({ branchCredits: 1, outstandingReservations: 1 });

		const restored = createLedger(createRecorder(), DEFAULT_LIMITS, undefined, recorder.branch());
		expect(await restored.snapshot()).toMatchObject({ branchCredits: 1, outstandingReservations: 1 });
	});

	it("resets only the short run budget while preserving branch credits", async () => {
		const recorder = createRecorder();
		const limits: TavilyBudgetLimits = {
			...DEFAULT_LIMITS,
			maxTavilyCreditsPerAgentRun: 1,
			maxTavilyCreditsPerBranchLineage: 2,
		};
		const ledger = createLedger(recorder, limits);

		await ledger.onAgentStart();
		await ledger.onTurnStart();
		const first = await ledger.commitToolCall("search");
		await ledger.reserve(first.operationId, "search", "basic");
		await expect(ledger.reserve(first.operationId, "search", "basic")).rejects.toMatchObject({
			code: "tavily_credit_budget_exhausted",
		});

		await ledger.onAgentSettled();
		await ledger.onAgentStart();
		await ledger.onTurnStart();
		const second = await ledger.commitToolCall("open");
		await ledger.reserve(second.operationId, "open", "basic");

		await ledger.onAgentSettled();
		await ledger.onAgentStart();
		await ledger.onTurnStart();
		const third = await ledger.commitToolCall("search");
		await expect(ledger.reserve(third.operationId, "search", "basic")).rejects.toMatchObject({
			code: "tavily_credit_budget_exhausted",
		});
	});
});

describe("current-branch ledger reducer", () => {
	it("is order-independent and deduplicates semantically identical events", () => {
		const events = canonicalEvents();
		const branch = [
			customEntry(events.settlement, "settlement-first"),
			customEntry(events.reservation, "reservation"),
			customEntry(events.operation, "operation"),
			customEntry(events.operation, "operation-duplicate"),
			customEntry(events.reservation, "reservation-duplicate"),
			customEntry(events.settlement, "settlement-duplicate"),
		];

		const reduced = reduceCurrentBranchLedger(branch);
		expect(reduced.branchToolCalls).toBe(1);
		expect(reduced.branchCredits).toBe(0);
		expect(reduced.outstandingReservations).toBe(0);
	});

	it("keeps an unsettled reservation at worst cost after restore", () => {
		const { operation, reservation } = canonicalEvents();
		const reduced = reduceCurrentBranchLedger([
			customEntry(operation, "operation"),
			customEntry(reservation, "reservation"),
		]);
		expect(reduced.branchCredits).toBe(1);
		expect(reduced.outstandingReservations).toBe(1);
	});

	it("ignores foreign session entries and rejects malformed entries in its own namespace", () => {
		const foreign: SessionEntry = {
			type: "custom",
			id: "foreign",
			parentId: null,
			timestamp: "2026-07-21T00:00:00.000Z",
			customType: "another-extension:ledger",
			data: { secret: "ignored" },
		};
		expect(reduceCurrentBranchLedger([foreign]).branchToolCalls).toBe(0);
		expect(() => reduceCurrentBranchLedger([customEntry({ tavily_ledger_version: 99 }, "bad-version")])).toThrow(
			TavilyLedgerCorruptionError,
		);
	});

	it.each([
		["conflicting tool operation", conflictOperation()],
		["conflicting reservation", conflictReservation()],
		["conflicting settlement", conflictSettlement()],
		["orphan settlement", orphanSettlement()],
		["cross-operation attempt", crossOperationSettlement()],
		["unknown field", unknownFieldEvent()],
		["invalid credit", invalidCreditEvent()],
		["under-counted estimated settlement", invalidEstimatedSettlement()],
	])("rejects %s corruption", (_label, branch) => {
		expect(() => reduceCurrentBranchLedger(branch)).toThrow(TavilyLedgerCorruptionError);
	});

	it("restores a replacement branch and clears open lifecycle IDs", async () => {
		const recorder = createRecorder();
		const ledger = createLedger(recorder, DEFAULT_LIMITS);
		await ledger.onAgentStart();
		await ledger.onTurnStart();
		await ledger.commitToolCall("search");
		expect((await ledger.snapshot()).currentAgentRunOperationId).toBeDefined();

		const { operation } = canonicalEvents();
		await ledger.restoreCurrentBranch([customEntry(operation, "restored")]);
		expect(await ledger.snapshot()).toMatchObject({
			branchToolCalls: 1,
			currentTurnToolCalls: 0,
			currentAgentRunToolCalls: 0,
		});
		expect((await ledger.snapshot()).currentAgentRunOperationId).toBeUndefined();
	});

	it("persists only bounded budget metadata and no request content", async () => {
		const recorder = createRecorder();
		const ledger = createLedger(recorder, DEFAULT_LIMITS);
		const operation = await ledger.commitToolCall("search");
		const reservation = await ledger.reserve(operation.operationId, "search", "basic");
		await ledger.settle(reservation.attemptId, 1);

		for (const event of recorder.events) {
			for (const key of Object.keys(event)) expect(key.startsWith("tavily_")).toBe(true);
			const serialized = JSON.stringify(event);
			expect(serialized).not.toMatch(/query|focus|url|title|content|api.?key/iu);
		}
	});
});

interface Recorder {
	readonly events: LedgerEvent[];
	append(customType: typeof LEDGER_ENTRY_TYPE, event: LedgerEvent): void;
	branch(): SessionEntry[];
}

function createRecorder(): Recorder {
	const events: LedgerEvent[] = [];
	return {
		events,
		append(customType, event) {
			expect(customType).toBe(LEDGER_ENTRY_TYPE);
			events.push(event);
		},
		branch() {
			return events.map((event, index) => customEntry(event, `entry-${index}`));
		},
	};
}

function createLedger(
	recorder: Recorder,
	limits: TavilyBudgetLimits,
	appendEntry:
		| ((customType: typeof LEDGER_ENTRY_TYPE, event: LedgerEvent) => void | Promise<void>)
		| undefined = undefined,
	currentBranch: readonly SessionEntry[] = [],
): TavilyBudgetLedger {
	let id = 0;
	return new TavilyBudgetLedger({
		limits,
		appendEntry: appendEntry ?? recorder.append,
		randomId: () => {
			id += 1;
			return `test-${String(id).padStart(6, "0")}`;
		},
		currentBranch,
	});
}

function customEntry(data: unknown, id: string): SessionEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: "2026-07-21T00:00:00.000Z",
		customType: LEDGER_ENTRY_TYPE,
		data,
	};
}

function canonicalEvents(): {
	readonly operation: ToolCallCommittedEvent;
	readonly reservation: CreditReservedEvent;
	readonly settlement: CreditSettledEvent;
} {
	const operation: ToolCallCommittedEvent = {
		tavily_ledger_version: 1,
		tavily_event: "tool_call_committed",
		tavily_operation_id: "tavily_operation_canonical",
		tavily_turn_operation_id: "tavily_turn_operation_canonical",
		tavily_agent_run_operation_id: "tavily_agent_run_operation_canonical",
		tavily_operation: "search",
		tavily_tool_calls: 1,
	};
	const reservation: CreditReservedEvent = {
		tavily_ledger_version: 1,
		tavily_event: "credit_reserved",
		tavily_attempt_id: "tavily_attempt_canonical",
		tavily_operation_id: operation.tavily_operation_id,
		tavily_agent_run_operation_id: operation.tavily_agent_run_operation_id,
		tavily_operation: operation.tavily_operation,
		tavily_depth: "basic",
		tavily_reserved_credits: 1,
	};
	const settlement: CreditSettledEvent = {
		tavily_ledger_version: 1,
		tavily_event: "credit_settled",
		tavily_attempt_id: reservation.tavily_attempt_id,
		tavily_operation_id: reservation.tavily_operation_id,
		tavily_agent_run_operation_id: reservation.tavily_agent_run_operation_id,
		tavily_operation: reservation.tavily_operation,
		tavily_credits: 0,
		tavily_usage_estimated: false,
	};
	return { operation, reservation, settlement };
}

function conflictOperation(): SessionEntry[] {
	const { operation } = canonicalEvents();
	return [customEntry(operation, "one"), customEntry({ ...operation, tavily_operation: "open" }, "two")];
}

function conflictReservation(): SessionEntry[] {
	const { operation, reservation } = canonicalEvents();
	return [
		customEntry(operation, "operation"),
		customEntry(reservation, "one"),
		customEntry({ ...reservation, tavily_depth: "advanced", tavily_reserved_credits: 2 }, "two"),
	];
}

function conflictSettlement(): SessionEntry[] {
	const { operation, reservation, settlement } = canonicalEvents();
	return [
		customEntry(operation, "operation"),
		customEntry(reservation, "reservation"),
		customEntry(settlement, "one"),
		customEntry({ ...settlement, tavily_credits: 1 }, "two"),
	];
}

function orphanSettlement(): SessionEntry[] {
	const { settlement } = canonicalEvents();
	return [customEntry(settlement, "settlement")];
}

function crossOperationSettlement(): SessionEntry[] {
	const { operation, reservation, settlement } = canonicalEvents();
	const other: ToolCallCommittedEvent = {
		...operation,
		tavily_operation_id: "tavily_operation_other",
		tavily_operation: "open",
	};
	return [
		customEntry(operation, "operation"),
		customEntry(other, "other-operation"),
		customEntry(reservation, "reservation"),
		customEntry(
			{
				...settlement,
				tavily_operation_id: other.tavily_operation_id,
				tavily_operation: other.tavily_operation,
			},
			"settlement",
		),
	];
}

function unknownFieldEvent(): SessionEntry[] {
	const { operation } = canonicalEvents();
	return [customEntry({ ...operation, query: "must not be accepted" }, "unknown")];
}

function invalidCreditEvent(): SessionEntry[] {
	const { operation, reservation, settlement } = canonicalEvents();
	return [
		customEntry(operation, "operation"),
		customEntry(reservation, "reservation"),
		customEntry({ ...settlement, tavily_credits: -1 }, "settlement"),
	];
}

function invalidEstimatedSettlement(): SessionEntry[] {
	const { operation, reservation, settlement } = canonicalEvents();
	return [
		customEntry(operation, "operation"),
		customEntry(reservation, "reservation"),
		customEntry({ ...settlement, tavily_usage_estimated: true }, "settlement"),
	];
}

async function waitUntil(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		if (predicate()) return;
		await Promise.resolve();
	}
	throw new Error("condition was not reached");
}
