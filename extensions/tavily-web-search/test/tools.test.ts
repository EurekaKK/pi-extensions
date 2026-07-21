import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type LedgerEvent, TavilyBudgetLedger } from "../src/budgets.js";
import { createEffectiveDomainPolicy } from "../src/domains.js";
import { TavilyToolError } from "../src/errors.js";
import type { TavilyResponse } from "../src/tavily.js";
import {
	parseTavilyExtractResponse,
	parseTavilySearchResponse,
	recoverRefsFromBranch,
	type TavilyCircuitReason,
	TavilyToolService,
} from "../src/tools.js";
import type { RefRecord, TavilyWebSearchConfig } from "../src/types.js";

const BASE_CONFIG: TavilyWebSearchConfig = {
	version: 1,
	domains: { allow: [], deny: [] },
	retrieval: {
		searchDepth: "basic",
		extractDepth: "basic",
		maxSearchResults: 5,
		maxOutputCharacters: 2_000,
		maxDocumentBytes: 262_144,
	},
	budgets: {
		maxToolCallsPerTurn: 16,
		maxToolCallsPerAgentRun: 64,
		maxToolCallsPerBranchLineage: 500,
		maxTavilyCreditsPerAgentRun: 100,
		maxTavilyCreditsPerBranchLineage: 1_000,
		maxConcurrency: 2,
	},
	cache: { searchTtlSeconds: 300, extractTtlSeconds: 900, maxBytes: 4_194_304 },
};

afterEach(() => {
	vi.useRealTimers();
});

describe("Tavily response parsing", () => {
	it("filters malformed and disallowed Search results, deduplicates by normalized URL, and preserves truncation flags", () => {
		const policy = createEffectiveDomainPolicy(["**.example.com"], ["blocked.example.com"], [], []);
		const parsed = parseTavilySearchResponse(
			{
				results: [
					{ title: "first", url: "https://example.com/a#fragment", content: "old", score: 0.1 },
					{ title: "better", url: "https://example.com/a", content: "x".repeat(4_001), score: 0.9 },
					{ title: "blocked", url: "https://blocked.example.com/a", content: "no" },
					{ title: 7, url: "https://example.com/b", content: "bad" },
				],
			},
			policy,
			5,
		);

		expect(parsed.candidates).toHaveLength(1);
		expect(parsed.candidates[0]).toMatchObject({
			title: "better",
			url: "https://example.com/a",
			snippetTruncated: true,
			contentTruncated: true,
		});
		expect(parsed.diagnostics).toMatchObject({ malformedResults: 1, policyRejected: 1, duplicates: 1 });
	});

	it("distinguishes a true empty Search from all-policy-rejected candidates", () => {
		const openPolicy = createEffectiveDomainPolicy([], [], [], []);
		expect(parseTavilySearchResponse({ results: [] }, openPolicy, 5).candidates).toEqual([]);
		const blockedPolicy = createEffectiveDomainPolicy(["allowed.example"], [], [], []);
		expect(() =>
			parseTavilySearchResponse(
				{ results: [{ title: "blocked", url: "https://other.example/a", content: "body" }] },
				blockedPolicy,
				5,
			),
		).toThrow(expect.objectContaining({ code: "tavily_no_allowed_results" }));
	});

	it("parses ref-independent Extract transport and revalidates changed URLs", () => {
		const policy = createEffectiveDomainPolicy(["**.example.com"], ["blocked.example.com"], [], []);
		const response = tavilyResponse({
			results: [{ url: "https://new.example.com/article", raw_content: "  evidence  " }],
		});
		const snapshot = parseTavilyExtractResponse(
			response,
			"https://old.example.com/article",
			"focused",
			"fact",
			policy,
			BASE_CONFIG,
		);
		expect(snapshot).toMatchObject({
			requestedUrl: "https://old.example.com/article",
			url: "https://new.example.com/article",
			content: "evidence",
			effectiveFocus: "fact",
		});

		expect(() =>
			parseTavilyExtractResponse(
				{ ...response, body: { results: [{ url: "https://blocked.example.com/a", raw_content: "no" }] } },
				"https://old.example.com/article",
				"focused",
				"fact",
				policy,
				BASE_CONFIG,
			),
		).toThrow(expect.objectContaining({ code: "tavily_content_unavailable" }));
		expect(() =>
			parseTavilyExtractResponse(
				{ ...response, body: { failed_results: [{ url: "redacted" }] } },
				"https://old.example.com/article",
				"focused",
				"fact",
				policy,
				BASE_CONFIG,
			),
		).toThrow(expect.objectContaining({ code: "tavily_content_unavailable" }));
	});
});

