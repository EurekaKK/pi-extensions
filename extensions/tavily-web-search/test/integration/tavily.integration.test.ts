import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadTavilyWebSearch } from "../../src/index.js";

interface RegisteredTool {
	readonly name: string;
	execute(
		toolCallId: string,
		params: unknown,
		signal: AbortSignal | undefined,
	): Promise<{ readonly content: readonly { readonly type: string; readonly text?: string }[] }>;
}

describe.sequential("real Tavily integration", () => {
	let agentDir = "";
	const tools: RegisteredTool[] = [];

	beforeAll(async () => {
		const apiKey = process.env.TAVILY_API_KEY;
		if (apiKey === undefined || apiKey.trim().length === 0) {
			throw new Error("TAVILY_API_KEY is required for npm run test:integration:tavily");
		}
		agentDir = await mkdtemp(join(tmpdir(), "tavily-integration-"));
		await loadTavilyWebSearch(
			{
				on: () => undefined,
				registerTool: (tool: RegisteredTool) => {
					tools.push(tool);
				},
			} as unknown as ExtensionAPI,
			{
				agentDir,
				withFileMutationQueue,
				fetch: globalThis.fetch,
				readApiKey: () => apiKey,
			},
		);
	});

	afterAll(async () => {
		if (agentDir.length > 0) await rm(agentDir, { recursive: true, force: true });
	});

	it("searches and extracts through Tavily", async () => {
		const search = tools.find((tool) => tool.name === "tavily_search");
		const extract = tools.find((tool) => tool.name === "tavily_extract");
		if (search === undefined || extract === undefined) throw new Error("tools were not registered");
		const searchResult = await search.execute(
			"search-1",
			{ query: "Tavily API documentation", include_domains: ["docs.tavily.com"] },
			undefined,
		);
		const searchText = searchResult.content[0]?.text ?? "";
		expect(searchText).toContain("<tavily_search>");
		expect(searchText).toContain("https://");
		const urlMatch = /<url>(https:\/\/docs\.tavily\.com[^<]*)<\/url>/.exec(searchText);
		const url = urlMatch?.[1];
		expect(url).toBeDefined();
		const extractResult = await extract.execute("extract-1", { urls: [url] }, undefined);
		const extractText = extractResult.content[0]?.text ?? "";
		expect(extractText).toContain("<tavily_extract>");
	});
});
