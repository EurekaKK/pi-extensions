import { realpath } from "node:fs/promises";
import { MEMORY_DIRECTORY_IDENTITY_FAILED } from "./constants.js";
import { MemoryError } from "./errors.js";

/**
 * Canonical real-path resolution of the exact Working Directory.
 *
 * Symlink aliases of the same directory converge on one identity, while
 * parent, child, and sibling directories stay distinct. Missing or unreadable
 * directories surface a stable domain error instead of a guessed path.
 */
export async function resolveDirectoryIdentity(cwd: string): Promise<string> {
	try {
		return await realpath(cwd);
	} catch {
		throw new MemoryError(
			MEMORY_DIRECTORY_IDENTITY_FAILED,
			"cannot resolve the Working Directory to its canonical real path",
		);
	}
}