describe("TavilyToolService cache, ref, and cursor behavior", () => {
	it("reuses completed Search snapshots and refs, while live Search forces a new request", async () => {
		let attempts = 0;
		const fetchMock = vi.fn<typeof fetch>(async () => {
			attempts += 1;
			return jsonResponse({
				results: [{ title: `source ${attempts}`, url: "https://example.com/a", content: "snippet" }],
				usage: { credits: 1 },
			});
		});
		const service = createService(fetchMock).service;
		const first = await service.executeSearch({ query: "same" }, undefined);
		const cached = await service.executeSearch({ query: "same" }, undefined);
		const live = await service.executeSearch({ query: "same", freshness: "live" }, undefined);

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(readRefId(cached)).toBe(readRefId(first));
		expect(readRefId(live)).not.toBe(readRefId(first));
		expect(readDetails(cached).tavily_retrieval_mode).toBe("cache");
		service.shutdown();
	});

	it("coalesces concurrent Search callers and lets one waiter cancel independently", async () => {
		let resolveResponse: ((value: Response) => void) | undefined;
		const fetchMock = vi.fn<typeof fetch>(
			() =>
				new Promise<Response>((resolve) => {
					resolveResponse = resolve;
				}),
		);
		const service = createService(fetchMock).service;
		const cancelled = new AbortController();
		const first = service.executeSearch({ query: "coalesce" }, cancelled.signal);
		const second = service.executeSearch({ query: "coalesce" }, undefined);
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		cancelled.abort();
		resolveResponse?.(
			jsonResponse({
				results: [{ title: "source", url: "https://example.com/a", content: "snippet" }],
				usage: { credits: 1 },
			}),
		);

		await expectToolError(first, "tavily_request_aborted");
		await expect(second).resolves.toMatchObject({ details: { tavily_candidate_count: 1 } });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		service.shutdown();
	});

	it("shares a focused Extract transport across refs without leaking the leader ref or title", async () => {
		const refs = [
			ref("tavily_ref_1", "https://example.com/a", { title: "first title", originatingQuery: "first query" }),
			ref("tavily_ref_2", "https://example.com/a", { title: "second title", originatingQuery: "second query" }),
		];
		const fetchMock = vi.fn<typeof fetch>(async () =>
			jsonResponse({
				results: [{ url: "https://example.com/a", raw_content: "shared evidence" }],
				usage: { credits: 1 },
			}),
		);
		const service = createService(fetchMock, { initialRefs: refs }).service;
		const first = await service.executeOpen(
			{ ref_id: "tavily_ref_1", mode: "focused", focus: "shared focus" },
			undefined,
		);
		const second = await service.executeOpen(
			{ ref_id: "tavily_ref_2", mode: "focused", focus: "shared focus" },
			undefined,
		);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(readDetails(first)).toMatchObject({ tavily_ref_id: "tavily_ref_1", tavily_title: "first title" });
		expect(readDetails(second)).toMatchObject({
			tavily_ref_id: "tavily_ref_2",
			tavily_title: "second title",
			tavily_retrieval_mode: "cache",
		});
		service.shutdown();
	});

	it("keeps Extract cache and in-flight identity separated by effective policy", async () => {
		const refs = [
			ref("tavily_ref_1", "https://example.com/a", { policyAllow: ["example.com"] }),
			ref("tavily_ref_2", "https://example.com/a", { policyAllow: ["**.example.com"] }),
		];
		const fetchMock = vi.fn<typeof fetch>(async () =>
			jsonResponse({ results: [{ url: "https://example.com/a", raw_content: "evidence" }], usage: { credits: 1 } }),
		);
		const service = createService(fetchMock, { initialRefs: refs }).service;
		await service.executeOpen({ ref_id: "tavily_ref_1", focus: "same" }, undefined);
		await service.executeOpen({ ref_id: "tavily_ref_2", focus: "same" }, undefined);

		expect(fetchMock).toHaveBeenCalledTimes(2);
		service.shutdown();
	});

	it("does not reuse an Extract snapshot older than a live ref freshness floor", async () => {
		let now = 1_000;
		const refs = [
			ref("tavily_ref_1", "https://example.com/a"),
			ref("tavily_ref_2", "https://example.com/a", {
				freshness: "live",
				freshnessNotBefore: 2_000,
				retrievedAt: new Date(2_100).toISOString(),
			}),
		];
		const fetchMock = vi.fn<typeof fetch>(async () =>
			jsonResponse({ results: [{ url: "https://example.com/a", raw_content: "evidence" }], usage: { credits: 1 } }),
		);
		const service = createService(fetchMock, { initialRefs: refs, now: () => now }).service;
		await service.executeOpen({ ref_id: "tavily_ref_1", focus: "same" }, undefined);
		now = 2_100;
		await service.executeOpen({ ref_id: "tavily_ref_2", focus: "same" }, undefined);

		expect(fetchMock).toHaveBeenCalledTimes(2);
		service.shutdown();
	});

	it("uses a resolved hostname title after an admitted Extract URL change", async () => {
		const fetchMock = vi.fn<typeof fetch>(async () =>
			jsonResponse({
				results: [{ url: "https://resolved.example.com/new", raw_content: "evidence" }],
				usage: { credits: 1 },
			}),
		);
		const service = createService(fetchMock, {
			initialRefs: [ref("tavily_ref_1", "https://original.example.com/old", { policyAllow: ["**.example.com"] })],
		}).service;
		const result = await service.executeOpen({ ref_id: "tavily_ref_1" }, undefined);

		expect(readDetails(result)).toMatchObject({
			tavily_title: "resolved.example.com",
			tavily_title_source: "resolved_hostname",
			tavily_url_changed: true,
		});
		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("resolved.example.com") });
		service.shutdown();
	});

	it("propagates a Search-title truncation marker into focused Open output", async () => {
		const fetchMock = vi.fn<typeof fetch>(async () =>
			jsonResponse({
				results: [{ url: "https://example.com/a", raw_content: "evidence" }],
				usage: { credits: 1 },
			}),
		);
		const service = createService(fetchMock, {
			initialRefs: [ref("tavily_ref_1", "https://example.com/a", { titleTruncated: true, contentTruncated: true })],
		}).service;
		const result = await service.executeOpen({ ref_id: "tavily_ref_1" }, undefined);
		const content = result.content[0];

		expect(content).toMatchObject({ type: "text", text: expect.stringContaining('content_truncated="true"') });
		expect(readDetails(result).tavily_title_truncated).toBe(true);
		service.shutdown();
	});

	it("returns idempotent Full cursor pages without another Tavily request", async () => {
		const body = Array.from({ length: 300 }, (_, index) => `paragraph ${index} ${"evidence ".repeat(10)}`).join("\n\n");
		const fetchMock = vi.fn<typeof fetch>(async () =>
			jsonResponse({ results: [{ url: "https://example.com/a", raw_content: body }], usage: { credits: 1 } }),
		);
		const service = createService(fetchMock, { initialRefs: [ref("tavily_ref_1", "https://example.com/a")] }).service;
		const first = await service.executeOpen({ ref_id: "tavily_ref_1", mode: "full" }, undefined);
		const cursor = readCursor(first);
		const page = await service.executeOpen({ cursor }, undefined);
		const repeated = await service.executeOpen({ cursor }, undefined);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(page.content).toEqual(repeated.content);
		expect(readDetails(page)).toMatchObject({ tavily_page: 2, tavily_retrieval_mode: "cursor" });
		service.shutdown();
	});

	it("expires Full cursors when their bounded LRU view is evicted", async () => {
		const large = "a".repeat(240_000);
		const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
			const requested = readRequestBody(init).urls;
			return jsonResponse({ results: [{ url: requested, raw_content: large }], usage: { credits: 1 } });
		});
		const config = withConfig({ cache: { ...BASE_CONFIG.cache, maxBytes: 1_048_576 } });
		const service = createService(fetchMock, {
			config,
			initialRefs: [ref("tavily_ref_1", "https://example.com/a"), ref("tavily_ref_2", "https://example.com/b")],
		}).service;
		const first = await service.executeOpen({ ref_id: "tavily_ref_1", mode: "full" }, undefined);
		const oldCursor = readCursor(first);
		await service.executeOpen({ ref_id: "tavily_ref_2", mode: "full" }, undefined);

		await expectToolError(service.executeOpen({ cursor: oldCursor }, undefined), "tavily_cursor_expired");
		service.shutdown();
	});

	it("rejects unrepresentable stored metadata before network admission", async () => {
		const fetchMock = vi.fn<typeof fetch>();
		const longUrl = `https://example.com/a?value=${"x".repeat(6_000)}`;
		const service = createService(fetchMock, { initialRefs: [ref("tavily_ref_1", longUrl)] }).service;

		await expectToolError(service.executeOpen({ ref_id: "tavily_ref_1" }, undefined), "tavily_content_unavailable");
		expect(fetchMock).not.toHaveBeenCalled();
		service.shutdown();
	});
});

