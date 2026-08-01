import { GOAL_EVALUATION_ENTRY_TYPE, GOAL_LIFECYCLE_ENTRY_TYPE } from "./constants.js";

export {
	GOAL_CONTROL_MESSAGE_TYPE,
	GOAL_EVALUATION_ENTRY_TYPE,
	GOAL_EVALUATION_MESSAGE_TYPE,
	GOAL_LIFECYCLE_ENTRY_TYPE,
	GOAL_STATUS_KEY,
} from "./constants.js";

export const GOAL_VISIBLE_STATUSES = ["running", "evaluating", "paused", "failed", "error"] as const;
export const GOAL_TERMINAL_STATUSES = ["completed", "cancelled"] as const;
export const GOAL_PHASES = ["main", "evaluation"] as const;
export const GOAL_DECISIONS = ["continue", "complete", "fail"] as const;
export const GOAL_MAIN_RUN_CAUSES = [
	"creation",
	"evaluation-continue",
	"resume",
	"startup-resume",
	"user-steering",
] as const;
export const GOAL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type GoalVisibleStatus = (typeof GOAL_VISIBLE_STATUSES)[number];
export type GoalTerminalStatus = (typeof GOAL_TERMINAL_STATUSES)[number];
export type GoalPhase = (typeof GOAL_PHASES)[number];
export type GoalDecision = (typeof GOAL_DECISIONS)[number];
export type GoalMainRunCause = (typeof GOAL_MAIN_RUN_CAUSES)[number];
export type GoalThinkingLevel = (typeof GOAL_THINKING_LEVELS)[number];
export type GoalStateStatus = GoalVisibleStatus | GoalTerminalStatus | "dismissed";

const MAX_PROGRESS_CHARACTERS = 4_000;
const MAX_REASON_CHARACTERS = 1_000;
const MAX_NEXT_ACTION_CHARACTERS = 2_000;
const MAX_EVIDENCE_ITEMS = 16;
const MAX_EVIDENCE_CHARACTERS = 1_000;

interface GoalEvaluationReportBaseV1 {
	readonly progress: string;
	readonly reason: string;
	readonly evidence: readonly string[];
}

export interface GoalContinueEvaluationReportV1 extends GoalEvaluationReportBaseV1 {
	readonly decision: "continue";
	readonly next_action: string;
}

export interface GoalTerminalEvaluationReportV1 extends GoalEvaluationReportBaseV1 {
	readonly decision: "complete" | "fail";
	readonly next_action: null;
}

export type GoalEvaluationReportV1 = GoalContinueEvaluationReportV1 | GoalTerminalEvaluationReportV1;

export interface GoalModelSnapshotV1 {
	readonly provider: string;
	readonly id: string;
}

export interface GoalLifecycleBaseV1 {
	readonly schemaVersion: 1;
	readonly ownerSessionId: string;
	readonly goalId: string;
	readonly sequence: number;
	readonly timestamp: number;
	readonly activeElapsedMs: number;
}

export interface GoalCreatedEventV1 extends GoalLifecycleBaseV1 {
	readonly kind: "created";
	readonly goalText: string;
	readonly goalSummary: string;
	readonly creationAnchorEntryId: string | null;
	readonly createdAt: number;
}

export interface GoalMainStartedEventV1 extends GoalLifecycleBaseV1 {
	readonly kind: "main-started";
	readonly mainRunId: string;
	readonly cause: GoalMainRunCause;
}

export interface GoalMainSettledEventV1 extends GoalLifecycleBaseV1 {
	readonly kind: "main-settled";
	readonly mainRunId: string;
}

export interface GoalEvaluationStartedEventV1 extends GoalLifecycleBaseV1 {
	readonly kind: "evaluation-started";
	readonly evaluationNumber: number;
	readonly evaluationAttemptId: string;
	readonly precedingMainRunId: string;
	readonly model: GoalModelSnapshotV1;
	readonly thinkingLevel: GoalThinkingLevel;
}

