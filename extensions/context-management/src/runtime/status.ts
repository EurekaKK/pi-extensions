import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RuntimeState } from "./state.js";

function number(value: number): string {
	return new Intl.NumberFormat("en-US").format(value);
}

export function renderContextStatus(state: RuntimeState, context: ExtensionContext): string {
	const metrics = state.metrics;
	const model = context.model;
	const calibration = model === undefined ? 1 : state.calibration.get(model.provider, model.id);
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
		`  Threshold: ${number(metrics?.thresholdTokens ?? 0)}  Retain: ${number(metrics?.retainTokens ?? 0)}`,
		`  Projection: ${number(metrics?.finalEstimate ?? 0)}  Remaining to threshold: ${number(metrics?.remaining ?? 0)}  Calibration: ${calibration.toFixed(3)}`,
		`  Fixed: ${number(metrics?.fixedEstimate ?? 0)}  Checkpoint: ${number(metrics?.checkpointEstimate ?? 0)}  Tail: ${number(metrics?.tailEstimate ?? 0)}`,
		`  Tail range: ${metrics?.tailRange ?? "unknown"}`,
		`  Compactable: ${number(metrics?.compactableEstimate ?? 0)}  Over threshold: ${metrics?.overThreshold === true ? "yes" : "no"}`,
		`  Pruned tool results: ${number(metrics?.prunedToolResults ?? state.prunedToolCallIds.size)}`,
		`  Checkpoint: ${checkpoint}`,
		`  Background: ${state.candidateLifecycle.phase}${state.candidateLifecycle.detail === null ? "" : ` (${state.candidateLifecycle.detail})`}`,
		`  Blocking: ${state.blockingState ?? "none"}`,
	];
	return lines.join("\n");
}
