/**
 * Stable, prefixed global identifiers for the `memory` extension.
 *
 * Every tool, command, entry/message custom type, status key, config field,
 * and error code carries the `memory`-family prefix so it can never collide
 * with another extension or Pi itself.
 */

export const EXTENSION_NAME = "memory";

/** User-visible command that reports read-only Store diagnostics. */
export const MEMORY_STATUS_COMMAND = "memory-status";

/**
 * Directory Memory Store locations are scoped inside the Working Directory's
 * Pi configuration area (`CONFIG_DIR_NAME` = `.pi` by current Pi definition).
 * The deployment config file itself lives in the Pi agent directory (see
 * `config.ts`); the Store and its scoped ignore marker live with the project.
 */
export const MEMORY_STORE_DIRECTORY_NAME = "memory";
export const MEMORY_STORE_FILE_NAME = "store.json";

export const MEMORY_CONFIG_VERSION = 1;
export const MEMORY_CONFIG_SCHEMA = "memory.config.v1";

export const MEMORY_STORE_VERSION = 1;
export const MEMORY_STORE_SCHEMA = "memory.store.v1";

/**
 * Only the primary foreground Agent may author memory records; future writer
 * semantics trace every record to exactly this author.
 */
export const MEMORY_PRIMARY_AGENT_AUTHOR = "primary-agent";

/** Stable error-code vocabulary used by the diagnostics slice. */
export const MEMORY_DIRECTORY_IDENTITY_FAILED = "MEMORY_DIRECTORY_IDENTITY_FAILED";
export const MEMORY_STORE_CORRUPT = "MEMORY_STORE_CORRUPT";
export const MEMORY_STORE_OVER_LIMIT = "MEMORY_STORE_OVER_LIMIT";
export const MEMORY_STORE_UNSUPPORTED_VERSION = "MEMORY_STORE_UNSUPPORTED_VERSION";
export const MEMORY_ABORTED = "MEMORY_ABORTED";
