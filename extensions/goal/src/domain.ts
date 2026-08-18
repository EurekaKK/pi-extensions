import { GOAL_CHANGE_ENTRY_TYPE, GOAL_CHANGE_VERSION, GOAL_ROUND_ENTRY_TYPE } from "./constants.js";

export type GoalPhase = "active" | "paused" | "blocked" | "complete";
export type GoalActivation = "armed" | "disarmed";
export type GoalOperation = "create" | "edit" | "pause" | "resume" | "complete" | "block" | "clear";

export interface GoalRef {
	readonly id: string;
	readonly revision: number;
}

export interface GoalBlockReason {
	readonly code: string;
	readonly message: string;
}

export interface GoalSnapshot extends GoalRef {
	readonly objective: string;
	readonly phase: GoalPhase;
	readonly maxGoalRounds: number;
	readonly blockedReason?: GoalBlockReason | undefined;
}

export interface GoalView extends GoalSnapshot {
	readonly roundsStarted: number;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly activation: GoalActivation;
}

export interface GoalSnapshotChange {
	readonly kind: "goal/change";
	readonly version: 1;
	readonly operation: Exclude<GoalOperation, "clear">;
	readonly goal: GoalSnapshot;
	readonly roundsStarted: number;
	readonly createdAt: number;
	readonly updatedAt: number;
}

export interface GoalClearChange {
	readonly kind: "goal/change";
	readonly version: 1;
	readonly operation: "clear";
	readonly cleared: GoalRef;
	readonly clearedAt: number;
}

export type GoalChange = GoalSnapshotChange | GoalClearChange;

export interface GoalRoundEntryV1 {
	readonly version: 1;
	readonly goalId: string;
	readonly revision: number;
	readonly round: number;
}

export interface GoalServiceState {
	goal: GoalSnapshot | undefined;
	roundsStarted: number;
	createdAt: number | undefined;
	updatedAt: number | undefined;
	lastRef: GoalRef | undefined;
	seenGoalIds: Set<string>;
}

export type GoalChangeParseResult =
	| { readonly status: "valid"; readonly change: GoalChange }
	| { readonly status: "invalid" }
	| { readonly status: "ignored" };

export class GoalError extends Error {
	constructor(
		message: string,
		readonly code: string = "GOAL_ERROR",
	) {
		super(message);
		this.name = "GoalError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const keys = [...expected].sort();
	return (
		Object.getOwnPropertySymbols(value).length === 0 &&
		actual.length === keys.length &&
		actual.every((key, index) => key === keys[index])
	);
}

function positiveInteger(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
		throw new Error(`goal ${field} must be a positive safe integer`);
	}
	return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new Error(`goal ${field} must be a non-negative safe integer`);
	}
	return value;
}

export function normalizeObjective(value: unknown): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new GoalError("goal objective must be a non-empty string", "GOAL_INVALID_OBJECTIVE");
	}
	return value.trim();
}

export function normalizeMaxGoalRounds(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
		throw new GoalError("maxGoalRounds must be a positive safe integer", "GOAL_INVALID_MAX_ROUNDS");
	}
	return value;
}

export function normalizeBlockReason(value: unknown): GoalBlockReason {
	if (!isRecord(value)) throw new GoalError("block reason must be an object", "GOAL_INVALID_BLOCK_REASON");
	const code = value.code;
	const message = value.message;
	if (
		typeof code !== "string" ||
		!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(code) ||
		typeof message !== "string" ||
		message.trim().length === 0
	) {
		throw new GoalError(
			"block reason requires lower-kebab-case code and non-empty message",
			"GOAL_INVALID_BLOCK_REASON",
		);
	}
	return { code, message: message.trim() };
}

function decodeBlockReason(value: unknown): GoalBlockReason {
	if (!isRecord(value) || !hasExactKeys(value, ["code", "message"])) {
		throw new Error("goal blockedReason must have exactly code and message");
	}
	return normalizeBlockReason(value);
}

