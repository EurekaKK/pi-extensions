import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type RetrievalDepth = "basic" | "advanced";
export type SearchRecency = "day" | "week" | "month" | "year";
export type SearchFreshness = "cache_ok" | "live";
export type OpenMode = "focused" | "full";
export type RetrievalMode = "live" | "cache" | "cursor";
export type Coverage = "focused_partial" | "snapshot_complete" | "snapshot_truncated";
export type TitleSource = "search_ref" | "resolved_hostname";

export interface TavilyWebSearchConfig {
	readonly version: 1;
	readonly domains: {
		readonly allow: readonly string[];
		readonly deny: readonly string[];
	};
	readonly retrieval: {
		readonly searchDepth: RetrievalDepth;
		readonly extractDepth: RetrievalDepth;
		readonly maxSearchResults: number;
		readonly maxOutputCharacters: number;
		readonly maxDocumentBytes: number;
	};
	readonly budgets: {
		readonly maxToolCallsPerTurn: number;
		readonly maxToolCallsPerAgentRun: number;
		readonly maxToolCallsPerBranchLineage: number;
		readonly maxTavilyCreditsPerAgentRun: number;
		readonly maxTavilyCreditsPerBranchLineage: number;
		readonly maxConcurrency: number;
	};
	readonly cache: {
		readonly searchTtlSeconds: number;
		readonly extractTtlSeconds: number;
		readonly maxBytes: number;
	};
}

export interface SearchInput {
	readonly query: string;
	readonly include_domains?: readonly string[];
	readonly exclude_domains?: readonly string[];
	readonly recency?: SearchRecency;
	readonly freshness?: SearchFreshness;
}

export interface OpenInput {
	readonly ref_id?: string;
	readonly mode?: OpenMode;
	readonly focus?: string;
	readonly cursor?: string;
}

export type DomainPatternKind = "exact" | "subdomains" | "apex_and_subdomains";

export interface DomainPattern {
	readonly kind: DomainPatternKind;
	readonly hostname: string;
	readonly canonical: string;
}

export interface EffectiveDomainPolicy {
	readonly globalAllow: readonly DomainPattern[];
	readonly callAllow: readonly DomainPattern[];
	readonly deny: readonly DomainPattern[];
	readonly canonicalAllow: readonly string[];
	readonly canonicalDeny: readonly string[];
}

export interface NormalizedUrl {
	readonly url: string;
	readonly hostname: string;
}

export interface SearchCandidate {
	readonly refId: string;
	readonly rank: number;
	readonly title: string;
	readonly titleTruncated: boolean;
	readonly url: string;
	readonly hostname: string;
	readonly snippet: string;
	readonly snippetTruncated: boolean;
	readonly contentTruncated: boolean;
}

export interface RefRecord extends SearchCandidate {
	readonly originatingQuery: string;
	readonly retrievedAt: string;
	readonly freshness: SearchFreshness;
	readonly freshnessNotBefore?: number;
	readonly policyAllow: readonly string[];
	readonly policyDeny: readonly string[];
}

export interface SearchSnapshot {
	readonly candidates: readonly SearchCandidate[];
	readonly refs: readonly RefRecord[];
	readonly retrievedAt: string;
	readonly networkAdmissionAt: number;
	readonly query: string;
	readonly freshness: SearchFreshness;
	readonly rootContentTruncated: boolean;
	readonly usageCredits: number;
	readonly usageEstimated: boolean;
	readonly creditContractOverrun: boolean;
	readonly diagnostics: SearchDiagnostics;
}

export interface SearchDiagnostics {
	readonly inputResults: number;
	readonly malformedResults: number;
	readonly rejectedUrls: number;
	readonly policyRejected: number;
	readonly duplicates: number;
	readonly returnedResults: number;
}

export interface ExtractTransportSnapshot {
	readonly requestedUrl: string;
	readonly url: string;
	readonly hostname: string;
	readonly content: string;
	readonly mode: OpenMode;
	readonly coverage: Coverage;
	readonly effectiveFocus?: string;
	readonly retrievedAt: string;
	readonly networkAdmissionAt: number;
	readonly documentTruncated: boolean;
	readonly usageCredits: number;
	readonly usageEstimated: boolean;
	readonly creditContractOverrun: boolean;
}

