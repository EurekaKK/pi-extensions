import type { InstalledCheckpoint } from "../compaction/details.js";
import type { CheckpointCandidate } from "../compaction/lifecycle.js";
import { EstimatorCalibration } from "./budget.js";

export interface RuntimeMetrics {
	model: string;
	contextWindow: number;
	thresholdTokens: number;
	retainTokens: number;
	finalEstimate: number;
	remaining: number;
	fixedEstimate: number;
	checkpointEstimate: number;
	tailEstimate: number;
	tailRange: string;
	compactableEstimate: number;
	prunedToolResults: number;
	overThreshold: boolean;
}

export interface RuntimeState {
	runtimeGeneration: number;
	branchEpoch: number;
	runGeneration: number;
	currentRunParentEntryId: string | null;
	currentRunEntryId: string | null;
	installedCheckpoint: InstalledCheckpoint | undefined;
	pendingCheckpoint: CheckpointCandidate | undefined;
	prunedToolCallIds: Set<string>;
	calibration: EstimatorCalibration;
	blockingState: string | null;
	lastRawEstimate: number | null;
	lastRequestModel: { readonly provider: string; readonly id: string } | null;
	lastSafeProjection: import("@earendil-works/pi-coding-agent").ContextEvent["messages"];
	metrics: RuntimeMetrics | null;
	shutdownController: AbortController;
}

let nextRuntimeGeneration = 1;

export function createRuntimeState(): RuntimeState {
	return {
		runtimeGeneration: nextRuntimeGeneration++,
		branchEpoch: 0,
		runGeneration: 0,
		currentRunParentEntryId: null,
		currentRunEntryId: null,
		installedCheckpoint: undefined,
		pendingCheckpoint: undefined,
		prunedToolCallIds: new Set(),
		calibration: new EstimatorCalibration(),
		blockingState: null,
		lastRawEstimate: null,
		lastRequestModel: null,
		lastSafeProjection: [],
		metrics: null,
		shutdownController: new AbortController(),
	};
}
