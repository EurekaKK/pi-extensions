import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TavilyBudgetLedger } from "../../src/budgets.js";
import { loadOrCreateConfig } from "../../src/config.js";
import { TavilyToolService } from "../../src/tools.js";
import type { TavilyWebSearchConfig } from "../../src/types.js";

const INTEGRATION_CONFIG: TavilyWebSearchConfig = {
	version: 1,
	domains: { allow: ["en.wikipedia.org"], deny: [] },
	retrieval: {
		searchDepth: "basic",
		extractDepth: "basic",
		maxSearchResults: 3,
		maxOutputCharacters: 12_000,
		maxDocumentBytes: 262_144,
	},
	budgets: {
		maxToolCallsPerTurn: 6,
		maxToolCallsPerAgentRun: 6,
		maxToolCallsPerBranchLineage: 6,
		maxTavilyCreditsPerAgentRun: 3,
		maxTavilyCreditsPerBranchLineage: 3,
		maxConcurrency: 1,
	},
	cache: { searchTtlSeconds: 300, extractTtlSeconds: 900, maxBytes: 4_194_304 },
};

describe.sequential("real Tavily integration", () => {
	let temporaryAgentDir = "";
	let service: TavilyToolService | undefined;
	let networkAttempts = 0;

	beforeAll(async () => {
		const apiKey = process.env.TAVILY_API_KEY;
		if (apiKey === undefined || apiKey.trim().length === 0) {
			throw new Error("TAVILY_API_KEY is required for npm run test:integration:tavily (integration was not run).");
		}
		temporaryAgentDir = await mkdtemp(join(tmpdir(), "tavily-web-search-integration-"));
		const configDirectory = join(temporaryAgentDir, "tavily-web-search");
		const configPath = join(configDirectory, "config.json");
		await mkdir(configDirectory, { recursive: true });
		await writeFile(configPath, `${JSON.stringify(INTEGRATION_CONFIG, undefined, 2)}\n`, {
			encoding: "utf8",
			flag: "wx",
		});
		const loaded = await loadOrCreateConfig(configPath, "unused-default.json", withFileMutationQueue);
		const ledger = new TavilyBudgetLedger({
			limits: loaded.config.budgets,
			appendEntry: () => undefined,
			randomId: randomUUID,
		});
		const countedFetch: typeof globalThis.fetch = async (input, init) => {
			networkAttempts += 1;
			return globalThis.fetch(input, init);
		};
		service = new TavilyToolService({
			config: loaded.config,
			apiKey,
			budget: ledger,
			dependencies: { fetch: countedFetch, now: Date.now, randomId: randomUUID, retryEnabled: false },
			generation: 1,
		});
	});

	afterAll(async () => {
		service?.shutdown();
		if (temporaryAgentDir.length > 0) await rm(temporaryAgentDir, { recursive: true, force: true });
	});

	it("performs exactly one live Search and two basic Extract attempts", async () => {
		if (!service) throw new Error("The Tavily integration service did not initialize.");
		const search = await service.executeSearch(
			{
				query: "Artificial intelligence Wikipedia",
				include_domains: ["en.wikipedia.org"],
				freshness: "live",
			},
			undefined,
		);
		const searchDetails = requireSearchDetails(search.details);
		expect(searchDetails.credits).toBe(1);
		expect(searchDetails.estimated).toBe(false);
		const refId = searchDetails.firstRefId;
		expect(refId, "Search must return at least one bounded Wikipedia ref").toMatch(/^tavily_ref_[1-9][0-9]*$/u);
		if (refId === undefined) throw new Error("Tavily Search returned no usable Wikipedia ref.");

		const focused = await service.executeOpen({ ref_id: refId, mode: "focused" }, undefined);
		const focusedUsage = requireOpenUsage(focused.details);
		expect([0, 1]).toContain(focusedUsage.credits);
		expect(focusedUsage.estimated).toBe(false);

		const full = await service.executeOpen({ ref_id: refId, mode: "full" }, undefined);
		const fullUsage = requireOpenUsage(full.details);
		expect([0, 1]).toContain(fullUsage.credits);
		expect(fullUsage.estimated).toBe(false);
		expect(networkAttempts).toBe(3);

		const cursor = readOptionalCursor(full.details);
		if (cursor !== undefined) {
			const attemptsBeforeCursor = networkAttempts;
			await service.executeOpen({ cursor }, undefined);
			expect(networkAttempts).toBe(attemptsBeforeCursor);
		}

		const summary = {
			status: "passed",
			network_attempts: networkAttempts,
			usage_credits: {
				search: searchDetails.credits,
				focused_extract: focusedUsage.credits,
				full_extract: fullUsage.credits,
				total: searchDetails.credits + focusedUsage.credits + fullUsage.credits,
			},
			cursor_read_without_network: cursor !== undefined,
		};
		process.stdout.write(`\nTavily integration summary: ${JSON.stringify(summary)}\n`);
	}, 120_000);
});

function requireSearchDetails(value: unknown): {
	readonly credits: number;
	readonly estimated: boolean;
	readonly firstRefId: string | undefined;
} {
	if (
		!isRecord(value) ||
		value.tavily_details_version !== 1 ||
		typeof value.tavily_usage_credits !== "number" ||
		!Number.isSafeInteger(value.tavily_usage_credits) ||
		typeof value.tavily_usage_estimated !== "boolean" ||
		!Array.isArray(value.tavily_refs)
	) {
		throw new Error("Tavily Search returned invalid integration details.");
	}
	const first = value.tavily_refs[0];
	const firstRefId = isRecord(first) && typeof first.tavily_ref_id === "string" ? first.tavily_ref_id : undefined;
	return { credits: value.tavily_usage_credits, estimated: value.tavily_usage_estimated, firstRefId };
}

function requireOpenUsage(value: unknown): { readonly credits: number; readonly estimated: boolean } {
	if (
		!isRecord(value) ||
		value.tavily_details_version !== 1 ||
		typeof value.tavily_usage_credits !== "number" ||
		!Number.isSafeInteger(value.tavily_usage_credits) ||
		typeof value.tavily_usage_estimated !== "boolean"
	) {
		throw new Error("Tavily Open returned invalid integration usage details.");
	}
	return { credits: value.tavily_usage_credits, estimated: value.tavily_usage_estimated };
}

function readOptionalCursor(value: unknown): string | undefined {
	if (!isRecord(value) || value.tavily_next_cursor === undefined) return undefined;
	if (typeof value.tavily_next_cursor !== "string") throw new Error("Tavily Open returned an invalid cursor detail.");
	return value.tavily_next_cursor;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