function decodeSnapshot(value: unknown): GoalSnapshot {
	if (!isRecord(value)) throw new Error("goal snapshot must be a record");
	const phase = value.phase;
	if (phase !== "active" && phase !== "paused" && phase !== "blocked" && phase !== "complete") {
		throw new Error("goal snapshot phase is invalid");
	}
	const expected =
		phase === "blocked"
			? ["blockedReason", "id", "maxGoalRounds", "objective", "phase", "revision"]
			: ["id", "maxGoalRounds", "objective", "phase", "revision"];
	if (!hasExactKeys(value, expected)) throw new Error(`goal snapshot for ${phase} has invalid fields`);
	if (typeof value.id !== "string" || value.id.length === 0) throw new Error("goal id is invalid");
	return {
		id: value.id,
		revision: positiveInteger(value.revision, "revision"),
		objective: normalizeObjective(value.objective),
		phase,
		maxGoalRounds: normalizeMaxGoalRounds(value.maxGoalRounds),
		...(phase === "blocked" ? { blockedReason: decodeBlockReason(value.blockedReason) } : {}),
	};
}

function decodeRef(value: unknown): GoalRef {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, ["id", "revision"]) ||
		typeof value.id !== "string" ||
		value.id.length === 0
	) {
		throw new Error("goal ref is invalid");
	}
	return { id: value.id, revision: positiveInteger(value.revision, "revision") };
}

export function parseGoalChange(value: unknown): GoalChangeParseResult {
	if (!isRecord(value) || value.kind !== "goal/change" || value.version !== GOAL_CHANGE_VERSION) {
		return isRecord(value) && value.kind === "goal/change" ? { status: "invalid" } : { status: "ignored" };
	}
	if (value.operation === undefined) return { status: "invalid" };
	try {
		if (value.operation === "clear") {
			if (!hasExactKeys(value, ["cleared", "clearedAt", "kind", "operation", "version"])) {
				return { status: "invalid" };
			}
			return {
				status: "valid",
				change: {
					kind: "goal/change",
					version: 1,
					operation: "clear",
					cleared: decodeRef(value.cleared),
					clearedAt: nonNegativeInteger(value.clearedAt, "clearedAt"),
				},
			};
		}
		const operation = value.operation;
		if (
			operation !== "create" &&
			operation !== "edit" &&
			operation !== "pause" &&
			operation !== "resume" &&
			operation !== "complete" &&
			operation !== "block"
		) {
			return { status: "invalid" };
		}
		if (!hasExactKeys(value, ["createdAt", "goal", "kind", "operation", "roundsStarted", "updatedAt", "version"])) {
			return { status: "invalid" };
		}
		return {
			status: "valid",
			change: {
				kind: "goal/change",
				version: 1,
				operation,
				goal: decodeSnapshot(value.goal),
				roundsStarted: nonNegativeInteger(value.roundsStarted, "roundsStarted"),
				createdAt: nonNegativeInteger(value.createdAt, "createdAt"),
				updatedAt: nonNegativeInteger(value.updatedAt, "updatedAt"),
			},
		};
	} catch {
		return { status: "invalid" };
	}
}

export function parseGoalRound(value: unknown): GoalRoundEntryV1 | null {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, ["goalId", "revision", "round", "version"]) ||
		value.version !== 1 ||
		typeof value.goalId !== "string" ||
		value.goalId.length === 0
	) {
		return null;
	}
	try {
		return {
			version: 1,
			goalId: value.goalId,
			revision: positiveInteger(value.revision, "round.revision"),
			round: positiveInteger(value.round, "round.round"),
		};
	} catch {
		return null;
	}
}

export function emptyGoalState(): GoalServiceState {
	return {
		goal: undefined,
		roundsStarted: 0,
		createdAt: undefined,
		updatedAt: undefined,
		lastRef: undefined,
		seenGoalIds: new Set(),
	};
}

function sameDefinition(current: GoalSnapshot, next: GoalSnapshot, operation: GoalOperation): void {
	if (next.objective !== current.objective || next.maxGoalRounds !== current.maxGoalRounds) {
		throw new Error(`goal ${operation} cannot change objective or maxGoalRounds`);
	}
}

function requireNextRevision(current: GoalSnapshot, next: GoalRef, operation: GoalOperation): void {
	if (next.id !== current.id || next.revision !== current.revision + 1) {
		throw new Error(`goal ${operation} must advance the current goal by one revision`);
	}
}