describe("history recovery and session circuit safety", () => {
	it("strictly correlates freshness and query metadata and advances nextRef only from validated shapes", () => {
		const valid = persistedRef("tavily_ref_7");
		const entries = [
			searchEntry({ ...valid, tavily_freshness: "live" }),
			searchEntry({ ...valid, tavily_ref_id: "tavily_ref_8", tavily_freshness_not_before: 1 }),
			searchEntry(valid, { tavily_query: "different" }),
			searchEntry({ ...valid, tavily_ref_id: "tavily_ref_9" }),
		];
		const recovered = recoverRefsFromBranch(entries, BASE_CONFIG);

		expect(recovered.refs.map((item) => item.refId)).toEqual(["tavily_ref_9"]);
		expect(recovered.nextRef).toBe(10);
	});

	it("revalidates historical URLs against the current policy and handles the safe ref upper bound", () => {
		const config = withConfig({ domains: { allow: ["allowed.example.com"], deny: [] } });
		const maximum = `tavily_ref_${Number.MAX_SAFE_INTEGER}`;
		const recovered = recoverRefsFromBranch(
			[
				searchEntry(
					persistedRef("tavily_ref_4", {
						tavily_url: "https://blocked.example.com/a",
						tavily_hostname: "blocked.example.com",
					}),
				),
				searchEntry(
					persistedRef(maximum, {
						tavily_url: "https://allowed.example.com/a",
						tavily_hostname: "allowed.example.com",
					}),
				),
			],
			config,
		);

		expect(recovered.refs.map((item) => item.refId)).toEqual([maximum]);
		expect(recovered.nextRef).toBe(Number.MAX_SAFE_INTEGER);
	});

	it("shares auth/quota/credit circuit state across branch generations without allowing another fetch", async () => {
		const state = { reason: "none" as "none" | TavilyCircuitReason };
		const circuitState = {
			read: () => state.reason,
			open: (reason: TavilyCircuitReason) => {
				if (state.reason === "none") state.reason = reason;
			},
		};
		const oldFetch = vi.fn<typeof fetch>(async () => jsonResponse({ usage: { credits: 1 } }, 401));
		const currentFetch = vi.fn<typeof fetch>(async () =>
			jsonResponse({ results: [{ title: "source", url: "https://example.com/a", content: "body" }] }),
		);
		const oldService = createService(oldFetch, { circuitState }).service;
		const currentService = createService(currentFetch, { circuitState, generation: 2 }).service;

		await expectToolError(
			oldService.executeSearch({ query: "old", freshness: "live" }, undefined),
			"tavily_auth_failed",
		);
		await expectToolError(
			currentService.executeSearch({ query: "new", freshness: "live" }, undefined),
			"tavily_auth_failed",
		);
		expect(currentFetch).not.toHaveBeenCalled();
		oldService.shutdown();
		currentService.shutdown();
	});

	it("rechecks the shared circuit after durable reservation and settles without sending", async () => {
		const state = { reason: "none" as "none" | TavilyCircuitReason };
		const fetchMock = vi.fn<typeof fetch>();
		const created = createService(fetchMock, {
			circuitState: {
				read: () => state.reason,
				open: (reason) => {
					if (state.reason === "none") state.reason = reason;
				},
			},
			onLedgerEvent: (event) => {
				if (event.tavily_event === "credit_reserved") state.reason = "quota";
			},
		});

		await expectToolError(
			created.service.executeSearch({ query: "reservation race", freshness: "live" }, undefined),
			"tavily_quota_exhausted",
		);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(created.events.some((event) => event.tavily_event === "credit_settled")).toBe(true);
		created.service.shutdown();
	});

	it("opens the credit circuit when an HTTP error reports usage above the reservation", async () => {
		const state = { reason: "none" as "none" | TavilyCircuitReason };
		const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ usage: { credits: 2 } }, 403));
		const service = createService(fetchMock, {
			circuitState: {
				read: () => state.reason,
				open: (reason) => {
					if (state.reason === "none") state.reason = reason;
				},
			},
		}).service;

		await expectToolError(service.executeSearch({ query: "overrun", freshness: "live" }, undefined), "tavily_rejected");
		expect(state.reason).toBe("credit");
		await expectToolError(
			service.executeSearch({ query: "blocked", freshness: "live" }, undefined),
			"tavily_credit_budget_exhausted",
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		service.shutdown();
	});

	it("keeps eligible completed cache readable after the session circuit opens", async () => {
		let attempts = 0;
		const fetchMock = vi.fn<typeof fetch>(async () => {
			attempts += 1;
			if (attempts === 1) {
				return jsonResponse({
					results: [{ title: "cached", url: "https://example.com/a", content: "snippet" }],
					usage: { credits: 1 },
				});
			}
			return jsonResponse({ usage: { credits: 1 } }, 401);
		});
		const service = createService(fetchMock).service;
		await service.executeSearch({ query: "cached" }, undefined);
		await expectToolError(
			service.executeSearch({ query: "breaker", freshness: "live" }, undefined),
			"tavily_auth_failed",
		);
		const cached = await service.executeSearch({ query: "cached" }, undefined);

		expect(readDetails(cached).tavily_retrieval_mode).toBe("cache");
		expect(fetchMock).toHaveBeenCalledTimes(2);
		service.shutdown();
	});

	it("reports an overall deadline as timeout instead of the downstream abort wrapper", async () => {
		const fetchMock = vi.fn<typeof fetch>(
			async (_input, init) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				}),
		);
		let firstNow = true;
		const service = createService(fetchMock, {
			now: () => {
				if (firstNow) {
					firstNow = false;
					return 0;
				}
				return 39_950;
			},
		}).service;
		const pending = service.executeSearch({ query: "deadline", freshness: "live" }, undefined);

		await expectToolError(pending, "tavily_request_timeout");
		service.shutdown();
	});
});

