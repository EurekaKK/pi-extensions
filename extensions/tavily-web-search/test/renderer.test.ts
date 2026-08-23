import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	clampLines,
	parseExtractDetails,
	parseSearchDetails,
	type RenderContext,
	renderExtractCall,
	renderExtractResult,
	renderSearchCall,
	renderSearchResult,
	sanitizeTerminalText,
	TAVILY_DETAILS_VERSION,
} from "../src/renderer.js";

const theme = {
	fg: (_color: string, value: string) => value,
	bold: (value: string) => value,
} as unknown as Theme;

interface Renderable {
	render(width: number): string[];
}

function callContext(args: unknown, argsComplete = true): RenderContext {
	return { args, argsComplete, isError: false, isPartial: false, expanded: false };
}

function resultContext(args: unknown, isError = false): RenderContext {
	return { args, argsComplete: true, isError, isPartial: false, expanded: false };
}

function searchEnvelopeText(hits: readonly string[], snippet = "Snippet A"): string {
	const inner = hits
		.map(
			(title) =>
				`<hit>\n<title>${title}</title>\n<url>https://example.com/${title}</url>\n<snippet>${snippet}</snippet>\n</hit>`,
		)
		.join("\n");
	return `<tavily_search>\n<untrusted_external_data>\n${inner}\n</untrusted_external_data>\n</tavily_search>`;
}

function extractEnvelopeText(pageCount: number, failedCount: number): string {
	const pages = Array.from(
		{ length: pageCount },
		(_, i) => `<page>\n<url>https://example.com/${i}</url>\n<content>Page body ${i}</content>\n</page>`,
	);
	const failed = Array.from(
		{ length: failedCount },
		(_, i) => `<failed>\n<url>https://example.com/missing/${i}</url>\n</failed>`,
	);
	return `<tavily_extract>\n<untrusted_external_data>\n${[...pages, ...failed].join("\n")}\n</untrusted_external_data>\n</tavily_extract>`;
}

function searchResult(
	details: unknown,
	text = searchEnvelopeText(["First"], "Snippet body"),
): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details };
}

function extractResult(details: unknown, text = extractEnvelopeText(1, 1)): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details };
}

function rendered(component: Renderable, width = 120): string {
	return component.render(width).join("\n");
}

describe("tavily renderer details validation", () => {
	it("accepts versioned Search details and rejects malformed external values", () => {
		expect(parseSearchDetails({ tavily_details_version: 1, tavily_hit_count: 3 })).toEqual({
			tavily_details_version: 1,
			tavily_hit_count: 3,
		});
		expect(parseSearchDetails({ tavily_details_version: 1, tavily_hit_count: 0 })).toBeDefined();
		expect(
			parseSearchDetails({ tavily_details_version: 1, tavily_hit_count: 2, tavily_extra: "ignored" }),
		).toBeDefined();
		expect(parseSearchDetails(undefined)).toBeUndefined();
		expect(parseSearchDetails(null)).toBeUndefined();
		expect(parseSearchDetails([1, 2])).toBeUndefined();
		expect(parseSearchDetails({})).toBeUndefined();
		expect(parseSearchDetails({ tavily_details_version: 2, tavily_hit_count: 3 })).toBeUndefined();
		expect(parseSearchDetails({ tavily_details_version: 1 })).toBeUndefined();
		expect(parseSearchDetails({ tavily_details_version: 1, tavily_hit_count: "3" })).toBeUndefined();
		expect(parseSearchDetails({ tavily_details_version: 1, tavily_hit_count: 3.5 })).toBeUndefined();
		expect(parseSearchDetails({ tavily_details_version: 1, tavily_hit_count: -1 })).toBeUndefined();
		expect(parseSearchDetails({ tavily_details_version: 1, tavily_hit_count: Number.NaN })).toBeUndefined();
	});

	it("accepts versioned Extract details and rejects malformed external values", () => {
		expect(
			parseExtractDetails({
				tavily_details_version: 1,
				tavily_url_count: 2,
				tavily_page_count: 1,
				tavily_failed_count: 1,
			}),
		).toEqual({
			tavily_details_version: 1,
			tavily_url_count: 2,
			tavily_page_count: 1,
			tavily_failed_count: 1,
		});
		expect(parseExtractDetails(undefined)).toBeUndefined();
		expect(parseExtractDetails({})).toBeUndefined();
		expect(
			parseExtractDetails({ tavily_details_version: 1, tavily_url_count: 2, tavily_page_count: 1 }),
		).toBeUndefined();
		expect(
			parseExtractDetails({
				tavily_details_version: 1,
				tavily_url_count: 2,
				tavily_page_count: 1,
				tavily_failed_count: "1",
			}),
		).toBeUndefined();
		expect(
			parseExtractDetails({
				tavily_details_version: 1,
				tavily_url_count: 2,
				tavily_page_count: -1,
				tavily_failed_count: 1,
			}),
		).toBeUndefined();
		expect(
			parseExtractDetails({
				tavily_details_version: 1,
				tavily_url_count: 2,
				tavily_page_count: 1.5,
				tavily_failed_count: 1,
			}),
		).toBeUndefined();
	});
});

