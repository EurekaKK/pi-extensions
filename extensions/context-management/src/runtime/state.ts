import type { ContextEvent } from "@earendil-works/pi-coding-agent";
import type { InstalledCheckpoint } from "../compaction/details.js";
import type { CheckpointCandidate } from "../compaction/lifecycle.js";
import type { EvidenceReduction } from "../evidence/reducers.js";
import { EvidenceState } from "../evidence/state.js";
import type { MemoryPack } from "../memory/retrieval.js";
import { MemoryService } from "../memory/service.js";
import { EstimatorCalibration } from "./budget.js";

type AgentMessage = ContextEvent["messages"][number];

export type PreparationState =
	| {
			readonly kind: "idle";
			readonly lastFailure?: { readonly code: string; readonly at: string };
	  }
	| {
			readonly kind: "preparing";
			readonly controller: AbortController;
			readonly promise: Promise<CheckpointCandidate | null>;
			readonly startedSourceTokens: number;
	  }
	| { readonly kind: "ready"; readonly candidate: CheckpointCandidate }
	| { readonly kind: "installing"; readonly candidate: CheckpointCandidate };

export interface ReductionStats {
	duplicateCount: number;
	supersessionCount: number;
	estimatedSavings: number;
}

export interface RuntimeMetrics {
	model: string;
	contextWindow: number;
	safeInput: number;
	finalEstimate: number;
	remaining: number;
	fixedEstimate: number;
	checkpointEstimate: number;
	tailEstimate: number;
	tailTarget: number;
	tailRange: string;
	memoryEstimate: number;
	evidenceEstimate: number;
	currentRunEstimate: number;
	compactableEstimate: number;
	prepareThreshold: number;
	blockingThreshold: number;
}

export interface RuntimeState {
	runtimeGeneration: number;
	branchEpoch: number;
	runGeneration: number;
	projectionEpoch: number;
	currentRunParentEntryId: string | null;
	currentRunEntryId: string | null;
	runTimestamp: number;
	installedCheckpoint: InstalledCheckpoint | undefined;
	pendingCheckpoint: CheckpointCandidate | undefined;
	preparation: PreparationState;
	memoryPack: MemoryPack | null;
	previousMemoryPackIds: ReadonlySet<string>;
	memoryPackSuppressed: boolean;
	evidence: EvidenceState;
	memory: MemoryService;
	calibration: EstimatorCalibration;
	activeReductions: readonly EvidenceReduction[];
	pendingSupersessions: readonly EvidenceReduction[];
	reductionStats: ReductionStats;
	blockingState: string | null;
	lastRawEstimate: number | null;
	lastRequestModel: { readonly provider: string; readonly id: string } | null;
	lastSafeProjection: AgentMessage[];
	metrics: RuntimeMetrics | null;
	shutdownController: AbortController;
}

let nextRuntimeGeneration = 1;

export function createRuntimeState(): RuntimeState {
	const shutdownController = new AbortController();
	return {
		runtimeGeneration: nextRuntimeGeneration++,
		branchEpoch: 0,
		runGeneration: 0,
		projectionEpoch: 0,
		currentRunParentEntryId: null,
		currentRunEntryId: null,
		runTimestamp: Date.now(),
		installedCheckpoint: undefined,
		pendingCheckpoint: undefined,
		preparation: Object.freeze({ kind: "idle" }),
		memoryPack: null,
		previousMemoryPackIds: new Set(),
		memoryPackSuppressed: false,
		evidence: new EvidenceState(),
		memory: new MemoryService(shutdownController.signal),
		calibration: new EstimatorCalibration(),
		activeReductions: Object.freeze([]),
		pendingSupersessions: Object.freeze([]),
		reductionStats: { duplicateCount: 0, supersessionCount: 0, estimatedSavings: 0 },
		blockingState: null,
		lastRawEstimate: null,
		lastRequestModel: null,
		lastSafeProjection: [],
		metrics: null,
		shutdownController,
	};
}