export interface GoalEvaluationInvalidatedEventV1 extends GoalLifecycleBaseV1 {
	readonly kind: "evaluation-invalidated";
	readonly evaluationAttemptId: string;
}

export interface GoalPausedEventV1 extends GoalLifecycleBaseV1 {
	readonly kind: "paused";
	readonly interruptedPhase: GoalPhase;
}

export interface GoalErrorEventV1 extends GoalLifecycleBaseV1 {
	readonly kind: "error";
	readonly failedPhase: GoalPhase;
}

export interface GoalResumedEventV1 extends GoalLifecycleBaseV1 {
	readonly kind: "resumed";
	readonly resumePhase: GoalPhase;
}

export interface GoalShutdownCheckpointEventV1 extends GoalLifecycleBaseV1 {
	readonly kind: "shutdown-checkpoint";
	readonly phase: GoalPhase;
}

export interface GoalCancelledEventV1 extends GoalLifecycleBaseV1 {
	readonly kind: "cancelled";
}

export interface GoalDismissedEventV1 extends GoalLifecycleBaseV1 {
	readonly kind: "dismissed";
}

export type GoalLifecycleEventV1 =
	| GoalCreatedEventV1
	| GoalMainStartedEventV1
	| GoalMainSettledEventV1
	| GoalEvaluationStartedEventV1
	| GoalEvaluationInvalidatedEventV1
	| GoalPausedEventV1
	| GoalErrorEventV1
	| GoalResumedEventV1
	| GoalShutdownCheckpointEventV1
	| GoalCancelledEventV1
	| GoalDismissedEventV1;

export interface GoalEvaluationEntryV1 extends GoalLifecycleBaseV1 {
	readonly evaluationId: string;
	readonly evaluationNumber: number;
	readonly evaluationAttemptId: string;
	readonly precedingMainRunId: string;
	readonly report: GoalEvaluationReportV1;
}

export interface PendingGoalEvaluationV1 {
	readonly evaluationNumber: number;
	readonly precedingMainRunId: string;
	readonly evaluationAttemptId: string | null;
	readonly model: GoalModelSnapshotV1 | null;
	readonly thinkingLevel: GoalThinkingLevel | null;
}

export interface RestoredGoalStateV1 {
	readonly schemaVersion: 1;
	readonly ownerSessionId: string;
	readonly goalId: string;
	readonly goalText: string;
	readonly goalSummary: string;
	readonly creationAnchorEntryId: string | null;
	readonly createdAt: number;
	readonly status: GoalStateStatus;
	readonly resumePhase: GoalPhase | null;
	readonly activeElapsedMs: number;
	readonly lastSequence: number;
	readonly evaluationCount: number;
	readonly evaluationHistory: readonly GoalEvaluationEntryV1[];
	readonly lastMainRunId: string | null;
	readonly lastMainRunCause: GoalMainRunCause | null;
	readonly mainRunInProgress: boolean;
	readonly pendingEvaluation: PendingGoalEvaluationV1 | null;
}

export interface RestoredGoalSessionV1 {
	readonly goal: RestoredGoalStateV1 | null;
	readonly foundCorruptEntry: boolean;
}

export interface GoalElapsedState {
	readonly activeElapsedMs: number;
	readonly segmentStartedAt: number | null;
}

type DistributiveOmit<Value, Key extends PropertyKey> = Value extends unknown ? Omit<Value, Key> : never;

export type GoalLifecycleEventInputV1 = DistributiveOmit<GoalLifecycleEventV1, "schemaVersion">;
export type GoalEvaluationEntryInputV1 = Omit<GoalEvaluationEntryV1, "schemaVersion">;

export interface CreateGoalCreatedEventInputV1 {
	readonly ownerSessionId: string;
	readonly goalId: string;
	readonly sequence: number;
	readonly timestamp: number;
	readonly activeElapsedMs: number;
	readonly goalText: string;
	readonly creationAnchorEntryId: string | null;
	readonly createdAt?: number;
}

type JsonRecord = Record<string, unknown>;

