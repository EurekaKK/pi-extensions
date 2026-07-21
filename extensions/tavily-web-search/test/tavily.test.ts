import { afterEach, describe, expect, it, vi } from "vitest";
import { EXTRACT_ENDPOINT, MAX_RESPONSE_BYTES, SEARCH_ATTEMPT_TIMEOUT_MS, SEARCH_ENDPOINT } from "../src/constants.js";
import { TavilyToolError } from "../src/errors.js";
import type {
	CreditReservation,
	CreditSettlement,
	NetworkGate,
	NetworkPermit,
	TavilyAttemptBudget,
	TavilyRequestContext,
} from "../src/tavily.js";
import { buildExtractPayload, buildSearchPayload, readUsageCredits, TavilyClient } from "../src/tavily.js";
import type { RetrievalDepth } from "../src/types.js";

class RecordingGate implements NetworkGate {
	readonly acquisitions: { readonly signal: AbortSignal | undefined; readonly deadlineAt: number }[] = [];
	releases = 0;

	async acquire(signal: AbortSignal | undefined, deadlineAt: number): Promise<NetworkPermit> {
		this.acquisitions.push({ signal, deadlineAt });
		return {
			release: () => {
				this.releases += 1;
			},
		};
	}
}

class RecordingBudget implements TavilyAttemptBudget {
	readonly reservations: {
		readonly operationId: string;
		readonly operation: "search" | "open";
		readonly depth: RetrievalDepth;
		readonly attemptId: string;
		readonly reservedCredits: number;
	}[] = [];
	readonly settlements: { readonly attemptId: string; readonly actualCredits: number | undefined }[] = [];

	async reserve(operationId: string, operation: "search" | "open", depth: RetrievalDepth): Promise<CreditReservation> {
		const reservedCredits = depth === "advanced" ? 2 : 1;
		const attemptId = `attempt-${this.reservations.length + 1}`;
		this.reservations.push({ operationId, operation, depth, attemptId, reservedCredits });
		return { attemptId, reservedCredits };
	}

	async settle(attemptId: string, actualCredits: number | undefined): Promise<CreditSettlement> {
		this.settlements.push({ attemptId, actualCredits });
		const reservation = this.reservations.find((item) => item.attemptId === attemptId);
		if (!reservation) throw new Error("unknown test reservation");
		const credits = actualCredits ?? reservation.reservedCredits;
		return {
			credits,
			estimated: actualCredits === undefined,
			contractOverrun: credits > reservation.reservedCredits,
			persisted: true,
		};
	}
}

function requestContext(
	gate: NetworkGate,
	budget: TavilyAttemptBudget,
	options: {
		readonly depth?: RetrievalDepth;
		readonly signal?: AbortSignal;
		readonly deadlineAt?: number;
		readonly apiKey?: string;
	} = {},
): TavilyRequestContext {
	return {
		operationId: "operation-1",
		apiKey: options.apiKey ?? "test-secret-key",
		depth: options.depth ?? "basic",
		signal: options.signal,
		deadlineAt: options.deadlineAt ?? 100_000,
		gate,
		budget,
	};
}

function jsonResponse(body: unknown, status = 200, headers: Readonly<Record<string, string>> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...Object.fromEntries(new Headers(headers)) },
	});
}

function searchRequest(depth: RetrievalDepth = "basic") {
	return {
		query: "current Node.js LTS",
		searchDepth: depth,
		maxResults: 5,
		includeDomains: [] as string[],
		excludeDomains: [] as string[],
	};
}

function fetchCallBody(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>, index = 0): unknown {
	const call = fetchMock.mock.calls[index];
	if (!call) throw new Error(`missing fetch call ${index}`);
	const init = call[1];
	if (typeof init?.body !== "string") throw new Error("expected a JSON string request body");
	const body: unknown = JSON.parse(init.body);
	return body;
}

