export type ContextManagementErrorCode =
	| "context_management.context_estimate_failure"
	| "context_management.compaction_infeasible"
	| "context_management.compaction_busy"
	| "context_management.compactor_auth_failure"
	| "context_management.compactor_transport_failure"
	| "context_management.checkpoint_validation_failure"
	| "context_management.checkpoint_persistence_failure"
	| "context_management.operation_aborted";

export class ContextManagementError extends Error {
	readonly code: ContextManagementErrorCode;
	readonly details: Readonly<Record<string, unknown>>;

	constructor(code: ContextManagementErrorCode, message: string, details: Readonly<Record<string, unknown>> = {}) {
		super(message);
		this.name = "ContextManagementError";
		this.code = code;
		this.details = details;
	}
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw new ContextManagementError("context_management.operation_aborted", "Context management operation aborted.");
	}
}
