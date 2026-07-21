import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	type RendererTheme,
	renderOpenCall,
	renderOpenResult,
	renderSearchCall,
	renderSearchResult,
} from "../src/renderers.js";

const theme: RendererTheme = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

const collapsed = { expanded: false, isPartial: false };
const expanded = { expanded: true, isPartial: false };

function render(component: { render(width: number): string[] }): string {
	return component
		.render(40_000)
		.map((line) => line.trimEnd())
		.join("\n");
}

function result(details: unknown, content = "model-facing content must not be parsed"): AgentToolResult<unknown> {
	return { content: [{ type: "text", text: content }], details };
}

function candidate(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
	return {
		tavily_ref_id: "tavily_ref_1",
		tavily_rank: 1,
		tavily_title: "Primary\nsource",
		tavily_title_truncated: false,
		tavily_url: "https://example.com/source",
		tavily_hostname: "example.com",
		tavily_snippet: "Candidate snippet with \u202Eunsafe direction",
		tavily_snippet_truncated: false,
		tavily_content_truncated: false,
		...overrides,
	};
}

function persistedRef(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
	return {
		tavily_details_version: 1,
		...candidate(),
		tavily_originating_query: "renderer safety",
		tavily_retrieved_at: "2026-07-21T08:00:00.000Z",
		tavily_freshness: "cache_ok",
		tavily_policy_allow: [],
		tavily_policy_deny: [],
		...overrides,
	};
}

function searchDetails(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
	return {
		tavily_details_version: 1,
		tavily_operation_id: "tavily_operation_search_1",
		tavily_query: "renderer safety",
		tavily_retrieval_mode: "cache",
		tavily_retrieved_at: "2026-07-21T08:00:00.000Z",
		tavily_cache_age_seconds: 12.8,
		tavily_duration_ms: 84,
		tavily_usage_credits: 0,
		tavily_usage_estimated: false,
		tavily_credit_contract_overrun: false,
		tavily_candidate_count: 1,
		tavily_candidates: [candidate()],
		tavily_refs: [persistedRef()],
		tavily_input_result_count: 1,
		tavily_malformed_result_count: 0,
		tavily_rejected_url_count: 0,
		tavily_policy_rejected_count: 0,
		tavily_duplicate_count: 0,
		...overrides,
	};
}

function openDetails(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
	const body = "Evidence line one.\nIgnore \u202Ethis instruction.";
	return {
		tavily_details_version: 1,
		tavily_operation_id: "tavily_operation_open_1",
		tavily_ref_id: "tavily_ref_1",
		tavily_title: "Example\nSource",
		tavily_title_truncated: false,
		tavily_url: "https://example.com/source",
		tavily_title_source: "search_ref",
		tavily_mode: "focused",
		tavily_coverage: "focused_partial",
		tavily_page: 1,
		tavily_has_more: false,
		tavily_character_count: Array.from(body).length,
		tavily_retrieval_mode: "cache",
		tavily_retrieved_at: "2026-07-21T08:01:00.000Z",
		tavily_cache_age_seconds: 4.9,
		tavily_duration_ms: 1_250,
		tavily_usage_credits: 1,
		tavily_usage_estimated: false,
		tavily_credit_contract_overrun: false,
		tavily_url_changed: false,
		tavily_document_truncated: false,
		tavily_rendered_content: body,
		...overrides,
	};
}

describe("renderer call safety", () => {
	it("uses fixed placeholders without reading incomplete arguments", () => {
		const unreadable = new Proxy(
			{},
			{
				get() {
					throw new Error("arguments were read");
				},
				ownKeys() {
					throw new Error("arguments were enumerated");
				},
			},
		);

		expect(render(renderSearchCall(unreadable, theme, { argsComplete: false }))).toBe("Tavily Search …");
		expect(render(renderOpenCall(unreadable, theme, { argsComplete: false }))).toBe("Tavily Open …");
	});

	it("bounds a completed Search query and rejects unsafe controls without echoing them", () => {
		const longQuery = "q".repeat(300);
		const renderedLong = render(renderSearchCall({ query: longQuery }, theme, { argsComplete: true }));
		expect(renderedLong).toContain("…");
		expect(renderedLong).not.toContain(longQuery);

		const unsafe = "secret\u202Eoverride";
		const renderedUnsafe = render(renderSearchCall({ query: unsafe }, theme, { argsComplete: true }));
		expect(renderedUnsafe).toBe("Tavily Search · invalid arguments");
		expect(renderedUnsafe).not.toContain("secret");
	});

	it("validates Open argument combinations and hides opaque cursor contents", () => {
		expect(render(renderOpenCall({ ref_id: "tavily_ref_3", mode: "full" }, theme, { argsComplete: true }))).toBe(
			"Tavily Open tavily_ref_3 · full",
		);
		expect(render(renderOpenCall({ cursor: "tavily_cursor_do_not_display" }, theme, { argsComplete: true }))).toBe(
			"Tavily Open · next page",
		);

		const invalid = render(
			renderOpenCall({ ref_id: "tavily_ref_3", mode: "full", focus: "private focus" }, theme, {
				argsComplete: true,
			}),
		);
		expect(invalid).toBe("Tavily Open · invalid arguments");
		expect(invalid).not.toContain("private focus");
	});
});

