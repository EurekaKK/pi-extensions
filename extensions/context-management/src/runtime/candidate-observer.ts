export const CANDIDATE_OBSERVER_SYMBOL = Symbol.for("pi.context-management.candidate-lifecycle.v1");

export type CandidateObserverPhase = "started" | "ready" | "installed" | "discarded" | "failed";

export interface CandidateObserverEvent {
	readonly schema: "context-management.candidate-lifecycle.v1";
	readonly phase: CandidateObserverPhase;
	readonly detail: string | null;
}

export function emitCandidateLifecycle(event: Omit<CandidateObserverEvent, "schema">): void {
	const observer = Reflect.get(globalThis, CANDIDATE_OBSERVER_SYMBOL);
	if (typeof observer !== "function") return;
	try {
		observer(
			Object.freeze({
				schema: "context-management.candidate-lifecycle.v1",
				phase: event.phase,
				detail: event.detail,
			}),
		);
	} catch {
		// Optional diagnostics must never affect context safety.
	}
}