describe("tavily renderer text shaping", () => {
	it("strips C0/C1 control characters but keeps tabs, newlines and printable text", () => {
		const ctl = `${String.fromCharCode(27)}[31mred${String.fromCharCode(7)} bell`;
		expect(sanitizeTerminalText(ctl)).toBe("[31mred bell");
		expect(sanitizeTerminalText("line1\r\nline2\u0000")).toBe("line1\nline2");
		expect(sanitizeTerminalText("a\tb\nc")).toBe("a\tb\nc");
	});

	it("clamps every logical line to the requested visible width", () => {
		const longLine = "x".repeat(500);
		const clamped = clampLines(`${longLine}\nshort`, 100);
		const [first, second] = clamped.split("\n");
		expect(first?.length).toBe(100);
		expect(first).toMatch(/\.\.\.$/);
		expect(second).toBe("short");
	});
});

describe("tavily_search renderer", () => {
	it("shows a fixed placeholder while call arguments are incomplete", () => {
		expect(rendered(renderSearchCall(undefined, theme, callContext(undefined, false)), 80)).toContain("tavily_search");
		expect(rendered(renderSearchCall(undefined, theme, callContext(undefined, false)), 80)).not.toContain("query");
	});

	it("shows the truncated query in renderCall and keeps every line width-safe", () => {
		const longQuery = "q".repeat(500);
		const lines = renderSearchCall({ query: longQuery }, theme, callContext({ query: longQuery })).render(80);
		expect(lines.join("\n")).toContain("tavily_search");
		expect(lines.join("\n")).not.toContain(longQuery);
		expect(lines.every((line) => line.length <= 80)).toBe(true);
		expect(rendered(renderSearchCall({}, theme, callContext({})), 80)).toContain("tavily_search");
	});

	it("collapsed result shows truncated query + hit count and hides XML, snippets and bodies", () => {
		const text = searchEnvelopeText(["Second"], "Snippet secret");
		const lines = renderSearchResult(
			searchResult({ tavily_details_version: TAVILY_DETAILS_VERSION, tavily_hit_count: 2 }, text),
			{ expanded: false, isPartial: false },
			theme,
			resultContext({ query: "node lts" }),
		).render(80);
		const collapsed = lines.join("\n");
		expect(collapsed).toContain("2 hits");
		expect(collapsed).toContain("node lts");
		expect(collapsed).not.toContain("Snippet secret");
		expect(collapsed).not.toContain("<hit>");
		expect(collapsed).not.toContain("<untrusted_external_data>");
		expect(collapsed).not.toContain("<tavily_search>");
		expect(lines.every((line) => line.length <= 80)).toBe(true);
	});

	it("collapsed result shows singular hit wording and works without a query in args", () => {
		const collapsed = rendered(
			renderSearchResult(
				searchResult({ tavily_details_version: TAVILY_DETAILS_VERSION, tavily_hit_count: 1 }),
				{ expanded: false, isPartial: false },
				theme,
				resultContext(undefined),
			),
			120,
		);
		expect(collapsed).toContain("1 hit");
		expect(collapsed).not.toContain("undefined");
	});

	it("expanded result shows the full original envelope content", () => {
		const text = searchEnvelopeText(["Third"], "Snippet full");
		const expanded = rendered(
			renderSearchResult(
				searchResult({ tavily_details_version: TAVILY_DETAILS_VERSION, tavily_hit_count: 1 }, text),
				{ expanded: true, isPartial: false },
				theme,
				resultContext({ query: "node lts" }),
			),
			120,
		);
		expect(expanded).toContain("Snippet full");
		expect(expanded).toContain("<untrusted_external_data>");
		expect(expanded).toContain("</tavily_search>");
	});

	it("wraps pathological expanded lines without losing content", () => {
		const bomb = "z".repeat(5000);
		const text = searchEnvelopeText(["Bomb"], bomb);
		const lines = renderSearchResult(
			searchResult({ tavily_details_version: TAVILY_DETAILS_VERSION, tavily_hit_count: 1 }, text),
			{ expanded: true, isPartial: false },
			theme,
			resultContext({}),
		).render(80);
		expect(lines.join("")).toContain(bomb);
		expect(lines.every((line) => line.length <= 80)).toBe(true);
	});

	it("collapsed error shows only the first line and never reads details", () => {
		const lines = renderSearchResult(
			searchResult({ tavily_details_version: "garbage" }, "boom line\nsecond line"),
			{ expanded: false, isPartial: false },
			theme,
			resultContext({}, true),
		).render(80);
		const collapsed = lines.join("\n");
		expect(collapsed).toContain("boom line");
		expect(collapsed).not.toContain("second line");
		expect(collapsed).not.toContain("garbage");
	});

	it("expanded error shows the full text even with malformed details", () => {
		const expanded = rendered(
			renderSearchResult(
				searchResult(null, "boom line\nsecond line"),
				{ expanded: true, isPartial: false },
				theme,
				resultContext({}, true),
			),
			120,
		);
		expect(expanded).toContain("boom line");
		expect(expanded).toContain("second line");
	});

	it("shows a fixed fallback for an empty error result", () => {
		expect(
			rendered(
				renderSearchResult(
					searchResult(undefined, ""),
					{ expanded: false, isPartial: false },
					theme,
					resultContext({}, true),
				),
				80,
			),
		).toContain("Search failed");
		expect(
			rendered(
				renderSearchResult(
					searchResult(undefined, ""),
					{ expanded: true, isPartial: false },
					theme,
					resultContext({}, true),
				),
				80,
			),
		).toContain("Search failed");
	});

	it("isPartial renders a fixed placeholder instead of half-written content", () => {
		const text = searchEnvelopeText(["Partial"]);
		const partial = rendered(
			renderSearchResult(
				searchResult({ tavily_details_version: TAVILY_DETAILS_VERSION, tavily_hit_count: 1 }, text),
				{ expanded: false, isPartial: true },
				theme,
				resultContext({}),
			),
			80,
		);
		expect(partial).toContain("in progress");
		expect(partial).not.toContain("Partial");
		expect(partial).not.toContain("<hit>");
	});

	it("falls back to a fixed summary when details are missing or malformed", () => {
		for (const details of [
			undefined,
			null,
			{},
			{ tavily_details_version: 1 },
			{ tavily_details_version: 2, tavily_hit_count: 1 },
			{ tavily_hit_count: 1 },
		]) {
			const collapsed = rendered(
				renderSearchResult(searchResult(details), { expanded: false, isPartial: false }, theme, resultContext({})),
				80,
			);
			expect(collapsed).toContain("Search complete");
			expect(collapsed).not.toContain("<hit>");
		}
	});
});

