import {
	ADVANCED_EXTRACT_ATTEMPT_TIMEOUT_MS,
	BASIC_EXTRACT_ATTEMPT_TIMEOUT_MS,
	EXTRACT_ENDPOINT,
	MAX_RESPONSE_BYTES,
	MAX_RETRY_AFTER_MS,
	SEARCH_ATTEMPT_TIMEOUT_MS,
	SEARCH_ENDPOINT,
} from "./constants.js";
import { type TavilyTool, TavilyToolError } from "./errors.js";
import type { RetrievalDepth, SearchRecency } from "./types.js";

const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

export interface NetworkPermit {
	release(): void;
}

export interface NetworkGate {
	acquire(signal: AbortSignal | undefined, deadlineAt: number): Promise<NetworkPermit>;
}

export interface CreditReservation {
	readonly attemptId: string;
	readonly reservedCredits: number;
}

export interface CreditSettlement {
	readonly credits: number;
	readonly estimated: boolean;
	readonly contractOverrun: boolean;
	readonly persisted: boolean;
}

export interface TavilyAttemptBudget {
	reserve(operationId: string, operation: TavilyTool, depth: RetrievalDepth): Promise<CreditReservation>;
	settle(attemptId: string, actualCredits: number | undefined): Promise<CreditSettlement>;
}

export interface TavilyRequestContext {
	readonly operationId: string;
	readonly apiKey: string;
	readonly depth: RetrievalDepth;
	readonly signal: AbortSignal | undefined;
	readonly deadlineAt: number;
	readonly gate: NetworkGate;
	readonly budget: TavilyAttemptBudget;
	readonly finalAdmissionCheck?: () => void;
	readonly onCreditContractOverrun?: () => void;
}

export interface TavilyClientDependencies {
	readonly fetch: typeof globalThis.fetch;
	readonly now: () => number;
	readonly retryEnabled: boolean;
}

export interface TavilyResponse {
	readonly body: unknown;
	readonly networkAdmissionAt: number;
	readonly retrievedAt: string;
	readonly durationMs: number;
	readonly credits: number;
	readonly usageEstimated: boolean;
	readonly creditContractOverrun: boolean;
}

export interface SearchRequest {
	readonly query: string;
	readonly searchDepth: RetrievalDepth;
	readonly maxResults: number;
	readonly includeDomains: readonly string[];
	readonly excludeDomains: readonly string[];
	readonly recency?: SearchRecency;
}

export interface ExtractRequest {
	readonly url: string;
	readonly extractDepth: RetrievalDepth;
	readonly mode: "focused" | "full";
	readonly focus?: string;
}

export class TavilyClient {
	readonly #fetch: typeof globalThis.fetch;
	readonly #now: () => number;
	readonly #retryEnabled: boolean;

	constructor(dependencies: TavilyClientDependencies) {
		this.#fetch = dependencies.fetch;
		this.#now = dependencies.now;
		this.#retryEnabled = dependencies.retryEnabled;
	}

	async search(request: SearchRequest, context: TavilyRequestContext): Promise<TavilyResponse> {
		return this.#request("search", SEARCH_ENDPOINT, buildSearchPayload(request), SEARCH_ATTEMPT_TIMEOUT_MS, context);
	}

	async extract(request: ExtractRequest, context: TavilyRequestContext): Promise<TavilyResponse> {
		const attemptTimeout =
			request.extractDepth === "advanced" ? ADVANCED_EXTRACT_ATTEMPT_TIMEOUT_MS : BASIC_EXTRACT_ATTEMPT_TIMEOUT_MS;
		return this.#request("open", EXTRACT_ENDPOINT, buildExtractPayload(request), attemptTimeout, context);
	}