async function expectToolError(promise: Promise<unknown>, code: TavilyToolError["code"]): Promise<TavilyToolError> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(TavilyToolError);
		if (error instanceof TavilyToolError) {
			expect(error.code).toBe(code);
			return error;
		}
		throw error;
	}
	throw new Error(`expected ${code}`);
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

afterEach(() => {
	vi.useRealTimers();
});

describe("Tavily request payloads", () => {
	it("builds the exact basic Search contract and omits unsupported parameters", () => {
		const payload = buildSearchPayload(searchRequest());
		expect(payload).toEqual({
			query: "current Node.js LTS",
			search_depth: "basic",
			max_results: 5,
			topic: "general",
			include_answer: false,
			include_raw_content: false,
			include_images: false,
			include_image_descriptions: false,
			include_favicon: false,
			auto_parameters: false,
			exact_match: false,
			include_usage: true,
		});
		for (const forbidden of [
			"chunks_per_source",
			"safe_search",
			"country",
			"start_date",
			"end_date",
			"timeout",
			"freshness",
		]) {
			expect(Object.hasOwn(payload, forbidden)).toBe(false);
		}
	});

	it("adds only advanced chunks, safe domain pushdown, and recency when requested", () => {
		expect(
			buildSearchPayload({
				...searchRequest("advanced"),
				includeDomains: ["nodejs.org"],
				excludeDomains: ["blocked.example.com"],
				recency: "month",
			}),
		).toEqual({
			query: "current Node.js LTS",
			search_depth: "advanced",
			max_results: 5,
			topic: "general",
			include_domains: ["nodejs.org"],
			exclude_domains: ["blocked.example.com"],
			time_range: "month",
			include_answer: false,
			include_raw_content: false,
			include_images: false,
			include_image_descriptions: false,
			include_favicon: false,
			auto_parameters: false,
			exact_match: false,
			include_usage: true,
			chunks_per_source: 3,
		});
	});

	it("uses one URL string and the exact focused/full Extract contracts", () => {
		expect(
			buildExtractPayload({
				url: "https://example.com/source",
				extractDepth: "basic",
				mode: "focused",
				focus: "material evidence",
			}),
		).toEqual({
			urls: "https://example.com/source",
			extract_depth: "basic",
			query: "material evidence",
			chunks_per_source: 5,
			format: "markdown",
			include_images: false,
			include_favicon: false,
			include_usage: true,
			timeout: 10,
		});

		const full = buildExtractPayload({
			url: "https://example.com/source",
			extractDepth: "advanced",
			mode: "full",
		});
		expect(full).toEqual({
			urls: "https://example.com/source",
			extract_depth: "advanced",
			format: "markdown",
			include_images: false,
			include_favicon: false,
			include_usage: true,
			timeout: 30,
		});
		expect(Object.hasOwn(full, "query")).toBe(false);
		expect(Object.hasOwn(full, "chunks_per_source")).toBe(false);
	});

	it("accepts only finite non-negative integer usage credits", () => {
		expect(readUsageCredits({ usage: { credits: 0 } })).toBe(0);
		expect(readUsageCredits({ usage: { credits: 2 }, future_field: true })).toBe(2);
		for (const body of [
			{},
			{ usage: {} },
			{ usage: { credits: -1 } },
			{ usage: { credits: 1.5 } },
			{ usage: { credits: Number.NaN } },
			{ usage: { credits: "1" } },
		]) {
			expect(readUsageCredits(body)).toBeUndefined();
		}
	});
});