describe("tavily_extract renderer", () => {
	it("shows the URL count in renderCall and a placeholder while args are incomplete", () => {
		expect(
			rendered(
				renderExtractCall(
					{ urls: ["https://a", "https://b"] },
					theme,
					callContext({ urls: ["https://a", "https://b"] }),
				),
				80,
			),
		).toContain("tavily_extract · 2 URLs");
		expect(
			rendered(renderExtractCall({ urls: ["https://a"] }, theme, callContext({ urls: ["https://a"] })), 80),
		).toContain("1 URL");
		expect(rendered(renderExtractCall(undefined, theme, callContext(undefined, false)), 80)).toContain(
			"tavily_extract",
		);
		expect(rendered(renderExtractCall(undefined, theme, callContext(undefined, false)), 80)).not.toContain("URL");
	});

	it("collapsed result shows URL count plus page/failed counts and hides the envelope", () => {
		const text = extractEnvelopeText(1, 2);
		const lines = renderExtractResult(
			extractResult(
				{
					tavily_details_version: TAVILY_DETAILS_VERSION,
					tavily_url_count: 3,
					tavily_page_count: 1,
					tavily_failed_count: 2,
				},
				text,
			),
			{ expanded: false, isPartial: false },
			theme,
			resultContext({ urls: ["https://a", "https://b", "https://c"] }),
		).render(80);
		const collapsed = lines.join("\n");
		expect(collapsed).toContain("3 URLs · 1 page · 2 failed");
		expect(collapsed).not.toContain("Page body");
		expect(collapsed).not.toContain("<page>");
		expect(collapsed).not.toContain("<untrusted_external_data>");
		expect(lines.every((line) => line.length <= 80)).toBe(true);
	});

	it("collapsed result shows zero failed pages explicitly", () => {
		const collapsed = rendered(
			renderExtractResult(
				extractResult({
					tavily_details_version: TAVILY_DETAILS_VERSION,
					tavily_url_count: 2,
					tavily_page_count: 2,
					tavily_failed_count: 0,
				}),
				{ expanded: false, isPartial: false },
				theme,
				resultContext({}),
			),
			80,
		);
		expect(collapsed).toContain("2 URLs · 2 pages · 0 failed");
	});

	it("expanded result shows the full original envelope content", () => {
		const text = extractEnvelopeText(1, 1);
		const expanded = rendered(
			renderExtractResult(
				extractResult(
					{
						tavily_details_version: TAVILY_DETAILS_VERSION,
						tavily_url_count: 2,
						tavily_page_count: 1,
						tavily_failed_count: 1,
					},
					text,
				),
				{ expanded: true, isPartial: false },
				theme,
				resultContext({}),
			),
			120,
		);
		expect(expanded).toContain("Page body 0");
		expect(expanded).toContain("<tavily_extract>");
		expect(expanded).toContain("</tavily_extract>");
	});

	it("isError renders error text and isPartial renders a placeholder", () => {
		const error = rendered(
			renderExtractResult(
				extractResult(undefined, "boom"),
				{ expanded: false, isPartial: false },
				theme,
				resultContext({}, true),
			),
			80,
		);
		expect(error).toContain("boom");

		const partial = rendered(
			renderExtractResult(
				extractResult({
					tavily_details_version: TAVILY_DETAILS_VERSION,
					tavily_url_count: 1,
					tavily_page_count: 1,
					tavily_failed_count: 0,
				}),
				{ expanded: false, isPartial: true },
				theme,
				resultContext({}),
			),
			80,
		);
		expect(partial).toContain("in progress");
		expect(partial).not.toContain("Page body");
	});

	it("falls back to a fixed summary when details are malformed", () => {
		for (const details of [
			undefined,
			{ tavily_details_version: 1, tavily_url_count: 2, tavily_page_count: 1 },
			{ tavily_details_version: 9 },
		]) {
			const collapsed = rendered(
				renderExtractResult(extractResult(details), { expanded: false, isPartial: false }, theme, resultContext({})),
				80,
			);
			expect(collapsed).toContain("Extract complete");
			expect(collapsed).not.toContain("<page>");
		}
	});
});