	async #request(
		tool: TavilyTool,
		endpoint: string,
		payload: Readonly<Record<string, unknown>>,
		attemptTimeoutMs: number,
		context: TavilyRequestContext,
	): Promise<TavilyResponse> {
		const startedAt = this.#now();
		let totalCredits = 0;
		let anyEstimated = false;
		let anyOverrun = false;

		for (let attemptIndex = 0; attemptIndex < 2; attemptIndex += 1) {
			assertNotAborted(tool, context.signal);
			const remainingBeforeQueue = context.deadlineAt - this.#now();
			if (remainingBeforeQueue <= 0) throw timeoutError(tool);
			const permit = await context.gate.acquire(context.signal, context.deadlineAt);
			let permitReleased = false;
			const releasePermit = () => {
				if (permitReleased) return;
				permitReleased = true;
				permit.release();
			};
			let reservation: CreditReservation | undefined;
			try {
				assertNotAborted(tool, context.signal);
				if (context.deadlineAt - this.#now() <= 0) throw timeoutError(tool);
				context.finalAdmissionCheck?.();
				reservation = await context.budget.reserve(context.operationId, tool, context.depth);
				try {
					assertNotAborted(tool, context.signal);
					if (context.deadlineAt - this.#now() <= 0) throw timeoutError(tool);
					context.finalAdmissionCheck?.();
				} catch (error) {
					// The durable reservation was created, but no request was sent. A zero
					// settlement releases it without undercounting supplier usage.
					await context.budget.settle(reservation.attemptId, 0);
					throw error;
				}
				const networkAdmissionAt = this.#now();
				const response = await this.#attempt(
					tool,
					endpoint,
					payload,
					context.apiKey,
					context.signal,
					Math.min(attemptTimeoutMs, Math.max(1, context.deadlineAt - networkAdmissionAt)),
				);

				if (response.kind === "success") {
					const reportedCredits = readUsageCredits(response.body);
					const overrunAlreadyReported = reportObservedCreditOverrun(context, reservation, reportedCredits);
					const settlement = await context.budget.settle(reservation.attemptId, reportedCredits);
					if (settlement.contractOverrun && !overrunAlreadyReported) context.onCreditContractOverrun?.();
					totalCredits += settlement.credits;
					anyEstimated ||= settlement.estimated;
					anyOverrun ||= settlement.contractOverrun;
					return {
						body: response.body,
						networkAdmissionAt,
						retrievedAt: new Date(this.#now()).toISOString(),
						durationMs: Math.max(0, this.#now() - startedAt),
						credits: totalCredits,
						usageEstimated: anyEstimated,
						creditContractOverrun: anyOverrun,
					};
				}

				if (response.bodyParsed) {
					const reportedCredits = readUsageCredits(response.body);
					const overrunAlreadyReported = reportObservedCreditOverrun(context, reservation, reportedCredits);
					const settlement = await context.budget.settle(reservation.attemptId, reportedCredits);
					if (settlement.contractOverrun && !overrunAlreadyReported) context.onCreditContractOverrun?.();
					totalCredits += settlement.credits;
					anyEstimated ||= settlement.estimated;
					anyOverrun ||= settlement.contractOverrun;
				} else {
					// A malformed error response cannot provide trustworthy usage. Keep the
					// durable reservation outstanding and report its worst-case cost when a
					// later retry succeeds.
					totalCredits += reservation.reservedCredits;
					anyEstimated = true;
				}

				const retryable = this.#retryEnabled && attemptIndex === 0 && RETRYABLE_STATUSES.has(response.status);
				if (retryable) {
					const delay = parseRetryAfter(response.retryAfter, this.#now());
					const remaining = context.deadlineAt - this.#now();
					if (remaining >= attemptTimeoutMs + delay) {
						releasePermit();
						await abortableDelay(delay, context.signal, context.deadlineAt, this.#now, tool);
						continue;
					}
				}
				throw mapHttpError(tool, response.status);
			} finally {
				releasePermit();
			}
		}

		throw new TavilyToolError(tool, "tavily_unavailable", "stop_turn", "Tavily remained unavailable after retry.");
	}

	async #attempt(
		tool: TavilyTool,
		endpoint: string,
		payload: Readonly<Record<string, unknown>>,
		apiKey: string,
		callerSignal: AbortSignal | undefined,
		attemptTimeoutMs: number,
	): Promise<AttemptResult> {
		const timeoutController = new AbortController();
		const timeout = setTimeout(() => timeoutController.abort("attempt_timeout"), attemptTimeoutMs);
		const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutController.signal]) : timeoutController.signal;
		try {
			let response: Response;
			try {
				response = await this.#fetch(endpoint, {
					method: "POST",
					redirect: "manual",
					headers: {
						Authorization: `Bearer ${apiKey}`,
						"Content-Type": "application/json",
						Accept: "application/json",
					},
					body: JSON.stringify(payload),
					signal,
				});
			} catch {
				if (callerSignal?.aborted) {
					throw new TavilyToolError(tool, "tavily_request_aborted", "stop_turn", "The Tavily request was cancelled.");
				}
				if (timeoutController.signal.aborted) throw timeoutError(tool);
				throw new TavilyToolError(
					tool,
					"tavily_network_failure",
					"stop_turn",
					"The Tavily request failed before a response was received.",
				);
			}

			if (response.status >= 300 && response.status < 400) {
				await cancelBody(response);
				throw new TavilyToolError(
					tool,
					"tavily_redirected",
					"stop_turn",
					"The fixed Tavily API endpoint returned a redirect, which was refused.",
					response.status,
				);
			}

			try {
				if (response.ok) return { kind: "success", body: await readJsonBody(tool, response) };
				let body: unknown;
				let bodyParsed = true;
				try {
					body = await readJsonBody(tool, response);
				} catch (error) {
					if (!(error instanceof TavilyToolError) || error.code !== "tavily_protocol_error") throw error;
					body = undefined;
					bodyParsed = false;
				}
				return {
					kind: "http_error",
					status: response.status,
					body,
					bodyParsed,
					retryAfter: response.headers.get("retry-after"),
				};
			} catch (error) {
				if (callerSignal?.aborted) {
					throw new TavilyToolError(tool, "tavily_request_aborted", "stop_turn", "The Tavily request was cancelled.");
				}
				if (timeoutController.signal.aborted) throw timeoutError(tool);
				throw error;
			}
		} finally {
			clearTimeout(timeout);
		}
	}
}