interface ServiceOptions {
	readonly config?: TavilyWebSearchConfig;
	readonly initialRefs?: readonly RefRecord[];
	readonly now?: () => number;
	readonly circuitState?: {
		read(): "none" | TavilyCircuitReason;
		open(reason: TavilyCircuitReason): void;
	};
	readonly generation?: number;
	readonly onLedgerEvent?: (event: LedgerEvent) => void;
}

function createService(fetchImplementation: typeof fetch, options: ServiceOptions = {}) {
	const config = options.config ?? BASE_CONFIG;
	const events: LedgerEvent[] = [];
	let id = 0;
	const randomId = () => `${++id}`.padStart(16, "0");
	const budget = new TavilyBudgetLedger({
		limits: config.budgets,
		appendEntry: (_type, event) => {
			events.push(event);
			options.onLedgerEvent?.(event);
		},
		randomId,
	});
	const service = new TavilyToolService({
		config,
		apiKey: "test-key",
		budget,
		dependencies: {
			fetch: fetchImplementation,
			now: options.now ?? (() => 2_000),
			randomId,
			retryEnabled: false,
		},
		generation: options.generation ?? 1,
		...(options.initialRefs === undefined ? {} : { initialRefs: options.initialRefs }),
		...(options.circuitState === undefined ? {} : { circuitState: options.circuitState }),
	});
	return { service, budget, events };
}