function isPlainRecord(value: unknown): value is JsonRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: JsonRecord, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return (
		Object.getOwnPropertySymbols(value).length === 0 &&
		actual.length === expected.length &&
		actual.every((key, index) => key === expected[index])
	);
}

function isNonBlankString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function isNullableNonBlankString(value: unknown): value is string | null {
	return value === null || isNonBlankString(value);
}

function isNonNegativeFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isOneOf<const Values extends readonly string[]>(value: unknown, values: Values): value is Values[number] {
	return typeof value === "string" && (values as readonly string[]).includes(value);
}

function characterCount(value: string): number {
	return [...value].length;
}

function isBoundedNonBlankString(value: unknown, maximumCharacters: number): value is string {
	return isNonBlankString(value) && characterCount(value) <= maximumCharacters;
}

function freezeModel(model: GoalModelSnapshotV1): GoalModelSnapshotV1 {
	return Object.freeze({ provider: model.provider, id: model.id });
}

function parseGoalModelSnapshot(value: unknown): GoalModelSnapshotV1 | null {
	if (!isPlainRecord(value) || !hasExactKeys(value, ["provider", "id"])) return null;
	if (!isNonBlankString(value.provider) || !isNonBlankString(value.id)) return null;
	return freezeModel({ provider: value.provider, id: value.id });
}

export function summarizeGoalText(goalText: string): string {
	return goalText.replace(/\s+/gu, " ").trim();
}

export function parseGoalEvaluationReport(value: unknown): GoalEvaluationReportV1 | null {
	if (!isPlainRecord(value) || !hasExactKeys(value, ["decision", "progress", "reason", "next_action", "evidence"])) {
		return null;
	}
	if (!isOneOf(value.decision, GOAL_DECISIONS)) return null;
	if (!isBoundedNonBlankString(value.progress, MAX_PROGRESS_CHARACTERS)) return null;
	if (!isBoundedNonBlankString(value.reason, MAX_REASON_CHARACTERS)) return null;
	if (!Array.isArray(value.evidence) || value.evidence.length < 1 || value.evidence.length > MAX_EVIDENCE_ITEMS) {
		return null;
	}
	const evidence: string[] = [];
	for (const item of value.evidence) {
		if (!isBoundedNonBlankString(item, MAX_EVIDENCE_CHARACTERS)) return null;
		evidence.push(item);
	}

	const frozenEvidence = Object.freeze(evidence);
	if (value.decision === "continue") {
		if (!isBoundedNonBlankString(value.next_action, MAX_NEXT_ACTION_CHARACTERS)) return null;
		return Object.freeze({
			decision: value.decision,
			progress: value.progress,
			reason: value.reason,
			next_action: value.next_action,
			evidence: frozenEvidence,
		});
	}
	if (value.next_action !== null) return null;
	return Object.freeze({
		decision: value.decision,
		progress: value.progress,
		reason: value.reason,
		next_action: null,
		evidence: frozenEvidence,
	});
}

function hasValidLifecycleBase(value: JsonRecord): boolean {
	return (
		value.schemaVersion === 1 &&
		isNonBlankString(value.ownerSessionId) &&
		isNonBlankString(value.goalId) &&
		isPositiveSafeInteger(value.sequence) &&
		isNonNegativeFiniteNumber(value.timestamp) &&
		isNonNegativeFiniteNumber(value.activeElapsedMs)
	);
}

function lifecycleBase(value: JsonRecord): GoalLifecycleBaseV1 {
	return {
		schemaVersion: 1,
		ownerSessionId: value.ownerSessionId as string,
		goalId: value.goalId as string,
		sequence: value.sequence as number,
		timestamp: value.timestamp as number,
		activeElapsedMs: value.activeElapsedMs as number,
	};
}

const BASE_KEYS = ["schemaVersion", "ownerSessionId", "goalId", "sequence", "timestamp", "activeElapsedMs"] as const;

