import type { ExtractDepth, SearchDepth } from "./config.js";
import { EXTRACT_ENDPOINT, SEARCH_ENDPOINT } from "./constants.js";
import type { ExtractPage, SearchHit } from "./envelope.js";
import { errorForStatus, TavilyRequestError } from "./errors.js";

export interface SearchRequest {
	readonly query: string;
	readonly searchDepth: SearchDepth;
	readonly maxResults: number;
	readonly includeDomains?: readonly string[];
	readonly excludeDomains?: readonly string[];
	readonly timeRange?: "day" | "week" | "month" | "year";
}

export interface ExtractRequest {
	readonly urls: readonly string[];
	readonly extractDepth: ExtractDepth;
	readonly query?: string;
}

export interface ExtractSuccess {
	readonly pages: readonly ExtractPage[];
	readonly failedUrls: readonly string[];
}

export interface TavilyClientOptions {
	readonly apiKey: string;
	readonly fetch: typeof globalThis.fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseHits(body: unknown): SearchHit[] {
	if (!isRecord(body) || !Array.isArray(body.results)) return [];
	const hits: SearchHit[] = [];
	for (const item of body.results) {
		if (!isRecord(item)) continue;
		if (typeof item.title !== "string" || typeof item.url !== "string" || typeof item.content !== "string") continue;
		const score = typeof item.score === "number" && Number.isFinite(item.score) ? item.score : undefined;
		hits.push(
			score === undefined
				? { title: item.title, url: item.url, snippet: item.content }
				: { title: item.title, url: item.url, snippet: item.content, score },
		);
	}
	return hits;
}

function parseExtract(body: unknown): ExtractSuccess {
	const pages: ExtractPage[] = [];
	const failedUrls: string[] = [];
	if (isRecord(body) && Array.isArray(body.results)) {
		for (const item of body.results) {
			if (!isRecord(item) || typeof item.url !== "string") continue;
			const content = typeof item.raw_content === "string" ? item.raw_content : "";
			pages.push({ url: item.url, content });
		}
	}
	if (isRecord(body) && Array.isArray(body.failed_results)) {
		for (const item of body.failed_results) {
			if (isRecord(item) && typeof item.url === "string") failedUrls.push(item.url);
			else if (typeof item === "string") failedUrls.push(item);
		}
	}
	return { pages, failedUrls };
}

function classifyAbort(userSignal: AbortSignal | undefined): never {
	if (userSignal?.aborted) throw new TavilyRequestError("cancelled", "Tavily request cancelled");
	throw new TavilyRequestError("timeout", "Tavily request timed out");
}

async function readJson(response: Response): Promise<unknown> {
	const text = await response.text();
	if (text.length === 0) return undefined;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return undefined;
	}
}

export class TavilyClient {
	readonly #apiKey: string;
	readonly #fetch: typeof globalThis.fetch;

	constructor(options: TavilyClientOptions) {
		this.#apiKey = options.apiKey;
		this.#fetch = options.fetch;
	}

	async search(request: SearchRequest, timeoutMs: number, signal: AbortSignal | undefined): Promise<SearchHit[]> {
		const payload: Record<string, unknown> = {
			query: request.query,
			search_depth: request.searchDepth,
			max_results: request.maxResults,
		};
		if (request.includeDomains !== undefined && request.includeDomains.length > 0) {
			payload.include_domains = request.includeDomains;
		}
		if (request.excludeDomains !== undefined && request.excludeDomains.length > 0) {
			payload.exclude_domains = request.excludeDomains;
		}
		if (request.timeRange !== undefined) payload.time_range = request.timeRange;
		const body = await this.#post(SEARCH_ENDPOINT, payload, timeoutMs, signal);
		return parseHits(body);
	}

	async extract(request: ExtractRequest, timeoutMs: number, signal: AbortSignal | undefined): Promise<ExtractSuccess> {
		const payload: Record<string, unknown> = {
			urls: request.urls,
			extract_depth: request.extractDepth,
		};
		if (request.query !== undefined && request.query.length > 0) payload.query = request.query;
		const body = await this.#post(EXTRACT_ENDPOINT, payload, timeoutMs, signal);
		return parseExtract(body);
	}

	async #post(
		url: string,
		payload: Record<string, unknown>,
		timeoutMs: number,
		userSignal: AbortSignal | undefined,
	): Promise<unknown> {
		const timeoutSignal = AbortSignal.timeout(timeoutMs);
		const combined = userSignal === undefined ? timeoutSignal : AbortSignal.any([userSignal, timeoutSignal]);
		let response: Response;
		try {
			response = await this.#fetch(url, {
				method: "POST",
				headers: {
					authorization: `Bearer ${this.#apiKey}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(payload),
				signal: combined,
			});
		} catch (error) {
			if (combined.aborted) classifyAbort(userSignal);
			const message = error instanceof Error ? error.message : String(error);
			throw new TavilyRequestError("request", `Tavily request failed (${message})`);
		}
		if (!response.ok) throw errorForStatus(response.status);
		return readJson(response);
	}
}
