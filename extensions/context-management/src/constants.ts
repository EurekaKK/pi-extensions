export const EXTENSION_NAME = "context-management";
export const STATUS_COMMAND = "context-management-status";
export const CONFIG_DIRECTORY_NAME = "context-management";
export const CONFIG_FILE_NAME = "config.json";
export const CONFIG_VERSION = 1;
export const COMPACTION_DETAILS_SCHEMA = "context_management.compaction.details.v1";

export const COMPACTOR_REQUEST_TIMEOUT_MS = 300_000;
export const COMPACTOR_TRANSPORT_MAX_RETRIES = 3;
export const COMPACTOR_TRANSPORT_RETRY_BASE_DELAY_MS = 2_000;
export const ESTIMATOR_SAMPLE_LIMIT = 8;

export const PRUNE_MARKER = "\n\n[... tool result middle pruned ...]\n\n";
export const SPILL_RETRIEVAL_HINT = "Use read with offset/limit, or grep this path to search within it.";

export const SUMMARY_OPEN_TAG = "<compacted-summary>";
export const SUMMARY_CLOSE_TAG = "</compacted-summary>";

export const CHECKPOINT_PREAMBLE =
	"This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.";

export const COMPACTION_INSTRUCTION = [
	"You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.",
	"",
	'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
	"",
	"## Primary Request and Intent",
	"- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
	"",
	"## Key Technical Concepts",
	"- [technologies, frameworks, patterns, and conventions in play]",
	"",
	"## Files and Code",
	"- [exact path: why it matters, key changes or snippets]",
	"",
	"## Errors and Fixes",
	"- [error: how it was resolved, plus any related user feedback]",
	"",
	"## Pending Jobs",
	"- [explicitly requested work not yet completed]",
	"",
	"## Current Work",
	"- [precisely what was in progress at this checkpoint]",
	"",
	"## Next Step",
	'- [the single next action, directly in line with the most recent request, or "(none)"]',
	"",
	"## Critical Context",
	"- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]",
	"",
	"Rules:",
	"- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.",
	"- Capture user feedback and explicit instructions faithfully, especially corrections.",
	"- Do NOT mention this summarization request or that the context was compacted.",
	"- Output only the checkpoint text: do not call any tool or take any other action.",
	`- If the conversation already contains a ${SUMMARY_OPEN_TAG} block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.`,
].join("\n");