export function parseGoalLifecycleEvent(value: unknown): GoalLifecycleEventV1 | null {
	if (!isPlainRecord(value) || !hasValidLifecycleBase(value) || typeof value.kind !== "string") return null;
	const base = lifecycleBase(value);

	switch (value.kind) {
		case "created": {
			if (
				!hasExactKeys(value, [...BASE_KEYS, "kind", "goalText", "goalSummary", "creationAnchorEntryId", "createdAt"]) ||
				typeof value.goalText !== "string" ||
				value.goalText.trim().length === 0 ||
				typeof value.goalSummary !== "string" ||
				value.goalSummary !== summarizeGoalText(value.goalText) ||
				!isNullableNonBlankString(value.creationAnchorEntryId) ||
				!isNonNegativeFiniteNumber(value.createdAt)
			) {
				return null;
			}
			return Object.freeze({
				...base,
				kind: value.kind,
				goalText: value.goalText,
				goalSummary: value.goalSummary,
				creationAnchorEntryId: value.creationAnchorEntryId,
				createdAt: value.createdAt,
			});
		}
		case "main-started": {
			if (
				!hasExactKeys(value, [...BASE_KEYS, "kind", "mainRunId", "cause"]) ||
				!isNonBlankString(value.mainRunId) ||
				!isOneOf(value.cause, GOAL_MAIN_RUN_CAUSES)
			) {
				return null;
			}
			return Object.freeze({ ...base, kind: value.kind, mainRunId: value.mainRunId, cause: value.cause });
		}
		case "main-settled": {
			if (!hasExactKeys(value, [...BASE_KEYS, "kind", "mainRunId"]) || !isNonBlankString(value.mainRunId)) {
				return null;
			}
			return Object.freeze({ ...base, kind: value.kind, mainRunId: value.mainRunId });
		}
		case "evaluation-started": {
			if (
				!hasExactKeys(value, [
					...BASE_KEYS,
					"kind",
					"evaluationNumber",
					"evaluationAttemptId",
					"precedingMainRunId",
					"model",
					"thinkingLevel",
				]) ||
				!isPositiveSafeInteger(value.evaluationNumber) ||
				!isNonBlankString(value.evaluationAttemptId) ||
				!isNonBlankString(value.precedingMainRunId) ||
				!isOneOf(value.thinkingLevel, GOAL_THINKING_LEVELS)
			) {
				return null;
			}
			const model = parseGoalModelSnapshot(value.model);
			if (model === null) return null;
			return Object.freeze({
				...base,
				kind: value.kind,
				evaluationNumber: value.evaluationNumber,
				evaluationAttemptId: value.evaluationAttemptId,
				precedingMainRunId: value.precedingMainRunId,
				model,
				thinkingLevel: value.thinkingLevel,
			});
		}
		case "evaluation-invalidated": {
			if (
				!hasExactKeys(value, [...BASE_KEYS, "kind", "evaluationAttemptId"]) ||
				!isNonBlankString(value.evaluationAttemptId)
			) {
				return null;
			}
			return Object.freeze({ ...base, kind: value.kind, evaluationAttemptId: value.evaluationAttemptId });
		}
		case "paused": {
			if (
				!hasExactKeys(value, [...BASE_KEYS, "kind", "interruptedPhase"]) ||
				!isOneOf(value.interruptedPhase, GOAL_PHASES)
			) {
				return null;
			}
			return Object.freeze({ ...base, kind: value.kind, interruptedPhase: value.interruptedPhase });
		}
		case "error": {
			if (!hasExactKeys(value, [...BASE_KEYS, "kind", "failedPhase"]) || !isOneOf(value.failedPhase, GOAL_PHASES)) {
				return null;
			}
			return Object.freeze({ ...base, kind: value.kind, failedPhase: value.failedPhase });
		}
		case "resumed": {
			if (!hasExactKeys(value, [...BASE_KEYS, "kind", "resumePhase"]) || !isOneOf(value.resumePhase, GOAL_PHASES)) {
				return null;
			}
			return Object.freeze({ ...base, kind: value.kind, resumePhase: value.resumePhase });
		}
		case "shutdown-checkpoint": {
			if (!hasExactKeys(value, [...BASE_KEYS, "kind", "phase"]) || !isOneOf(value.phase, GOAL_PHASES)) {
				return null;
			}
			return Object.freeze({ ...base, kind: value.kind, phase: value.phase });
		}
		case "cancelled":
		case "dismissed":
			if (!hasExactKeys(value, [...BASE_KEYS, "kind"])) return null;
			return Object.freeze({ ...base, kind: value.kind });
		default:
			return null;
	}
}