function ref(refId: string, url: string, overrides: Partial<RefRecord> = {}): RefRecord {
	const hostname = new URL(url).hostname;
	return {
		refId,
		rank: Number(refId.slice("tavily_ref_".length)),
		title: "source title",
		titleTruncated: false,
		url,
		hostname,
		snippet: "candidate snippet",
		snippetTruncated: false,
		contentTruncated: false,
		originatingQuery: "query",
		retrievedAt: new Date(2_000).toISOString(),
		freshness: "cache_ok",
		policyAllow: [],
		policyDeny: [],
		...overrides,
	};
}

function persistedRef(refId: string, overrides: Readonly<Record<string, unknown>> = {}) {
	return {
		tavily_details_version: 1,
		tavily_ref_id: refId,
		tavily_rank: 1,
		tavily_title: "title",
		tavily_title_truncated: false,
		tavily_url: "https://example.com/a",
		tavily_hostname: "example.com",
		tavily_snippet: "snippet",
		tavily_snippet_truncated: false,
		tavily_content_truncated: false,
		tavily_originating_query: "query",
		tavily_retrieved_at: new Date(2_000).toISOString(),
		tavily_freshness: "cache_ok",
		tavily_policy_allow: [],
		tavily_policy_deny: [],
		...overrides,
	};
}

