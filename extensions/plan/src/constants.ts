export const PLAN_CHANGE_ENTRY_TYPE = "plan:change" as const;
export const PLAN_CHANGE_VERSION = 1 as const;

export const PLAN_TOOL_SUBMIT_NAME = "plan_submit" as const;
export const PLAN_TOOL_READ_NAME = "plan_read" as const;
export const PLAN_COMMAND_NAME = "plan" as const;
export const PLAN_FLAG_NAME = "plan" as const;
export const PLAN_STATUS_KEY = "plan:status" as const;

export const PLAN_START_MESSAGE_TYPE = "plan:start" as const;
export const PLAN_PROPOSAL_CARD_MESSAGE_TYPE = "plan:proposal-card" as const;
export const PLAN_REVISE_REQUEST_MESSAGE_TYPE = "plan:revise-request" as const;
export const PLAN_KICKOFF_MESSAGE_TYPE = "plan:kickoff" as const;

export const PLAN_DEFAULT_ALLOWLIST: readonly string[] = Object.freeze([
	"read",
	"grep",
	"find",
	"ls",
	"tavily_search",
	"tavily_extract",
	"memory_search",
	"memory_read",
	PLAN_TOOL_SUBMIT_NAME,
	PLAN_TOOL_READ_NAME,
	"subagent_plan",
]);