export function parseGoalEvaluationEntry(value: unknown): GoalEvaluationEntryV1 | null {
	if (
		!isPlainRecord(value) ||
		!hasExactKeys(value, [
			...BASE_KEYS,
			"evaluationId",
			"evaluationNumber",
			"evaluationAttemptId",
			"precedingMainRunId",
			"report",
		]) ||
		!hasValidLifecycleBase(value) ||
		!isNonBlankString(value.evaluationId) ||
		!isPositiveSafeInteger(value.evaluationNumber) ||
		!isNonBlankString(value.evaluationAttemptId) ||
		!isNonBlankString(value.precedingMainRunId)
	) {
		return null;
	}
	const report = parseGoalEvaluationReport(value.report);
	if (report === null) return null;
	return Object.freeze({
		...lifecycleBase(value),
		evaluationId: value.evaluationId,
		evaluationNumber: value.evaluationNumber,
		evaluationAttemptId: value.evaluationAttemptId,
		precedingMainRunId: value.precedingMainRunId,
		report,
	});
}

export function createGoalLifecycleEvent(input: GoalLifecycleEventInputV1): GoalLifecycleEventV1 {
	const event = parseGoalLifecycleEvent({ schemaVersion: 1, ...input });
	if (event === null) throw new TypeError("Invalid goal lifecycle event input.");
	return event;
}

export function createGoalCreatedEvent(input: CreateGoalCreatedEventInputV1): GoalCreatedEventV1 {
	const event = createGoalLifecycleEvent({
		kind: "created",
		ownerSessionId: input.ownerSessionId,
		goalId: input.goalId,
		sequence: input.sequence,
		timestamp: input.timestamp,
		activeElapsedMs: input.activeElapsedMs,
		goalText: input.goalText,
		goalSummary: summarizeGoalText(input.goalText),
		creationAnchorEntryId: input.creationAnchorEntryId,
		createdAt: input.createdAt ?? input.timestamp,
	});
	if (event.kind !== "created") throw new Error("Goal created event factory invariant failed.");
	return event;
}

export function createGoalEvaluationEntry(input: GoalEvaluationEntryInputV1): GoalEvaluationEntryV1 {
	const entry = parseGoalEvaluationEntry({ schemaVersion: 1, ...input });
	if (entry === null) throw new TypeError("Invalid goal evaluation entry input.");
	return entry;
}

export function isGoalVisibleStatus(value: unknown): value is GoalVisibleStatus {
	return isOneOf(value, GOAL_VISIBLE_STATUSES);
}

export function isGoalTerminalStatus(value: unknown): value is GoalTerminalStatus {
	return isOneOf(value, GOAL_TERMINAL_STATUSES);
}

export function isGoalActiveStatus(status: GoalStateStatus): status is "running" | "evaluating" {
	return status === "running" || status === "evaluating";
}

export function canCreateGoalAfter(status: GoalStateStatus | null): boolean {
	return (
		status === null || status === "failed" || status === "completed" || status === "cancelled" || status === "dismissed"
	);
}