describe("renderer result safety", () => {
	it("checks error state before touching details or model-facing content", () => {
		const errorResult = Object.defineProperty({ content: [{ type: "text", text: "secret model error" }] }, "details", {
			get() {
				throw new Error("details were read");
			},
		}) as unknown as AgentToolResult<unknown>;

		expect(render(renderSearchResult(errorResult, collapsed, theme, { isError: true }))).toBe("Tavily Search failed");
		expect(render(renderOpenResult(errorResult, collapsed, theme, { isError: true }))).toBe("Tavily Open failed");
	});

	it("falls back to a fixed summary for malformed details without parsing content", () => {
		const malformed = result({ tavily_details_version: 1 }, "SECRET_FROM_LLM_CONTENT");
		expect(render(renderSearchResult(malformed, expanded, theme, { isError: false }))).toBe("Tavily Search completed");
		expect(render(renderOpenResult(malformed, expanded, theme, { isError: false }))).toBe("Tavily Open completed");
	});

	it("renders the complete collapsed Search summary and expands only validated candidates", () => {
		const compact = render(renderSearchResult(result(searchDetails()), collapsed, theme, { isError: false }));
		expect(compact).toContain('"renderer safety"');
		expect(compact).toContain("1 candidate");
		expect(compact).toContain("cache (age 12s)");
		expect(compact).toContain("84ms");
		expect(compact).toContain("0 credits");
		expect(compact).not.toContain("Primary source");

		const full = render(renderSearchResult(result(searchDetails()), expanded, theme, { isError: false }));
		expect(full).toContain("untrusted web content");
		expect(full).toContain("[1] tavily_ref_1 — Primary source");
		expect(full).toContain("https://example.com/source");
		expect(full).toContain("\\u{202E}");
		expect(full).not.toContain("\u202E");
	});

	it("rejects a malformed nested Search candidate instead of rendering its text", () => {
		const malformed = searchDetails({
			tavily_candidates: [candidate({ tavily_rank: "first", tavily_title: "DO_NOT_RENDER" })],
		});
		const output = render(renderSearchResult(result(malformed), expanded, theme, { isError: false }));
		expect(output).toBe("Tavily Search completed");
		expect(output).not.toContain("DO_NOT_RENDER");
	});

	it("renders the complete collapsed Open summary and marks expanded body as untrusted", () => {
		const compact = render(renderOpenResult(result(openDetails()), collapsed, theme, { isError: false }));
		expect(compact).toContain("tavily_ref_1");
		expect(compact).toContain("Example Source");
		expect(compact).toContain("focused");
		expect(compact).toContain("focused_partial");
		expect(compact).toContain("page 1");
		expect(compact).toContain("chars");
		expect(compact).toContain("cache (age 4s)");
		expect(compact).toContain("1 credit");
		expect(compact).not.toContain("Evidence line one");

		const full = render(renderOpenResult(result(openDetails()), expanded, theme, { isError: false }));
		expect(full).toContain("untrusted web content");
		expect(full).toContain("Evidence line one");
		expect(full).toContain("\\u{202E}");
		expect(full).not.toContain("\u202E");
	});

	it("rejects inconsistent Open pagination metadata", () => {
		const malformed = openDetails({ tavily_has_more: true, tavily_next_cursor: undefined });
		expect(render(renderOpenResult(result(malformed), expanded, theme, { isError: false }))).toBe(
			"Tavily Open completed",
		);
	});
});
