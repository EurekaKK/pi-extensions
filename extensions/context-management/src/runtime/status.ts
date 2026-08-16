import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MEMORY_STORE_BYTE_LIMIT } from "../constants.js";
import type { RuntimeState } from "./state.js";

function number(value: number): string {
	return new Intl.NumberFormat("en-US").format(value);
}

export function renderContextStatus(state: RuntimeState, context: ExtensionContext): string {
	const metrics = state.metrics;
	const model = context.model;
	const calibration = model === undefined ? 1 : state.calibration.get(model.provider, model.id);
	const memoryStore = state.memory.store;
	const memorySnapshot = memoryStore?.snapshot;
	const records = memorySnapshot?.envelope?.records.length ?? 0;
	const memoryItems = state.memoryPack?.items ?? [];
	const fullCount = memoryItems.filter((item) => item.representation === "full").length;
	const stubCount = memoryItems.length - fullCount;
	const evidence = state.evidence.admitted;
	const preparation =
		state.preparation.kind === "preparing"
			? `preparing C=${number(state.preparation.startedSourceTokens)}`
			: state.preparation.kind === "ready"
				? "ready"
				: state.preparation.kind === "installing"
					? "installing"
					: state.preparation.lastFailure === undefined
						? "idle"
						: `idle; last failure=${state.preparation.lastFailure.code} at ${state.preparation.lastFailure.at}`;
	const checkpoint =
		state.pendingCheckpoint !== undefined
			? `pending commit; through ${state.pendingCheckpoint.details.coveredThroughEntryId}`
			: state.installedCheckpoint === undefined
				? "none"
				: `${state.installedCheckpoint.kind}; through ${state.installedCheckpoint.details?.coveredThroughEntryId ?? "legacy boundary"}`;

	const lines = [
		"Context management",
		`  Model: ${metrics?.model ?? (model === undefined ? "none" : `${model.provider}/${model.id}`)}`,
		`  Window: ${number(metrics?.contextWindow ?? model?.contextWindow ?? 0)}`,
		`  Safe input: ${number(metrics?.safeInput ?? 0)}  Headroom: 20,000`,
		`  Projection: ${number(metrics?.finalEstimate ?? 0)}  Remaining: ${number(metrics?.remaining ?? 0)}  Calibration: ${calibration.toFixed(3)}`,
		`  Fixed: ${number(metrics?.fixedEstimate ?? 0)}  Checkpoint: ${number(metrics?.checkpointEstimate ?? 0)}  Tail: ${number(metrics?.tailEstimate ?? 0)} / target ${number(metrics?.tailTarget ?? 0)}`,
		`  Tail range: ${metrics?.tailRange ?? "unknown"}  Current run: ${number(metrics?.currentRunEstimate ?? 0)}`,
		`  Memory Pack: ${number(metrics?.memoryEstimate ?? 0)} tokens; ${fullCount} full, ${stubCount} stubs; suppressed=${state.memoryPackSuppressed ? "yes" : "no"}`,
		`  Evidence Pack: ${number(metrics?.evidenceEstimate ?? 0)} tokens; ${evidence.length} admitted, ${state.evidence.pending.length} pending`,
		`  Projection epoch: ${state.projectionEpoch}`,
		`  Reductions: ${state.reductionStats.duplicateCount} duplicate, ${state.reductionStats.supersessionCount} superseded, ~${number(state.reductionStats.estimatedSavings)} tokens saved`,
		`  Checkpoint: ${checkpoint}`,
		`  Preparation: ${preparation}`,
		`  Thresholds: prepare ${number(metrics?.prepareThreshold ?? 0)}, blocking ${number(metrics?.blockingThreshold ?? 0)}, C=${number(metrics?.compactableEstimate ?? 0)}`,
		`  Blocking: ${state.blockingState ?? "none"}`,
		`  Repository: ${state.memory.identity?.identityKind ?? "unresolved"}`,
		`  Memory: ${memorySnapshot?.available === false ? "unavailable" : `${records} records, ${number(memorySnapshot?.serializedBytes ?? 0)} / ${number(MEMORY_STORE_BYTE_LIMIT)} bytes`}`,
		`  Memory path: ${memoryStore?.paths.memoryFile ?? "unresolved"}`,
	];
	if (memorySnapshot?.available === false)
		lines.push(`  Memory error: ${memorySnapshot.unavailableReason ?? "unknown"}`);
	return lines.join("\n");
}