function assertElapsedNumber(value: number, name: string): void {
	if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a finite non-negative number.`);
}

export function beginActiveElapsed(activeElapsedMs: number, monotonicNow: number): GoalElapsedState {
	assertElapsedNumber(activeElapsedMs, "activeElapsedMs");
	assertElapsedNumber(monotonicNow, "monotonicNow");
	return Object.freeze({ activeElapsedMs, segmentStartedAt: monotonicNow });
}

export function readActiveElapsed(state: GoalElapsedState, monotonicNow: number): number {
	assertElapsedNumber(state.activeElapsedMs, "activeElapsedMs");
	assertElapsedNumber(monotonicNow, "monotonicNow");
	if (state.segmentStartedAt === null) return state.activeElapsedMs;
	assertElapsedNumber(state.segmentStartedAt, "segmentStartedAt");
	return state.activeElapsedMs + Math.max(0, monotonicNow - state.segmentStartedAt);
}

export function foldActiveElapsed(state: GoalElapsedState, monotonicNow: number): GoalElapsedState {
	return Object.freeze({ activeElapsedMs: readActiveElapsed(state, monotonicNow), segmentStartedAt: null });
}

function freezePendingEvaluation(value: PendingGoalEvaluationV1 | null): PendingGoalEvaluationV1 | null {
	if (value === null) return null;
	return Object.freeze({
		evaluationNumber: value.evaluationNumber,
		precedingMainRunId: value.precedingMainRunId,
		evaluationAttemptId: value.evaluationAttemptId,
		model: value.model === null ? null : freezeModel(value.model),
		thinkingLevel: value.thinkingLevel,
	});
}

function freezeGoalState(state: RestoredGoalStateV1): RestoredGoalStateV1 {
	return Object.freeze({
		...state,
		evaluationHistory: Object.freeze([...state.evaluationHistory]),
		pendingEvaluation: freezePendingEvaluation(state.pendingEvaluation),
	});
}

function stateFromCreated(event: GoalCreatedEventV1): RestoredGoalStateV1 {
	return freezeGoalState({
		schemaVersion: 1,
		ownerSessionId: event.ownerSessionId,
		goalId: event.goalId,
		goalText: event.goalText,
		goalSummary: event.goalSummary,
		creationAnchorEntryId: event.creationAnchorEntryId,
		createdAt: event.createdAt,
		status: "running",
		resumePhase: null,
		activeElapsedMs: event.activeElapsedMs,
		lastSequence: event.sequence,
		evaluationCount: 0,
		evaluationHistory: [],
		lastMainRunId: null,
		lastMainRunCause: null,
		mainRunInProgress: false,
		pendingEvaluation: null,
	});
}

function hasMatchingBase(state: RestoredGoalStateV1, event: GoalLifecycleBaseV1): boolean {
	return (
		event.ownerSessionId === state.ownerSessionId &&
		event.goalId === state.goalId &&
		event.sequence > state.lastSequence &&
		event.activeElapsedMs >= state.activeElapsedMs
	);
}

function withEventBase(
	state: RestoredGoalStateV1,
	event: GoalLifecycleBaseV1,
	changes: Partial<RestoredGoalStateV1>,
): RestoredGoalStateV1 {
	return freezeGoalState({
		...state,
		...changes,
		activeElapsedMs: event.activeElapsedMs,
		lastSequence: event.sequence,
	});
}

function clearedEvaluationAttempt(pending: PendingGoalEvaluationV1 | null): PendingGoalEvaluationV1 | null {
	if (pending === null) return null;
	return {
		...pending,
		evaluationAttemptId: null,
		model: null,
		thinkingLevel: null,
	};
}

function applyLifecycleEvent(state: RestoredGoalStateV1, event: GoalLifecycleEventV1): RestoredGoalStateV1 | null {
	if (event.kind === "created" || !hasMatchingBase(state, event)) return null;

	switch (event.kind) {
		case "main-started":
			if (state.status !== "running" || state.pendingEvaluation !== null) return null;
			if (state.mainRunInProgress && event.cause !== "startup-resume") return null;
			return withEventBase(state, event, {
				lastMainRunId: event.mainRunId,
				lastMainRunCause: event.cause,
				mainRunInProgress: true,
				resumePhase: null,
			});
		case "main-settled":
			if (
				state.status !== "running" ||
				!state.mainRunInProgress ||
				state.lastMainRunId !== event.mainRunId ||
				state.pendingEvaluation !== null
			) {
				return null;
			}
			return withEventBase(state, event, {
				status: "evaluating",
				mainRunInProgress: false,
				pendingEvaluation: {
					evaluationNumber: state.evaluationCount + 1,
					precedingMainRunId: event.mainRunId,
					evaluationAttemptId: null,
					model: null,
					thinkingLevel: null,
				},
			});
		case "evaluation-started": {
			const pending = state.pendingEvaluation;
			if (
				state.status !== "evaluating" ||
				pending === null ||
				event.evaluationNumber !== pending.evaluationNumber ||
				event.precedingMainRunId !== pending.precedingMainRunId ||
				event.evaluationNumber !== state.evaluationCount + 1 ||
				event.evaluationAttemptId === pending.evaluationAttemptId
			) {
				return null;
			}
			return withEventBase(state, event, {
				pendingEvaluation: {
					evaluationNumber: event.evaluationNumber,
					precedingMainRunId: event.precedingMainRunId,
					evaluationAttemptId: event.evaluationAttemptId,
					model: event.model,
					thinkingLevel: event.thinkingLevel,
				},
			});
		}
		case "evaluation-invalidated":
			if (state.status !== "evaluating" || state.pendingEvaluation?.evaluationAttemptId !== event.evaluationAttemptId) {
				return null;
			}
			return withEventBase(state, event, {
				status: "running",
				resumePhase: null,
				pendingEvaluation: null,
				mainRunInProgress: false,
			});
		case "paused": {
			const expectedStatus = event.interruptedPhase === "main" ? "running" : "evaluating";
			if (state.status !== expectedStatus) return null;
			return withEventBase(state, event, {
				status: "paused",
				resumePhase: event.interruptedPhase,
				mainRunInProgress: false,
				pendingEvaluation:
					event.interruptedPhase === "evaluation"
						? clearedEvaluationAttempt(state.pendingEvaluation)
						: state.pendingEvaluation,
			});
		}
		case "error": {
			const expectedStatus = event.failedPhase === "main" ? "running" : "evaluating";
			if (state.status !== expectedStatus) return null;
			return withEventBase(state, event, {
				status: "error",
				resumePhase: event.failedPhase,
				mainRunInProgress: false,
				pendingEvaluation:
					event.failedPhase === "evaluation"
						? clearedEvaluationAttempt(state.pendingEvaluation)
						: state.pendingEvaluation,
			});
		}
		case "resumed":
			if ((state.status !== "paused" && state.status !== "error") || state.resumePhase !== event.resumePhase) {
				return null;
			}
			if (event.resumePhase === "evaluation" && state.pendingEvaluation === null) return null;
			return withEventBase(state, event, {
				status: event.resumePhase === "main" ? "running" : "evaluating",
				resumePhase: null,
				mainRunInProgress: false,
				pendingEvaluation:
					event.resumePhase === "evaluation" ? clearedEvaluationAttempt(state.pendingEvaluation) : null,
			});
		case "shutdown-checkpoint": {
			const expectedStatus = event.phase === "main" ? "running" : "evaluating";
			if (state.status !== expectedStatus) return null;
			return withEventBase(state, event, {
				mainRunInProgress: false,
				pendingEvaluation:
					event.phase === "evaluation" ? clearedEvaluationAttempt(state.pendingEvaluation) : state.pendingEvaluation,
			});
		}
		case "cancelled":
			if (
				state.status !== "running" &&
				state.status !== "evaluating" &&
				state.status !== "paused" &&
				state.status !== "error"
			) {
				return null;
			}
			return withEventBase(state, event, {
				status: "cancelled",
				resumePhase: null,
				mainRunInProgress: false,
				pendingEvaluation: null,
			});
		case "dismissed":
			if (state.status !== "failed") return null;
			return withEventBase(state, event, {
				status: "dismissed",
				resumePhase: null,
				mainRunInProgress: false,
				pendingEvaluation: null,
			});
	}
}

function applyEvaluationEntry(state: RestoredGoalStateV1, entry: GoalEvaluationEntryV1): RestoredGoalStateV1 | null {
	const pending = state.pendingEvaluation;
	if (
		state.status !== "evaluating" ||
		pending === null ||
		pending.evaluationAttemptId === null ||
		!hasMatchingBase(state, entry) ||
		entry.evaluationNumber !== state.evaluationCount + 1 ||
		entry.evaluationNumber !== pending.evaluationNumber ||
		entry.evaluationAttemptId !== pending.evaluationAttemptId ||
		entry.precedingMainRunId !== pending.precedingMainRunId ||
		state.evaluationHistory.some((evaluation) => evaluation.evaluationId === entry.evaluationId)
	) {
		return null;
	}

	const status: GoalStateStatus =
		entry.report.decision === "continue" ? "running" : entry.report.decision === "complete" ? "completed" : "failed";
	return withEventBase(state, entry, {
		status,
		resumePhase: null,
		evaluationCount: entry.evaluationNumber,
		evaluationHistory: [...state.evaluationHistory, entry],
		mainRunInProgress: false,
		pendingEvaluation: null,
	});
}

type ParsedGoalSessionEntry =
	| { readonly type: "ignored" }
	| { readonly type: "corrupt" }
	| { readonly type: "lifecycle"; readonly event: GoalLifecycleEventV1 }
	| { readonly type: "evaluation"; readonly entry: GoalEvaluationEntryV1 };

function parseGoalSessionEntry(value: unknown): ParsedGoalSessionEntry {
	if (!isPlainRecord(value) || typeof value.customType !== "string") return { type: "ignored" };
	if (value.customType !== GOAL_LIFECYCLE_ENTRY_TYPE && value.customType !== GOAL_EVALUATION_ENTRY_TYPE) {
		return { type: "ignored" };
	}
	if (value.type !== "custom") return { type: "corrupt" };
	if (value.customType === GOAL_LIFECYCLE_ENTRY_TYPE) {
		const event = parseGoalLifecycleEvent(value.data);
		return event === null ? { type: "corrupt" } : { type: "lifecycle", event };
	}
	const entry = parseGoalEvaluationEntry(value.data);
	return entry === null ? { type: "corrupt" } : { type: "evaluation", entry };
}

export function restoreGoalSessionState(entries: readonly unknown[], ownerSessionId: string): RestoredGoalSessionV1 {
	if (!isNonBlankString(ownerSessionId)) throw new TypeError("ownerSessionId must be a non-blank string.");
	let goal: RestoredGoalStateV1 | null = null;
	let foundCorruptEntry = false;
	const seenGoalIds = new Set<string>();

	for (const rawEntry of entries) {
		const parsed = parseGoalSessionEntry(rawEntry);
		if (parsed.type === "ignored") continue;
		if (parsed.type === "corrupt") {
			foundCorruptEntry = true;
			continue;
		}

		const data = parsed.type === "lifecycle" ? parsed.event : parsed.entry;
		if (data.ownerSessionId !== ownerSessionId) continue;

		if (parsed.type === "lifecycle" && parsed.event.kind === "created") {
			if (
				parsed.event.sequence !== 1 ||
				seenGoalIds.has(parsed.event.goalId) ||
				!canCreateGoalAfter(goal?.status ?? null)
			) {
				foundCorruptEntry = true;
				continue;
			}
			goal = stateFromCreated(parsed.event);
			seenGoalIds.add(parsed.event.goalId);
			continue;
		}

		if (goal === null || data.goalId !== goal.goalId) {
			foundCorruptEntry = true;
			continue;
		}

		const next: RestoredGoalStateV1 | null =
			parsed.type === "lifecycle" ? applyLifecycleEvent(goal, parsed.event) : applyEvaluationEntry(goal, parsed.entry);
		if (next === null) {
			foundCorruptEntry = true;
			continue;
		}
		goal = next;
	}

	return Object.freeze({ goal, foundCorruptEntry });
}