function searchEntry(
	storedRef: Readonly<Record<string, unknown>>,
	overrides: Readonly<Record<string, unknown>> = {},
): SessionEntry {
	return {
		type: "message",
		message: {
			role: "toolResult",
			toolName: "tavily_search",
			details: {
				tavily_details_version: 1,
				tavily_query: "query",
				tavily_retrieved_at: new Date(2_000).toISOString(),
				tavily_refs: [storedRef],
				...overrides,
			},
		},
	} as unknown as SessionEntry;
}

function withConfig(overrides: {
	readonly domains?: TavilyWebSearchConfig["domains"];
	readonly cache?: TavilyWebSearchConfig["cache"];
}): TavilyWebSearchConfig {
	return {
		...BASE_CONFIG,
		...(overrides.domains === undefined ? {} : { domains: overrides.domains }),
		...(overrides.cache === undefined ? {} : { cache: overrides.cache }),
	};
}

function tavilyResponse(body: unknown): TavilyResponse {
	return {
		body,
		networkAdmissionAt: 1_000,
		retrievedAt: new Date(2_000).toISOString(),
		durationMs: 10,
		credits: 1,
		usageEstimated: false,
		creditContractOverrun: false,
	};
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function readRequestBody(init: RequestInit | undefined): Readonly<Record<string, unknown>> {
	if (typeof init?.body !== "string") throw new Error("expected request JSON");
	const parsed: unknown = JSON.parse(init.body);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
		throw new Error("expected request object");
	return parsed as Readonly<Record<string, unknown>>;
}

function readDetails(result: { readonly details?: unknown }): Readonly<Record<string, unknown>> {
	if (typeof result.details !== "object" || result.details === null || Array.isArray(result.details)) {
		throw new Error("expected details object");
	}
	return result.details as Readonly<Record<string, unknown>>;
}

function readRefId(result: { readonly details?: unknown }): string {
	const refs = readDetails(result).tavily_refs;
	if (!Array.isArray(refs) || typeof refs[0] !== "object" || refs[0] === null) throw new Error("expected ref");
	const value = (refs[0] as Readonly<Record<string, unknown>>).tavily_ref_id;
	if (typeof value !== "string") throw new Error("expected ref id");
	return value;
}

function readCursor(result: { readonly details?: unknown }): string {
	const value = readDetails(result).tavily_next_cursor;
	if (typeof value !== "string") throw new Error("expected a Full cursor");
	return value;
}

async function expectToolError(promise: Promise<unknown>, code: TavilyToolError["code"]): Promise<TavilyToolError> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(TavilyToolError);
		if (!(error instanceof TavilyToolError)) throw error;
		expect(error.code).toBe(code);
		return error;
	}
	throw new Error(`expected ${code}`);
}
