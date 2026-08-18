export type TavilyErrorKind = "auth" | "quota" | "rate_limited" | "timeout" | "cancelled" | "request";

export class TavilyRequestError extends Error {
	readonly kind: TavilyErrorKind;

	constructor(kind: TavilyErrorKind, message: string) {
		super(message);
		this.name = "TavilyRequestError";
		this.kind = kind;
	}
}

export function errorForStatus(status: number): TavilyRequestError {
	if (status === 401) return new TavilyRequestError("auth", "Tavily authentication failed");
	if (status === 432 || status === 433) return new TavilyRequestError("quota", "Tavily quota exceeded");
	if (status === 429) return new TavilyRequestError("rate_limited", "Tavily rate limited");
	return new TavilyRequestError("request", `Tavily request failed (${status})`);
}