export interface ExtractSnapshot {
	readonly refId: string;
	readonly title: string;
	readonly titleTruncated: boolean;
	readonly titleSource: TitleSource;
	readonly url: string;
	readonly hostname: string;
	readonly content: string;
	readonly mode: OpenMode;
	readonly coverage: Coverage;
	readonly effectiveFocus?: string;
	readonly retrievedAt: string;
	readonly networkAdmissionAt: number;
	readonly documentTruncated: boolean;
	readonly urlChanged: boolean;
	readonly usageCredits: number;
	readonly usageEstimated: boolean;
	readonly creditContractOverrun: boolean;
}

export interface CursorRecord {
	readonly cursor: string;
	readonly snapshotKey: string;
	readonly refId: string;
	readonly pageIndex: number;
	readonly expiresAt: number;
	readonly generation: number;
}

export interface SearchToolDetails {
	readonly tavily_details_version: 1;
	readonly tavily_operation_id: string;
	readonly tavily_query: string;
	readonly tavily_retrieval_mode: "live" | "cache";
	readonly tavily_retrieved_at: string;
	readonly tavily_cache_age_seconds?: number;
	readonly tavily_duration_ms: number;
	readonly tavily_usage_credits: number;
	readonly tavily_usage_estimated: boolean;
	readonly tavily_credit_contract_overrun: boolean;
	readonly tavily_candidate_count: number;
	readonly tavily_candidates: readonly PersistedCandidateDetails[];
	readonly tavily_refs: readonly PersistedRefDetails[];
	readonly tavily_input_result_count: number;
	readonly tavily_malformed_result_count: number;
	readonly tavily_rejected_url_count: number;
	readonly tavily_policy_rejected_count: number;
	readonly tavily_duplicate_count: number;
}

export interface PersistedCandidateDetails {
	readonly tavily_ref_id: string;
	readonly tavily_rank: number;
	readonly tavily_title: string;
	readonly tavily_title_truncated: boolean;
	readonly tavily_url: string;
	readonly tavily_hostname: string;
	readonly tavily_snippet: string;
	readonly tavily_snippet_truncated: boolean;
	readonly tavily_content_truncated: boolean;
}

export interface PersistedRefDetails extends PersistedCandidateDetails {
	readonly tavily_details_version: 1;
	readonly tavily_originating_query: string;
	readonly tavily_retrieved_at: string;
	readonly tavily_freshness: SearchFreshness;
	readonly tavily_freshness_not_before?: number;
	readonly tavily_policy_allow: readonly string[];
	readonly tavily_policy_deny: readonly string[];
}

export interface OpenToolDetails {
	readonly tavily_details_version: 1;
	readonly tavily_operation_id: string;
	readonly tavily_ref_id: string;
	readonly tavily_title: string;
	readonly tavily_title_truncated: boolean;
	readonly tavily_url: string;
	readonly tavily_title_source: TitleSource;
	readonly tavily_mode: OpenMode;
	readonly tavily_coverage: Coverage;
	readonly tavily_page: number;
	readonly tavily_has_more: boolean;
	readonly tavily_character_count: number;
	readonly tavily_retrieval_mode: RetrievalMode;
	readonly tavily_retrieved_at: string;
	readonly tavily_cache_age_seconds?: number;
	readonly tavily_duration_ms: number;
	readonly tavily_usage_credits: number;
	readonly tavily_usage_estimated: boolean;
	readonly tavily_credit_contract_overrun: boolean;
	readonly tavily_url_changed: boolean;
	readonly tavily_document_truncated: boolean;
	readonly tavily_next_cursor?: string;
	readonly tavily_rendered_content: string;
}

export interface RuntimeDependencies {
	readonly getAgentDir: () => string;
	readonly defaultsConfigPath: string;
	readonly withFileMutationQueue: <T>(path: string, mutation: () => Promise<T>) => Promise<T>;
	readonly fetch: typeof globalThis.fetch;
	readonly now: () => number;
	readonly randomId: () => string;
	readonly readApiKey: () => string | undefined;
	readonly retryEnabled: boolean;
}

export interface ToolExecutionEnvironment {
	readonly context: ExtensionContext;
	readonly signal: AbortSignal | undefined;
	readonly generation: number;
}