describe("Tavily HTTP client contract", () => {
	it("uses the fixed endpoint, Bearer header, manual redirects, host fetch, and settles usage", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValue(jsonResponse({ results: [], usage: { credits: 1 }, ignored_future_field: true }));
		const gate = new RecordingGate();
		const budget = new RecordingBudget();
		const client = new TavilyClient({ fetch: fetchMock, now: () => 1_000, retryEnabled: false });
		const response = await client.search(searchRequest(), requestContext(gate, budget));

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const call = fetchMock.mock.calls[0];
		expect(call?.[0]).toBe(SEARCH_ENDPOINT);
		const init = call?.[1];
		expect(init).toMatchObject({ method: "POST", redirect: "manual" });
		const headers = new Headers(init?.headers);
		expect(headers.get("authorization")).toBe("Bearer test-secret-key");
		expect(headers.get("content-type")).toBe("application/json");
		expect(headers.get("accept")).toBe("application/json");
		expect(JSON.stringify(fetchCallBody(fetchMock))).not.toContain("test-secret-key");
		expect(gate.acquisitions).toEqual([{ signal: undefined, deadlineAt: 100_000 }]);
		expect(gate.releases).toBe(1);
		expect(budget.reservations).toHaveLength(1);
		expect(budget.settlements).toEqual([{ attemptId: "attempt-1", actualCredits: 1 }]);
		expect(response).toMatchObject({
			networkAdmissionAt: 1_000,
			retrievedAt: "1970-01-01T00:00:01.000Z",
			durationMs: 0,
			credits: 1,
			usageEstimated: false,
			creditContractOverrun: false,
		});
	});

	it("opens the credit-overrun circuit before a failing settlement can return", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ results: [], usage: { credits: 2 } }));
		const gate = new RecordingGate();
		const budget = new RecordingBudget();
		vi.spyOn(budget, "settle").mockRejectedValue(new Error("settlement write failed"));
		const onCreditContractOverrun = vi.fn();
		const client = new TavilyClient({ fetch: fetchMock, now: () => 1_000, retryEnabled: false });

		await expect(
			client.search(searchRequest(), {
				...requestContext(gate, budget),
				onCreditContractOverrun,
			}),
		).rejects.toThrow("settlement write failed");

		expect(onCreditContractOverrun).toHaveBeenCalledTimes(1);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("uses the fixed Extract endpoint and preserves the open error namespace", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ error: "do not expose" }, 403));
		const gate = new RecordingGate();
		const budget = new RecordingBudget();
		const client = new TavilyClient({ fetch: fetchMock, now: () => 1_000, retryEnabled: false });
		const error = await expectToolError(
			client.extract(
				{ url: "https://example.com/source", extractDepth: "basic", mode: "full" },
				requestContext(gate, budget),
			),
			"tavily_rejected",
		);

		expect(fetchMock.mock.calls[0]?.[0]).toBe(EXTRACT_ENDPOINT);
		expect(error.message.startsWith("tavily_open_error\n")).toBe(true);
		expect(error.message).not.toContain("do not expose");
	});

	it.each([
		[401, "tavily_auth_failed", "ask_user"],
		[403, "tavily_rejected", "stop_turn"],
		[429, "tavily_rate_limited", "stop_turn"],
		[432, "tavily_quota_exhausted", "ask_user"],
		[433, "tavily_quota_exhausted", "ask_user"],
		[500, "tavily_unavailable", "stop_turn"],
		[502, "tavily_unavailable", "stop_turn"],
	] as const)("maps HTTP %i to %s without leaking the response or key", async (status, code, action) => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValue(jsonResponse({ error: "raw-secret-response", usage: { credits: 0 } }, status));
		const gate = new RecordingGate();
		const budget = new RecordingBudget();
		const client = new TavilyClient({ fetch: fetchMock, now: () => 1_000, retryEnabled: false });
		const error = await expectToolError(client.search(searchRequest(), requestContext(gate, budget)), code);

		expect(error.modelAction).toBe(action);
		expect(error.httpStatus).toBe(status);
		expect(error.message).not.toContain("raw-secret-response");
		expect(error.message).not.toContain("test-secret-key");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(gate.releases).toBe(1);
		expect(budget.settlements).toEqual([{ attemptId: "attempt-1", actualCredits: 0 }]);
	});

	it("refuses redirects without following them or exposing their Location", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
			new Response("redirect", {
				status: 302,
				headers: { location: "https://attacker.example/steal" },
			}),
		);
		const gate = new RecordingGate();
		const budget = new RecordingBudget();
		const client = new TavilyClient({ fetch: fetchMock, now: () => 1_000, retryEnabled: true });
		const error = await expectToolError(
			client.search(searchRequest(), requestContext(gate, budget)),
			"tavily_redirected",
		);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(error.httpStatus).toBe(302);
		expect(error.message).not.toContain("attacker.example");
		expect(budget.settlements).toHaveLength(0);
	});

	it.each([429, 502, 503, 504])("retries HTTP %i exactly once with a new credit reservation", async (status) => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(jsonResponse({ error: "temporary", usage: { credits: 1 } }, status))
			.mockResolvedValueOnce(jsonResponse({ results: [], usage: { credits: 1 } }));
		const gate = new RecordingGate();
		const budget = new RecordingBudget();
		const client = new TavilyClient({ fetch: fetchMock, now: () => 1_000, retryEnabled: true });
		const response = await client.search(searchRequest(), requestContext(gate, budget));

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(gate.acquisitions).toHaveLength(2);
		expect(gate.releases).toBe(2);
		expect(budget.reservations.map(({ attemptId }) => attemptId)).toEqual(["attempt-1", "attempt-2"]);
		expect(budget.settlements).toEqual([
			{ attemptId: "attempt-1", actualCredits: 1 },
			{ attemptId: "attempt-2", actualCredits: 1 },
		]);
		expect(response.credits).toBe(2);
	});

	it("reports an unparseable retry attempt as conservatively estimated credit", async () => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response("not-json", { status: 503 }))
			.mockResolvedValueOnce(jsonResponse({ results: [], usage: { credits: 1 } }));
		const budget = new RecordingBudget();
		const client = new TavilyClient({ fetch: fetchMock, now: () => 1_000, retryEnabled: true });
		const response = await client.search(searchRequest(), requestContext(new RecordingGate(), budget));

		expect(budget.reservations).toHaveLength(2);
		expect(budget.settlements).toEqual([{ attemptId: "attempt-2", actualCredits: 1 }]);
		expect(response).toMatchObject({ credits: 2, usageEstimated: true });
	});

	it.each([400, 401, 403, 432, 433, 500, 501])("does not retry HTTP %i", async (status) => {
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(jsonResponse({ error: "failure", usage: { credits: 1 } }, status))
			.mockResolvedValueOnce(jsonResponse({ results: [], usage: { credits: 1 } }));
		const client = new TavilyClient({ fetch: fetchMock, now: () => 1_000, retryEnabled: true });
		await expect(
			client.search(searchRequest(), requestContext(new RecordingGate(), new RecordingBudget())),
		).rejects.toBeInstanceOf(TavilyToolError);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("caps Retry-After at five seconds", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(jsonResponse({ error: "temporary", usage: { credits: 1 } }, 503, { "retry-after": "999" }))
			.mockResolvedValueOnce(jsonResponse({ results: [], usage: { credits: 1 } }));
		const client = new TavilyClient({ fetch: fetchMock, now: Date.now, retryEnabled: true });
		const pending = client.search(searchRequest(), requestContext(new RecordingGate(), new RecordingBudget()));
		await flushMicrotasks();
		expect(fetchMock).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(4_999);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		await expect(pending).resolves.toMatchObject({ credits: 2 });
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("distinguishes caller abort, attempt timeout, and network failure without automatic retry", async () => {
		const makePendingFetch = () =>
			vi.fn<typeof fetch>().mockImplementation((_input, init) => {
				const signal = init?.signal;
				return new Promise<Response>((_resolve, reject) => {
					if (!signal) {
						reject(new Error("missing signal"));
						return;
					}
					if (signal.aborted) reject(signal.reason);
					else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				});
			});

		const callerController = new AbortController();
		const abortFetch = makePendingFetch();
		const abortClient = new TavilyClient({ fetch: abortFetch, now: () => 0, retryEnabled: true });
		const aborted = abortClient.search(
			searchRequest(),
			requestContext(new RecordingGate(), new RecordingBudget(), { signal: callerController.signal }),
		);
		await flushMicrotasks();
		callerController.abort(new Error("user stopped"));
		await expectToolError(aborted, "tavily_request_aborted");
		expect(abortFetch).toHaveBeenCalledTimes(1);

		vi.useFakeTimers();
		vi.setSystemTime(0);
		const timeoutFetch = makePendingFetch();
		const timeoutClient = new TavilyClient({ fetch: timeoutFetch, now: Date.now, retryEnabled: true });
		const timedOut = timeoutClient.search(
			searchRequest(),
			requestContext(new RecordingGate(), new RecordingBudget(), { deadlineAt: 100_000 }),
		);
		const timeoutAssertion = expectToolError(timedOut, "tavily_request_timeout");
		await vi.advanceTimersByTimeAsync(SEARCH_ATTEMPT_TIMEOUT_MS);
		await timeoutAssertion;
		expect(timeoutFetch).toHaveBeenCalledTimes(1);

		vi.useRealTimers();
		const networkFetch = vi.fn<typeof fetch>().mockRejectedValue(new Error("socket failed with secret payload"));
		const networkClient = new TavilyClient({ fetch: networkFetch, now: () => 0, retryEnabled: true });
		const networkError = await expectToolError(
			networkClient.search(searchRequest(), requestContext(new RecordingGate(), new RecordingBudget())),
			"tavily_network_failure",
		);
		expect(networkFetch).toHaveBeenCalledTimes(1);
		expect(networkError.message).not.toContain("socket failed");
	});

	it("rejects deceptive Content-Length and streaming bodies over 2 MiB", async () => {
		const declaredLargeFetch = vi.fn<typeof fetch>().mockResolvedValue(
			new Response("{}", {
				status: 200,
				headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) },
			}),
		);
		const declaredClient = new TavilyClient({ fetch: declaredLargeFetch, now: () => 0, retryEnabled: false });
		await expectToolError(
			declaredClient.search(searchRequest(), requestContext(new RecordingGate(), new RecordingBudget())),
			"tavily_response_too_large",
		);

		const actualLargeFetch = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(new Uint8Array(MAX_RESPONSE_BYTES + 1), {
				status: 200,
				headers: { "content-length": "2" },
			}),
		);
		const actualClient = new TavilyClient({ fetch: actualLargeFetch, now: () => 0, retryEnabled: false });
		await expectToolError(
			actualClient.search(searchRequest(), requestContext(new RecordingGate(), new RecordingBudget())),
			"tavily_response_too_large",
		);
	});

	it.each([
		[new Response("not json", { status: 200 }), "malformed JSON"],
		[new Response(Uint8Array.from([0xff]), { status: 200 }), "invalid UTF-8"],
		[new Response(null, { status: 200 }), "empty body"],
	] as const)("maps %s to protocol error (%s)", async (response, _label) => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
		const client = new TavilyClient({ fetch: fetchMock, now: () => 0, retryEnabled: false });
		await expectToolError(
			client.search(searchRequest(), requestContext(new RecordingGate(), new RecordingBudget())),
			"tavily_protocol_error",
		);
	});

	it("settles missing or malformed usage conservatively without dropping valid content", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ results: [], usage: { credits: "one" } }));
		const budget = new RecordingBudget();
		const client = new TavilyClient({ fetch: fetchMock, now: () => 0, retryEnabled: false });
		const response = await client.search(searchRequest(), requestContext(new RecordingGate(), budget));

		expect(budget.settlements).toEqual([{ attemptId: "attempt-1", actualCredits: undefined }]);
		expect(response).toMatchObject({ credits: 1, usageEstimated: true, creditContractOverrun: false });
	});

	it("reports a supplier credit contract overrun while returning paid content", async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ results: [], usage: { credits: 3 } }));
		const client = new TavilyClient({ fetch: fetchMock, now: () => 0, retryEnabled: false });
		const response = await client.search(searchRequest(), requestContext(new RecordingGate(), new RecordingBudget()));
		expect(response).toMatchObject({ credits: 3, usageEstimated: false, creditContractOverrun: true });
	});
});
