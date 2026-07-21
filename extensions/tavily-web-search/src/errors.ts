export type TavilyTool = "search" | "open";

export type TavilyErrorCode =
	| "tavily_extension_disabled"
	| "tavily_invalid_arguments"
	| "tavily_domain_policy_blocked"
	| "tavily_no_allowed_results"
	| "tavily_ref_not_found"
	| "tavily_cursor_invalid"
	| "tavily_cursor_expired"
	| "tavily_tool_budget_exhausted"
	| "tavily_credit_budget_exhausted"
	| "tavily_auth_failed"
	| "tavily_quota_exhausted"
	| "tavily_rejected"
	| "tavily_rate_limited"
	| "tavily_unavailable"
	| "tavily_request_timeout"
	| "tavily_network_failure"
	| "tavily_redirected"
	| "tavily_response_too_large"
	| "tavily_protocol_error"
	| "tavily_content_unavailable"
	| "tavily_request_aborted"
	| "tavily_internal_error";

export type ModelAction = "fix_call" | "search_again" | "choose_other_ref" | "reopen_ref" | "stop_turn" | "ask_user";

export class TavilyToolError extends Error {
	readonly code: TavilyErrorCode;
	readonly modelAction: ModelAction;
	readonly tool: TavilyTool;
	readonly httpStatus: number | undefined;
	readonly detailMessage: string;

	constructor(tool: TavilyTool, code: TavilyErrorCode, modelAction: ModelAction, message: string, httpStatus?: number) {
		const detailMessage = sanitizeErrorMessage(message);
		const statusLine = httpStatus === undefined ? "" : `\nhttp_status: ${httpStatus}`;
		super(`tavily_${tool}_error\ncode: ${code}\nmodel_action: ${modelAction}${statusLine}\nmessage: ${detailMessage}`);
		this.name = "TavilyToolError";
		this.tool = tool;
		this.code = code;
		this.modelAction = modelAction;
		this.httpStatus = httpStatus;
		this.detailMessage = detailMessage;
	}
}

function sanitizeErrorMessage(message: string): string {
	return message
		.replace(/[\r\n]+/gu, " ")
		.split("")
		.filter((character) => {
			const code = character.charCodeAt(0);
			return !(
				(code >= 0 && code <= 8) ||
				code === 11 ||
				code === 12 ||
				(code >= 14 && code <= 31) ||
				(code >= 127 && code <= 159)
			);
		})
		.join("")
		.trim()
		.slice(0, 1_024);
}

export function disabledError(tool: TavilyTool): TavilyToolError {
	return new TavilyToolError(
		tool,
		"tavily_extension_disabled",
		"ask_user",
		"The Tavily extension is disabled. Fix its startup error, then reload or restart Pi as instructed.",
	);
}

export function normalizeToolError(tool: TavilyTool, error: unknown): TavilyToolError {
	if (error instanceof TavilyToolError) {
		if (error.tool === tool) return error;
		return new TavilyToolError(tool, error.code, error.modelAction, error.detailMessage, error.httpStatus);
	}
	return new TavilyToolError(tool, "tavily_internal_error", "stop_turn", "The Tavily extension failed internally.");
}
