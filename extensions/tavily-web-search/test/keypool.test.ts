import { describe, expect, it, vi } from "vitest";
import { type SearchRequest, TavilyClient } from "../src/client.js";
import { TavilyRequestError } from "../src/errors.js";
import { resolveApiKeys } from "../src/index.js";

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: TavilyRequestError };

async function outcome<T>(promise: Promise<T>): Promise<Outcome<T>> {
	try {
		return { ok: true, value: await promise };
	} catch (error) {
		if (error instanceof TavilyRequestError) return { ok: false, error };
		return { ok: false, error: new TavilyRequestError("request", String(error)) };
	}
}

function authHeader(init: RequestInit | undefined): string | null {
	return new Headers(init?.headers).get("authorization");
}

const SEARCH: SearchRequest = { query: "q", searchDepth: "basic", maxResults: 5 };

interface MockClient {
	readonly client: TavilyClient;
	readonly fetchMock: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;
}

function makeClient(apiKeys: readonly string[]): MockClient {
	const fetchMock = vi.fn<typeof globalThis.fetch>();
	return { client: new TavilyClient({ apiKeys, fetch: fetchMock }), fetchMock };
}

describe("TavilyClient API key pool rotation", () => {
	it("starts on the first pool key, rotates on a rate limit, and the next call uses the next key", async () => {
		const { client, fetchMock } = makeClient(["tvly-1", "tvly-2"]);
		fetchMock.mockResolvedValueOnce(jsonResponse(429, {})).mockResolvedValueOnce(jsonResponse(200, { results: [] }));

		const first = await outcome(client.search(SEARCH, 1000, undefined));
		expect(first.ok).toBe(false);
		if (!first.ok) {
			expect(first.error.kind).toBe("rate_limited");
			expect(first.error.keyIndex).toBe(1);
			expect(first.error.poolSize).toBe(2);
			expect(first.error.exhausted).toBe(false);
			expect(first.error.message).toMatch(/key 1\/2.*rotated to key 2\/2/);
		}

		const second = await outcome(client.search(SEARCH, 1000, undefined));
		expect(second.ok).toBe(true);
		expect(authHeader(fetchMock.mock.calls[1]?.[1])).toBe("Bearer tvly-2");
	});

	it("walks the whole pool without auto-retrying and reports exhaustion on the last key", async () => {
		const { client, fetchMock } = makeClient(["tvly-1", "tvly-2", "tvly-3"]);
		fetchMock.mockResolvedValue(jsonResponse(429, {}));

		const expectations: readonly [RegExp, boolean][] = [
			[/key 1\/3.*rotated to key 2\/3/, false],
			[/key 2\/3.*rotated to key 3\/3/, false],
			[/key 3\/3.*all 3 pool keys are unavailable/, true],
		];
		for (const [message, exhausted] of expectations) {
			const result = await outcome(client.search(SEARCH, 1000, undefined));
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error.message).toMatch(message);
				expect(result.error.exhausted).toBe(exhausted);
			}
		}
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("resets the consecutive run on success, so exhaustion is reported again only after another full circle", async () => {
		const { client, fetchMock } = makeClient(["tvly-1", "tvly-2"]);
		fetchMock
			.mockResolvedValueOnce(jsonResponse(429, {}))
			.mockResolvedValueOnce(jsonResponse(200, { results: [] }))
			.mockResolvedValueOnce(jsonResponse(429, {}));
		// key1 429 -> rotate to key2; key2 success -> reset the run;
		// key2 429 -> rotate to key1 with the run back to 1 (not exhausted).
		const first = await outcome(client.search(SEARCH, 1000, undefined));
		expect(first.ok).toBe(false);
		await outcome(client.search(SEARCH, 1000, undefined)); // success, resets the run
		const second = await outcome(client.search(SEARCH, 1000, undefined));
		expect(second.ok).toBe(false);
		if (!second.ok) {
			expect(second.error.keyIndex).toBe(2);
			expect(second.error.exhausted).toBe(false);
			expect(second.error.message).toMatch(/key 2\/2.*rotated to key 1\/2/);
			expect(second.error.message).not.toMatch(/all 2 pool keys/);
		}
	});

	it("rotates on auth and quota errors as well", async () => {
		const { client, fetchMock } = makeClient(["tvly-1", "tvly-2"]);
		fetchMock.mockResolvedValueOnce(jsonResponse(401, {})).mockResolvedValueOnce(jsonResponse(432, {}));
		const auth = await outcome(client.search(SEARCH, 1000, undefined));
		expect(auth.ok).toBe(false);
		if (!auth.ok) {
			expect(auth.error.kind).toBe("auth");
			expect(auth.error.keyIndex).toBe(1);
			expect(auth.error.message).toMatch(/key 1\/2.*rotated to key 2\/2/);
		}
		const quota = await outcome(client.search(SEARCH, 1000, undefined));
		expect(quota.ok).toBe(false);
		if (!quota.ok) {
			expect(quota.error.kind).toBe("quota");
			expect(quota.error.keyIndex).toBe(2);
			expect(quota.error.exhausted).toBe(true);
			expect(quota.error.message).toMatch(/all 2 pool keys are unavailable/);
		}
	});

	it("does not rotate on non-key request errors", async () => {
		const { client, fetchMock } = makeClient(["tvly-1", "tvly-2"]);
		fetchMock.mockResolvedValue(jsonResponse(500, {}));
		for (let i = 0; i < 2; i += 1) {
			const result = await outcome(client.search(SEARCH, 1000, undefined));
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.error.kind).toBe("request");
				expect(result.error.keyIndex).toBeUndefined();
				expect(result.error.message).toMatch(/Tavily request failed \(500\)/);
				expect(result.error.message).not.toMatch(/rotated/);
			}
		}
		expect(authHeader(fetchMock.mock.calls[0]?.[1])).toBe("Bearer tvly-1");
		expect(authHeader(fetchMock.mock.calls[1]?.[1])).toBe("Bearer tvly-1");
	});

	it("reports a single-key pool as exhausted on the first key error", async () => {
		const { client, fetchMock } = makeClient(["tvly-1"]);
		fetchMock.mockResolvedValue(jsonResponse(429, {}));
		const result = await outcome(client.search(SEARCH, 1000, undefined));
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.kind).toBe("rate_limited");
			expect(result.error.keyIndex).toBe(1);
			expect(result.error.poolSize).toBe(1);
			expect(result.error.exhausted).toBe(true);
			expect(result.error.message).toMatch(/the only pool key is unavailable/);
		}
	});

	it("never skips a pool key when concurrent stale calls rotate at the same time", async () => {
		const { client, fetchMock } = makeClient(["tvly-1", "tvly-2", "tvly-3"]);
		let resolveA!: (response: Response) => void;
		let resolveB!: (response: Response) => void;
		fetchMock
			.mockImplementationOnce(() => new Promise<Response>((resolve) => (resolveA = resolve)))
			.mockImplementationOnce(() => new Promise<Response>((resolve) => (resolveB = resolve)))
			.mockResolvedValueOnce(jsonResponse(200, { results: [] }));

		const p1 = client.search(SEARCH, 1000, undefined);
		const p2 = client.search(SEARCH, 1000, undefined);
		// Both calls captured the first key before either failed.
		resolveA(jsonResponse(429, {}));
		resolveB(jsonResponse(429, {}));
		const [e1, e2] = await Promise.all([outcome(p1), outcome(p2)]);
		expect(e1.ok).toBe(false);
		expect(e2.ok).toBe(false);

		const third = await outcome(client.search(SEARCH, 1000, undefined));
		expect(third.ok).toBe(true);
		// The third call lands on the second key, the first untried one after key 1.
		expect(authHeader(fetchMock.mock.calls[2]?.[1])).toBe("Bearer tvly-2");
	});
});

describe("resolveApiKeys", () => {
	it("prefers TAVILY_API_KEYS and trims each entry", () => {
		expect(resolveApiKeys("aa, bb ,cc", "solo")).toEqual(["aa", "bb", "cc"]);
	});

	it("falls back to TAVILY_API_KEY when no pool entries survive", () => {
		expect(resolveApiKeys(undefined, "solo")).toEqual(["solo"]);
		expect(resolveApiKeys("", "solo")).toEqual(["solo"]);
		expect(resolveApiKeys(" , , ", "solo")).toEqual(["solo"]);
		expect(resolveApiKeys(",,", "solo")).toEqual(["solo"]);
		expect(resolveApiKeys("  ", "  solo  ")).toEqual(["solo"]);
	});

	it("returns an empty pool when nothing usable is set", () => {
		expect(resolveApiKeys(undefined, undefined)).toEqual([]);
		expect(resolveApiKeys(undefined, "  ")).toEqual([]);
		expect(resolveApiKeys(",,", " ")).toEqual([]);
	});
});