export function buildSearchPayload(request: SearchRequest): Readonly<Record<string, unknown>> {
	return Object.freeze({
		query: request.query,
		search_depth: request.searchDepth,
		max_results: request.maxResults,
		topic: "general",
		...(request.includeDomains.length === 0 ? {} : { include_domains: [...request.includeDomains] }),
		...(request.excludeDomains.length === 0 ? {} : { exclude_domains: [...request.excludeDomains] }),
		...(request.recency === undefined ? {} : { time_range: request.recency }),
		include_answer: false,
		include_raw_content: false,
		include_images: false,
		include_image_descriptions: false,
		include_favicon: false,
		auto_parameters: false,
		exact_match: false,
		include_usage: true,
		...(request.searchDepth === "advanced" ? { chunks_per_source: 3 } : {}),
	});
}

export function buildExtractPayload(request: ExtractRequest): Readonly<Record<string, unknown>> {
	return Object.freeze({
		urls: request.url,
		extract_depth: request.extractDepth,
		...(request.mode === "focused" ? { query: request.focus, chunks_per_source: 5 } : {}),
		format: "markdown",
		include_images: false,
		include_favicon: false,
		include_usage: true,
		timeout: request.extractDepth === "advanced" ? 30 : 10,
	});
}

export function readUsageCredits(body: unknown): number | undefined {
	if (!isRecord(body) || !isRecord(body.usage)) return undefined;
	const credits = body.usage.credits;
	return typeof credits === "number" && Number.isSafeInteger(credits) && credits >= 0 ? credits : undefined;
}

function reportObservedCreditOverrun(
	context: TavilyRequestContext,
	reservation: CreditReservation,
	reportedCredits: number | undefined,
): boolean {
	if (reportedCredits === undefined || reportedCredits <= reservation.reservedCredits) return false;
	context.onCreditContractOverrun?.();
	return true;
}

type AttemptResult =
	| { readonly kind: "success"; readonly body: unknown }
	| {
			readonly kind: "http_error";
			readonly status: number;
			readonly body: unknown;
			readonly bodyParsed: boolean;
			readonly retryAfter: string | null;
	  };

