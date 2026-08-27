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

/** LLM tool that searches the active Memory Records with bounded lexical ranking. */
export const MEMORY_SEARCH_TOOL = "memory_search";

/** User command that searches active Memory Records (convenience over `memory_search`). */
export const MEMORY_SEARCH_COMMAND = "memory-search";

/** User command that lists the active Memory Records (read-only, bounded). */
export const MEMORY_LIST_COMMAND = "memory-list";

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

/**
 * Stable custom-message type for automatic Memory Recall injected before a
 * direct human Agent run. The `memory:` prefix keeps it collision-free; the
 * structured `details` carry the v1 Recall Receipt so context deduplication
 * and rendering never parse display text. The primary `MemoryWriteAuthority`
 * whitelists this exact type so a recall in a direct human run does not revoke
 * legitimate foreground write authority, while other extensions' custom
 * follow-up messages still do.
 */
export const MEMORY_RECALL_CUSTOM_TYPE = "memory:recall-receipt";

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

/** Search/list input violated capture policy (blank, control characters, over-limit, invalid limit). */
export const MEMORY_SEARCH_INPUT_REJECTED = "MEMORY_SEARCH_INPUT_REJECTED";

/** A supersede target record identity was not found. */
export const MEMORY_TARGET_NOT_FOUND = "MEMORY_TARGET_NOT_FOUND";

/** A supersede target id exists but the requested revision is not its current revision. */
export const MEMORY_TARGET_STALE = "MEMORY_TARGET_STALE";

/** A supersede target is no longer active (already superseded). */
export const MEMORY_TARGET_INACTIVE = "MEMORY_TARGET_INACTIVE";

/** A supersede replacement's derived identity already exists under a different record. */
export const MEMORY_IDENTITY_COLLISION = "MEMORY_IDENTITY_COLLISION";

/** The Store directory could not be prepared for first-use initialization. */
export const MEMORY_STORE_INIT_FAILED = "MEMORY_STORE_INIT_FAILED";

/** The scoped ignore marker could not be created or inspected. */
export const MEMORY_IGNORE_MARKER_FAILED = "MEMORY_IGNORE_MARKER_FAILED";

/** An unreadable (but not corrupt) Store was encountered and the operation failed closed. */
export const MEMORY_STORE_UNAVAILABLE = "MEMORY_STORE_UNAVAILABLE";