export function applyGoalChange(state: GoalServiceState, change: GoalChange): void {
	const ref = change.operation === "clear" ? change.cleared : change.goal;
	if (change.operation === "clear") {
		const current = state.goal;
		if (current === undefined) throw new Error("goal clear requires a current goal");
		requireNextRevision(current, change.cleared, "clear");
		if (state.updatedAt === undefined || change.clearedAt < state.updatedAt) {
			throw new Error("goal clear timestamp is invalid");
		}
		state.goal = undefined;
		state.roundsStarted = 0;
		state.createdAt = undefined;
		state.updatedAt = undefined;
		state.lastRef = ref;
		return;
	}

	if (change.operation === "create") {
		if (
			change.goal.revision !== 1 ||
			change.goal.phase !== "active" ||
			change.roundsStarted !== 0 ||
			(state.goal !== undefined && state.goal.phase !== "complete") ||
			state.seenGoalIds.has(change.goal.id)
		) {
			throw new Error("goal create requires a fresh active revision-one goal");
		}
		state.seenGoalIds.add(change.goal.id);
	} else {
		const current = state.goal;
		if (current === undefined) throw new Error(`goal ${change.operation} requires a current goal`);
		requireNextRevision(current, change.goal, change.operation);
		if (state.createdAt === undefined || state.updatedAt === undefined) throw new Error("goal state lacks timestamps");
		if (change.createdAt !== state.createdAt || change.updatedAt < state.updatedAt) {
			throw new Error("goal timestamps are invalid");
		}
		if (change.roundsStarted !== state.roundsStarted) throw new Error("goal roundsStarted must be preserved");
		switch (change.operation) {
			case "edit":
				if (change.goal.phase !== current.phase) throw new Error("goal edit cannot change phase");
				break;
			case "pause":
				sameDefinition(current, change.goal, "pause");
				if (current.phase !== "active" || change.goal.phase !== "paused") throw new Error("invalid goal pause");
				break;
			case "resume":
				sameDefinition(current, change.goal, "resume");
				if (
					(current.phase !== "active" && current.phase !== "paused" && current.phase !== "blocked") ||
					change.goal.phase !== "active" ||
					state.roundsStarted >= change.goal.maxGoalRounds
				) {
					throw new Error("invalid goal resume");
				}
				break;
			case "complete":
				sameDefinition(current, change.goal, "complete");
				if (current.phase === "complete" || change.goal.phase !== "complete") {
					throw new Error("invalid goal complete");
				}
				break;
			case "block":
				sameDefinition(current, change.goal, "block");
				if (current.phase !== "active" || change.goal.phase !== "blocked") throw new Error("invalid goal block");
				break;
			default:
				throw new Error("unreachable goal operation");
		}
	}
	state.goal = change.goal;
	state.roundsStarted = change.roundsStarted;
	state.createdAt = change.createdAt;
	state.updatedAt = change.updatedAt;
	state.lastRef = ref;
}

export function applyGoalRound(state: GoalServiceState, round: GoalRoundEntryV1): void {
	const goal = state.goal;
	if (goal === undefined || goal.phase !== "active") throw new Error("goal round requires an active goal");
	if (round.goalId !== goal.id || round.revision !== goal.revision || round.round !== state.roundsStarted + 1) {
		throw new Error("goal round is not the next admitted round");
	}
	if (round.round > goal.maxGoalRounds) throw new Error("goal round exceeds maxGoalRounds");
	state.roundsStarted = round.round;
}

export function foldGoalEntries(entries: readonly { type: string; customType?: string; data?: unknown }[]): {
	state: GoalServiceState;
	foundInvalid: boolean;
} {
	const state = emptyGoalState();
	let foundInvalid = false;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType === undefined) continue;
		if (entry.customType === GOAL_CHANGE_ENTRY_TYPE) {
			const parsed = parseGoalChange(entry.data);
			if (parsed.status === "valid") {
				try {
					applyGoalChange(state, parsed.change);
				} catch {
					foundInvalid = true;
				}
			} else if (parsed.status === "invalid") {
				foundInvalid = true;
			}
			continue;
		}
		if (entry.customType === GOAL_ROUND_ENTRY_TYPE) {
			const round = parseGoalRound(entry.data);
			if (round === null) {
				foundInvalid = true;
				continue;
			}
			try {
				applyGoalRound(state, round);
			} catch {
				foundInvalid = true;
			}
		}
	}
	return { state, foundInvalid };
}

export function buildView(state: GoalServiceState, activation: GoalActivation): GoalView | undefined {
	const goal = state.goal;
	if (goal === undefined) return undefined;
	if (state.createdAt === undefined || state.updatedAt === undefined) throw new Error("goal state lacks timestamps");
	return {
		...goal,
		roundsStarted: state.roundsStarted,
		createdAt: state.createdAt,
		updatedAt: state.updatedAt,
		activation,
	};
}
