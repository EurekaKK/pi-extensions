export const GOAL_LIFECYCLE_ENTRY_TYPE = "goal.lifecycle.v1";
export const GOAL_EVALUATION_ENTRY_TYPE = "goal.evaluation.v1";
export const GOAL_EVALUATION_MESSAGE_TYPE = "goal.evaluation.message.v1";
export const GOAL_CONTROL_MESSAGE_TYPE = "goal.control.v1";
export const GOAL_ERROR_MESSAGE_TYPE = "goal.error.v1";
export const GOAL_STATUS_KEY = "goal.status";

export const GOAL_SNAPSHOT_READ_TOOL = "goal_snapshot_read";
export const GOAL_SNAPSHOT_SEARCH_TOOL = "goal_snapshot_search";
export const GOAL_SNAPSHOT_IMAGE_TOOL = "goal_snapshot_image";
export const GOAL_SUBMIT_EVALUATION_TOOL = "goal_submit_evaluation";

export const GOAL_COMMAND_USAGE = `Invalid /goal command.

Usage:
  /goal
  /goal resume
  /goal cancel`;

export const GOAL_SCHEMA_VERSION = 1 as const;