async function readJsonBody(tool: TavilyTool, response: Response): Promise<unknown> {
	const contentLength = response.headers.get("content-length");
	if (contentLength !== null) {
		const parsedLength = Number(contentLength);
		if (Number.isFinite(parsedLength) && parsedLength > MAX_RESPONSE_BYTES) {
			await cancelBody(response);
			throw new TavilyToolError(
				tool,
				"tavily_response_too_large",
				"stop_turn",
				"The Tavily response exceeded the extension response limit.",
			);
		}
	}

	const reader = response.body?.getReader();
	if (!reader) {
		throw new TavilyToolError(tool, "tavily_protocol_error", "stop_turn", "Tavily returned an empty response body.");
	}
	const chunks: Uint8Array[] = [];
	let totalBytes = 0;
	try {
		while (true) {
			const item = await reader.read();
			if (item.done) break;
			totalBytes += item.value.byteLength;
			if (totalBytes > MAX_RESPONSE_BYTES) {
				await reader.cancel();
				throw new TavilyToolError(
					tool,
					"tavily_response_too_large",
					"stop_turn",
					"The Tavily response exceeded the extension response limit.",
				);
			}
			chunks.push(item.value);
		}
	} catch (error) {
		if (error instanceof TavilyToolError) throw error;
		throw new TavilyToolError(tool, "tavily_network_failure", "stop_turn", "The Tavily response stream failed.");
	}

	const bytes = new Uint8Array(totalBytes);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new TavilyToolError(tool, "tavily_protocol_error", "stop_turn", "Tavily returned invalid UTF-8 JSON.");
	}
	try {
		return JSON.parse(text) as unknown;
	} catch {
		throw new TavilyToolError(tool, "tavily_protocol_error", "stop_turn", "Tavily returned malformed JSON.");
	}
}

function mapHttpError(tool: TavilyTool, status: number): TavilyToolError {
	if (status === 401) {
		return new TavilyToolError(
			tool,
			"tavily_auth_failed",
			"ask_user",
			"Tavily rejected the configured credential. Restart Pi after fixing TAVILY_API_KEY.",
			status,
		);
	}
	if (status === 432 || status === 433) {
		return new TavilyToolError(
			tool,
			"tavily_quota_exhausted",
			"ask_user",
			"Tavily reported that the account quota is exhausted.",
			status,
		);
	}
	if (status === 429) {
		return new TavilyToolError(tool, "tavily_rate_limited", "stop_turn", "Tavily remained rate limited.", status);
	}
	if (status >= 500 && status <= 599) {
		return new TavilyToolError(tool, "tavily_unavailable", "stop_turn", "Tavily is temporarily unavailable.", status);
	}
	return new TavilyToolError(tool, "tavily_rejected", "stop_turn", "Tavily rejected the request.", status);
}

function parseRetryAfter(value: string | null, now: number): number {
	if (value === null) return 0;
	const seconds = Number(value.trim());
	if (Number.isFinite(seconds) && seconds >= 0) return Math.min(MAX_RETRY_AFTER_MS, Math.floor(seconds * 1_000));
	const date = Date.parse(value);
	if (!Number.isFinite(date)) return 0;
	return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, date - now));
}

async function abortableDelay(
	delayMs: number,
	signal: AbortSignal | undefined,
	deadlineAt: number,
	now: () => number,
	tool: TavilyTool,
): Promise<void> {
	if (delayMs <= 0) return;
	if (deadlineAt - now() <= delayMs) throw timeoutError(tool);
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(() => {
			cleanup();
			resolve();
		}, delayMs);
		const onAbort = () => {
			cleanup();
			reject(new TavilyToolError(tool, "tavily_request_aborted", "stop_turn", "The Tavily request was cancelled."));
		};
		const cleanup = () => {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
		};
		if (signal?.aborted) {
			onAbort();
			return;
		}
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function assertNotAborted(tool: TavilyTool, signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw new TavilyToolError(tool, "tavily_request_aborted", "stop_turn", "The Tavily request was cancelled.");
	}
}

function timeoutError(tool: TavilyTool): TavilyToolError {
	return new TavilyToolError(tool, "tavily_request_timeout", "stop_turn", "The Tavily request deadline expired.");
}

async function cancelBody(response: Response): Promise<void> {
	try {
		await response.body?.cancel();
	} catch {
		// Cancellation is best effort; the sanitized protocol error remains authoritative.
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
