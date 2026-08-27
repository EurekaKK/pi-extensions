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

/** User command that reads one exact Memory Record (convenience over `memory_read`). */
export const MEMORY_READ_COMMAND = "memory-read";

/** LLM tool that adds one verified Memory Record from the primary foreground Agent. */
export const MEMORY_WRITE_TOOL = "memory_write";

/** LLM tool that reads one exact Memory Record by identity. */
export const MEMORY_READ_TOOL = "memory_read";

/**
 * Directory Memory Store locations are scoped inside the Working Directory's
 * Pi configuration area (`CONFIG_DIR_NAME` = `.pi` by current Pi definition).
 * The deployment config file itself lives in the Pi agent directory (see
 * `config.ts`); the Store and its scoped ignore marker live with the project.
 */
export const MEMORY_STORE_DIRECTORY_NAME = "memory";
export const MEMORY_STORE_FILE_NAME = "store.json";

/** Scoped ignore file inside the Memory Store directory so Git excludes Store content by default. */
export const MEMORY_STORE_IGNORE_FILE_NAME = ".gitignore";

/**
 * Scoped ignore marker content (one `*`). It ignores everything below the
 * Memory Store directory, keeping unreviewed Agent memory out of Git without
 * touching the repository root ignore file or local excludes.
 */
export const MEMORY_STORE_IGNORE_CONTENT = "*";

/**
 * Durable subagent marker authored by the `sub-agent` extension. Presence on
 * the session branch denies proactive memory writes (reads stay allowed).
 */
export const SUBAGENT_DESCRIPTOR_TYPE = "subagent:descriptor";

export const MEMORY_CONFIG_VERSION = 1;
export const MEMORY_CONFIG_SCHEMA = "memory.config.v1";

export const MEMORY_STORE_VERSION = 1;
export const MEMORY_STORE_SCHEMA = "memory.store.v1";

/**
 * Only the primary foreground Agent may author memory records; future writer
 * semantics trace every record to exactly this author.
 */
export const MEMORY_PRIMARY_AGENT_AUTHOR = "primary-agent";

/** Stable error-code vocabulary shared by the diagnostics, write, and read slices. */
export const MEMORY_DIRECTORY_IDENTITY_FAILED = "MEMORY_DIRECTORY_IDENTITY_FAILED";
export const MEMORY_STORE_CORRUPT = "MEMORY_STORE_CORRUPT";
export const MEMORY_STORE_OVER_LIMIT = "MEMORY_STORE_OVER_LIMIT";
export const MEMORY_STORE_UNSUPPORTED_VERSION = "MEMORY_STORE_UNSUPPORTED_VERSION";
export const MEMORY_ABORTED = "MEMORY_ABORTED";

/** Proactive writes were not authorized (no direct human turn, subagent context, or config). */
export const MEMORY_WRITE_DENIED = "MEMORY_WRITE_DENIED";

/** A Store commit failed; the prior Store remains authoritative. */
export const MEMORY_WRITE_FAILED = "MEMORY_WRITE_FAILED";

/** Add input violated capture policy (blank, control characters, secret-like, or over-limit). */
export const MEMORY_INPUT_REJECTED = "MEMORY_INPUT_REJECTED";

/** An exact record was not found by the read path. */
export const MEMORY_RECORD_NOT_FOUND = "MEMORY_RECORD_NOT_FOUND";

/** The Store directory could not be prepared for first-use initialization. */
export const MEMORY_STORE_INIT_FAILED = "MEMORY_STORE_INIT_FAILED";

/** The scoped ignore marker could not be created or inspected. */
export const MEMORY_IGNORE_MARKER_FAILED = "MEMORY_IGNORE_MARKER_FAILED";

/** An unreadable (but not corrupt) Store was encountered and the operation failed closed. */
export const MEMORY_STORE_UNAVAILABLE = "MEMORY_STORE_UNAVAILABLE";
