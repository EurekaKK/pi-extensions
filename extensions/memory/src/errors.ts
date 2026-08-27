/**
 * Domain error for the `memory` extension. Every failure carries a stable,
 * prefixed code from `constants.ts` and a human-readable message.
 */
export class MemoryError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "MemoryError";
		this.code = code;
	}
}

/** Narrow unknown values into filesystem errors carrying a `code`. */
export function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
