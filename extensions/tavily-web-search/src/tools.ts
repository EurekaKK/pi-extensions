import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentToolResult, SessionEntry, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Static } from "typebox";
import { Type } from "typebox";
import type { TavilyBudgetLedger } from "./budgets.js";
import {
	BoundedTtlLruCache,
	CancelableInFlightRegistry,
	estimateCacheEntryWeight,
	FifoSemaphore,
	QueueAbortedError,
	QueueDeadlineExceededError,
	SemaphoreClosedError,
} from "./cache.js";
import {
	ADVANCED_EXTRACT_OVERALL_DEADLINE_MS,
	BASIC_EXTRACT_OVERALL_DEADLINE_MS,
	OPEN_DESCRIPTION,
	OPEN_PROMPT_GUIDELINES,
	OPEN_PROMPT_SNIPPET,
	OPEN_TOOL_NAME,
	SEARCH_DESCRIPTION,
	SEARCH_OVERALL_DEADLINE_MS,
	SEARCH_PROMPT_GUIDELINES,
	SEARCH_PROMPT_SNIPPET,
	SEARCH_TOOL_NAME,
} from "./constants.js";
import {
	createEffectiveDomainPolicy,
	parseCallDomainPatterns,
	parseDomainPattern,
	tavilyDomainPushdown,
} from "./domains.js";
import { disabledError, normalizeToolError, type TavilyTool, TavilyToolError } from "./errors.js";
import {
	buildFocusedEnvelope,
	buildOpenEnvelope,
	buildSearchEnvelope,
	cleanSnippet,
	cleanTitle,
	codePointLength,
	createDocumentBlocks,
	normalizeDocument,
	normalizeToolText,
	paginateBlocks,
	refFromUnknownDetails,
	sanitizeExternalText,
} from "./output.js";
import { renderOpenCall, renderOpenResult, renderSearchCall, renderSearchResult } from "./renderers.js";
import {
	type NetworkGate,
	type NetworkPermit,
	TavilyClient,
	type TavilyClientDependencies,
	type TavilyResponse,
} from "./tavily.js";
import type {
	Coverage,
	CursorRecord,
	EffectiveDomainPolicy,
	ExtractSnapshot,
	ExtractTransportSnapshot,
	NormalizedUrl,
	OpenInput,
	OpenMode,
	OpenToolDetails,
	PersistedCandidateDetails,
	PersistedRefDetails,
	RefRecord,
	RetrievalMode,
	RuntimeDependencies,
	SearchCandidate,
	SearchDiagnostics,
	SearchFreshness,
	SearchInput,
	SearchRecency,
	SearchSnapshot,
	SearchToolDetails,
	TavilyWebSearchConfig,
} from "./types.js";
import { normalizePublicUrl, UrlAdmissionError } from "./urls.js";

const SEARCH_PARAMETERS = Type.Object(
	{
		query: Type.String({ minLength: 1, maxLength: 512 }),
		include_domains: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 20 })),
		exclude_domains: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 20 })),
		recency: Type.Optional(StringEnum(["day", "week", "month", "year"] as const)),
		freshness: Type.Optional(StringEnum(["cache_ok", "live"] as const)),
	},
	{ additionalProperties: false },
);

const OPEN_PARAMETERS = Type.Object(
	{
		ref_id: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
		mode: Type.Optional(StringEnum(["focused", "full"] as const)),
		focus: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
		cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
	},
	{ additionalProperties: false },
);

export type SearchParameters = typeof SEARCH_PARAMETERS;
export type OpenParameters = typeof OPEN_PARAMETERS;

interface DraftCandidate {
	readonly sourceIndex: number;
	readonly title: string;
	readonly titleTruncated: boolean;
	readonly url: string;
	readonly hostname: string;
	readonly snippet: string;
	readonly snippetTruncated: boolean;
	readonly contentTruncated: boolean;
	readonly score?: number;
}

interface SearchCacheValue {
	readonly kind: "search";
	readonly snapshot: SearchSnapshot;
}

interface ExtractCacheValue {
	readonly kind: "extract";
	readonly snapshot: ExtractTransportSnapshot;
}

interface FullCacheValue {
	readonly kind: "full";
	readonly snapshot: Omit<ExtractSnapshot, "content">;
	readonly pages: readonly (readonly { readonly id: string; readonly text: string }[])[];
	readonly cursors: readonly string[];
}

type CacheValue = SearchCacheValue | ExtractCacheValue | FullCacheValue;

export type TavilyCircuitReason = "auth" | "quota" | "credit";

export interface TavilyCircuitState {
	read(): "none" | TavilyCircuitReason;
	open(reason: TavilyCircuitReason): void;
}

interface InFlightMetadata {
	readonly networkAdmissionFloor: number;
	readonly generation: number;
}

export interface TavilyToolServiceOptions {
	readonly config: TavilyWebSearchConfig;
	readonly apiKey: string;
	readonly budget: TavilyBudgetLedger;
	readonly dependencies: Pick<RuntimeDependencies, "fetch" | "now" | "randomId" | "retryEnabled">;
	readonly generation: number;
	readonly initialRefs?: readonly RefRecord[];
	readonly initialNextRef?: number;
	readonly circuitState?: TavilyCircuitState;
}

export interface TavilyToolExecutors {
	executeSearch(input: SearchInput, signal: AbortSignal | undefined): Promise<AgentToolResult<unknown>>;
	executeOpen(input: OpenInput, signal: AbortSignal | undefined): Promise<AgentToolResult<unknown>>;
}

export class TavilyToolService implements TavilyToolExecutors {
	readonly config: TavilyWebSearchConfig;
	readonly budget: TavilyBudgetLedger;
	readonly generation: number;
	readonly #apiKey: string;
	readonly #now: () => number;
	readonly #randomId: () => string;
	readonly #client: TavilyClient;
	readonly #semaphore: FifoSemaphore;
	readonly #inFlight = new CancelableInFlightRegistry<string, InFlightMetadata, CacheValue>();
	readonly #cache: BoundedTtlLruCache<string, CacheValue>;
	readonly #refs = new Map<string, RefRecord>();
	readonly #cursors = new Map<string, CursorRecord>();
	readonly #lifecycleController = new AbortController();
	readonly #configIdentity: string;
	readonly #circuitState: TavilyCircuitState;
	#nextRef = 1;
	#closed = false;
	#localCircuit: "none" | TavilyCircuitReason = "none";

	constructor(options: TavilyToolServiceOptions) {
		this.config = options.config;
		this.budget = options.budget;
		this.generation = options.generation;
		this.#apiKey = options.apiKey;
		this.#now = options.dependencies.now;
		this.#randomId = options.dependencies.randomId;
		this.#client = new TavilyClient(options.dependencies satisfies TavilyClientDependencies);
		this.#semaphore = new FifoSemaphore(options.config.budgets.maxConcurrency, options.dependencies.now);
		this.#configIdentity = JSON.stringify(options.config);
		this.#circuitState =
			options.circuitState ??
			Object.freeze({
				read: () => this.#localCircuit,
				open: (reason: TavilyCircuitReason) => {
					if (this.#localCircuit === "none") this.#localCircuit = reason;
				},
			});
		this.#cache = new BoundedTtlLruCache({
			maxWeight: options.config.cache.maxBytes,
			now: options.dependencies.now,
			onEvict: ({ key }) => this.#expireCursorsForSnapshot(key),
		});
		for (const ref of options.initialRefs ?? []) {
			this.#refs.set(ref.refId, ref);
			this.#nextRef = Math.max(this.#nextRef, refNumber(ref.refId) + 1);
		}
		if (options.initialNextRef !== undefined && Number.isSafeInteger(options.initialNextRef)) {
			this.#nextRef = Math.max(this.#nextRef, options.initialNextRef);
		}
	}

	async executeSearch(input: SearchInput, signal: AbortSignal | undefined): Promise<AgentToolResult<unknown>> {
		this.#assertOpen("search");
		const startedAt = this.#now();
		const admission = await this.budget.commitToolCall("search");
		const query = normalizeToolText(input.query, "query");
		const freshness = input.freshness ?? "cache_ok";
		if (freshness !== "cache_ok" && freshness !== "live") {
			throw invalidArguments("search", "freshness must be cache_ok or live.");
		}
		const recency = validateRecency(input.recency);
		const callAllow = parseCallDomainPatterns(input.include_domains, "include_domains");
		const callDeny = parseCallDomainPatterns(input.exclude_domains, "exclude_domains");
		const policy = createEffectiveDomainPolicy(
			this.config.domains.allow,
			this.config.domains.deny,
			callAllow,
			callDeny,
		);
		const pushdown = tavilyDomainPushdown(policy);
		const maxResults = pushdown.needsOverfetch
			? Math.min(20, this.config.retrieval.maxSearchResults * 2)
			: this.config.retrieval.maxSearchResults;
		const cacheKey = this.#searchCacheKey(query, policy, recency, maxResults);

		if (freshness === "cache_ok") {
			const hit = this.#cache.get(cacheKey);
			if (hit?.value.kind === "search") {
				return this.#searchResult(
					hit.value.snapshot,
					admission.operationId,
					"cache",
					Math.floor(hit.ageMs / 1_000),
					Math.max(0, this.#now() - startedAt),
					0,
					false,
					false,
				);
			}
		}

		this.#assertRefCapacity(maxResults);
		this.#assertNetworkAllowed("search");
		const deadline = createDeadlineSignal(
			signal,
			this.#lifecycleController.signal,
			Math.max(0, SEARCH_OVERALL_DEADLINE_MS - (this.#now() - startedAt)),
			"search",
			this.#now,
		);
		try {
			const requestFloor = this.#now();
			const value = await this.#inFlight.run(
				cacheKey,
				{
					metadata: { networkAdmissionFloor: requestFloor, generation: this.generation },
					signal: deadline.signal,
					joinExisting: freshness === "cache_ok",
					acceptJoiners: freshness === "cache_ok",
					canJoin: (metadata) => metadata.generation === this.generation,
				},
				async (sharedSignal) => {
					this.#assertGeneration("search");
					let response: TavilyResponse;
					try {
						response = await this.#client.search(
							{
								query,
								searchDepth: this.config.retrieval.searchDepth,
								maxResults,
								includeDomains: pushdown.includeDomains,
								excludeDomains: pushdown.excludeDomains,
								...(recency === undefined ? {} : { recency }),
							},
							this.#requestContext(admission.operationId, "search", sharedSignal, deadline.deadlineAt),
						);
					} catch (error) {
						this.#applyCircuitFromError(error);
						throw error;
					}
					this.#assertGeneration("search", sharedSignal);
					this.#applyCircuitFromResponse(response);
					const snapshot = this.#parseSearchSnapshot(response, query, freshness, policy);
					const cacheValue: SearchCacheValue = { kind: "search", snapshot };
					this.#storeSearchCache(cacheKey, cacheValue);
					return cacheValue;
				},
			);
			if (value.kind !== "search") throw internalError("search");
			return this.#searchResult(
				value.snapshot,
				admission.operationId,
				"live",
				undefined,
				Math.max(0, this.#now() - startedAt),
				value.snapshot.usageCredits,
				value.snapshot.usageEstimated,
				value.snapshot.creditContractOverrun,
			);
		} catch (error) {
			this.#applyCircuitFromError(error);
			throw normalizeServiceError("search", error, deadline);
		} finally {
			deadline.dispose();
		}
	}

	async executeOpen(input: OpenInput, signal: AbortSignal | undefined): Promise<AgentToolResult<unknown>> {
		this.#assertOpen("open");
		const startedAt = this.#now();
		const admission = await this.budget.commitToolCall("open");
		const parsed = validateOpenInput(input);
		if (parsed.kind === "cursor") {
			return this.#openCursor(parsed.cursor, admission.operationId, startedAt);
		}

		const ref = this.#refs.get(parsed.refId);
		if (!ref) {
			throw new TavilyToolError(
				"open",
				"tavily_ref_not_found",
				"search_again",
				"The ref does not exist on the current session branch. Search again.",
			);
		}
		const mode = parsed.mode;
		const effectiveFocus = mode === "focused" ? (parsed.focus ?? ref.originatingQuery) : undefined;
		const policy = this.#policyForRef(ref);
		const target = normalizePublicUrl(ref.url, policy);
		this.#assertOpenMetadataRepresentable(ref, target, mode, effectiveFocus);
		const cacheKey = this.#extractCacheKey(target.url, mode, effectiveFocus, policy);
		const fullViewKey = mode === "full" ? this.#fullViewCacheKey(cacheKey, ref.refId) : undefined;
		const freshness = {
			...(ref.freshnessNotBefore === undefined ? {} : { freshnessNotBefore: ref.freshnessNotBefore }),
		};
		if (fullViewKey !== undefined) {
			const viewHit = this.#cache.get(fullViewKey, freshness);
			if (viewHit?.value.kind === "full") {
				return this.#fullPageResult(
					viewHit.value,
					0,
					admission.operationId,
					"cache",
					Math.floor(viewHit.ageMs / 1_000),
					Math.max(0, this.#now() - startedAt),
					0,
					false,
					false,
				);
			}
		}
		const hit = this.#cache.get(cacheKey, freshness);
		if (hit?.value.kind === "extract") {
			return this.#openResultFromTransport(
				hit.value.snapshot,
				ref,
				fullViewKey,
				admission.operationId,
				"cache",
				Math.floor(hit.ageMs / 1_000),
				Math.max(0, this.#now() - startedAt),
				Math.max(1, hit.expiresAt - this.#now()),
			);
		}

		this.#assertNetworkAllowed("open");
		const overallDeadline =
			this.config.retrieval.extractDepth === "advanced"
				? ADVANCED_EXTRACT_OVERALL_DEADLINE_MS
				: BASIC_EXTRACT_OVERALL_DEADLINE_MS;
		const deadline = createDeadlineSignal(
			signal,
			this.#lifecycleController.signal,
			Math.max(0, overallDeadline - (this.#now() - startedAt)),
			"open",
			this.#now,
		);
		try {
			const requestFloor = this.#now();
			const value = await this.#inFlight.run(
				cacheKey,
				{
					metadata: { networkAdmissionFloor: requestFloor, generation: this.generation },
					signal: deadline.signal,
					canJoin: (metadata) =>
						metadata.generation === this.generation &&
						(ref.freshnessNotBefore === undefined || metadata.networkAdmissionFloor >= ref.freshnessNotBefore),
				},
				async (sharedSignal) => {
					this.#assertGeneration("open", sharedSignal);
					let response: TavilyResponse;
					try {
						response = await this.#client.extract(
							{
								url: target.url,
								extractDepth: this.config.retrieval.extractDepth,
								mode,
								...(effectiveFocus === undefined ? {} : { focus: effectiveFocus }),
							},
							this.#requestContext(admission.operationId, "open", sharedSignal, deadline.deadlineAt),
						);
					} catch (error) {
						this.#applyCircuitFromError(error);
						throw error;
					}
					this.#assertGeneration("open", sharedSignal);
					this.#applyCircuitFromResponse(response);
					const snapshot = parseTavilyExtractResponse(response, target.url, mode, effectiveFocus, policy, this.config);
					const cacheValue: ExtractCacheValue = { kind: "extract", snapshot };
					this.#storeExtractCache(cacheKey, cacheValue);
					return cacheValue;
				},
			);
			if (value.kind !== "extract") throw internalError("open");
			return this.#openResultFromTransport(
				value.snapshot,
				ref,
				fullViewKey,
				admission.operationId,
				"live",
				undefined,
				Math.max(0, this.#now() - startedAt),
				this.config.cache.extractTtlSeconds * 1_000,
			);
		} catch (error) {
			this.#applyCircuitFromError(error);
			throw normalizeServiceError("open", error, deadline);
		} finally {
			deadline.dispose();
		}
	}

	shutdown(): void {
		if (this.#closed) return;
		this.#closed = true;
		const reason = new Error("The Tavily lifecycle ended.");
		this.#lifecycleController.abort(reason);
		this.#inFlight.close(reason);
		this.#semaphore.close(reason);
		this.#cache.clear();
		this.#refs.clear();
		this.#cursors.clear();
	}

	get refs(): readonly RefRecord[] {
		return [...this.#refs.values()];
	}

	#requestContext(
		operationId: string,
		tool: TavilyTool,
		signal: AbortSignal,
		deadlineAt: number,
	): Parameters<TavilyClient["search"]>[1] {
		return {
			operationId,
			apiKey: this.#apiKey,
			depth: tool === "search" ? this.config.retrieval.searchDepth : this.config.retrieval.extractDepth,
			signal,
			deadlineAt,
			gate: this.#networkGate(tool),
			budget: this.budget,
			finalAdmissionCheck: () => {
				this.#assertGeneration(tool, signal);
				this.#assertNetworkAllowed(tool);
			},
			onCreditContractOverrun: () => this.#openCircuit("credit"),
		};
	}

	#networkGate(tool: TavilyTool): NetworkGate {
		return {
			acquire: async (signal, deadlineAt): Promise<NetworkPermit> => {
				try {
					return await this.#semaphore.acquire({ ...(signal === undefined ? {} : { signal }), deadlineAt });
				} catch (error) {
					if (error instanceof QueueDeadlineExceededError) {
						throw new TavilyToolError(
							tool,
							"tavily_request_timeout",
							"stop_turn",
							"The Tavily queue deadline expired.",
						);
					}
					if (error instanceof QueueAbortedError || error instanceof SemaphoreClosedError || signal?.aborted) {
						throw new TavilyToolError(tool, "tavily_request_aborted", "stop_turn", "The Tavily request was cancelled.");
					}
					throw error;
				}
			},
		};
	}

	#parseSearchSnapshot(
		response: TavilyResponse,
		query: string,
		freshness: SearchFreshness,
		policy: EffectiveDomainPolicy,
	): SearchSnapshot {
		const parsed = parseTavilySearchResponse(response.body, policy, this.config.retrieval.maxSearchResults);
		this.#assertRefCapacity(parsed.candidates.length);
		const provisional = parsed.candidates.map((candidate, index) => {
			const refId = `tavily_ref_${this.#nextRef + index}`;
			return { ...candidate, refId, rank: index + 1 } satisfies SearchCandidate;
		});
		this.#nextRef += provisional.length;
		const envelope = buildSearchEnvelope({
			candidates: provisional,
			retrievalMode: "live",
			retrievedAt: response.retrievedAt,
			maxCharacters: this.config.retrieval.maxOutputCharacters,
		});
		const acceptedIds = new Set(envelope.candidates.map((candidate) => candidate.refId));
		const candidates = provisional.filter((candidate) => acceptedIds.has(candidate.refId));
		const refs = candidates.map((candidate) =>
			Object.freeze({
				...candidate,
				originatingQuery: query,
				retrievedAt: response.retrievedAt,
				freshness,
				...(freshness === "live" ? { freshnessNotBefore: response.networkAdmissionAt } : {}),
				policyAllow: Object.freeze([...policy.canonicalAllow]),
				policyDeny: Object.freeze([...policy.canonicalDeny]),
			}),
		);
		for (const ref of refs) this.#refs.set(ref.refId, ref);
		return Object.freeze({
			candidates: Object.freeze(candidates),
			refs: Object.freeze(refs),
			retrievedAt: response.retrievedAt,
			networkAdmissionAt: response.networkAdmissionAt,
			query,
			freshness,
			rootContentTruncated: envelope.contentTruncated,
			usageCredits: response.credits,
			usageEstimated: response.usageEstimated,
			creditContractOverrun: response.creditContractOverrun,
			diagnostics: Object.freeze({ ...parsed.diagnostics, returnedResults: candidates.length }),
		});
	}

	#searchResult(
		snapshot: SearchSnapshot,
		operationId: string,
		retrievalMode: "live" | "cache",
		cacheAgeSeconds: number | undefined,
		durationMs: number,
		usageCredits: number,
		usageEstimated: boolean,
		creditContractOverrun: boolean,
	): AgentToolResult<unknown> {
		const envelope = buildSearchEnvelope({
			candidates: snapshot.candidates,
			retrievalMode,
			retrievedAt: snapshot.retrievedAt,
			...(cacheAgeSeconds === undefined ? {} : { cacheAgeSeconds }),
			maxCharacters: this.config.retrieval.maxOutputCharacters,
			forceContentTruncated: snapshot.rootContentTruncated,
		});
		const visibleIds = new Set(envelope.candidates.map((candidate) => candidate.refId));
		const visibleRefs = snapshot.refs.filter((ref) => visibleIds.has(ref.refId));
		const details: SearchToolDetails = {
			tavily_details_version: 1,
			tavily_operation_id: operationId,
			tavily_query: snapshot.query,
			tavily_retrieval_mode: retrievalMode,
			tavily_retrieved_at: snapshot.retrievedAt,
			...(cacheAgeSeconds === undefined ? {} : { tavily_cache_age_seconds: cacheAgeSeconds }),
			tavily_duration_ms: durationMs,
			tavily_usage_credits: usageCredits,
			tavily_usage_estimated: usageEstimated,
			tavily_credit_contract_overrun: creditContractOverrun,
			tavily_candidate_count: envelope.candidates.length,
			tavily_candidates: envelope.candidates.map(serializeCandidate),
			tavily_refs: visibleRefs.map(serializeRef),
			tavily_input_result_count: snapshot.diagnostics.inputResults,
			tavily_malformed_result_count: snapshot.diagnostics.malformedResults,
			tavily_rejected_url_count: snapshot.diagnostics.rejectedUrls,
			tavily_policy_rejected_count: snapshot.diagnostics.policyRejected,
			tavily_duplicate_count: snapshot.diagnostics.duplicates,
		};
		return { content: [{ type: "text", text: envelope.content }], details };
	}

	#openCursor(cursor: string, operationId: string, startedAt: number): AgentToolResult<unknown> {
		if (!/^tavily_cursor_[A-Za-z0-9_-]{16,128}$/u.test(cursor)) {
			throw new TavilyToolError("open", "tavily_cursor_invalid", "fix_call", "The Tavily cursor format is invalid.");
		}
		const record = this.#cursors.get(cursor);
		if (!record || record.generation !== this.generation || this.#now() >= record.expiresAt) {
			throw cursorExpiredError();
		}
		const hit = this.#cache.get(record.snapshotKey);
		if (hit?.value.kind !== "full") {
			this.#cursors.delete(cursor);
			throw cursorExpiredError();
		}
		return this.#fullPageResult(
			hit.value,
			record.pageIndex,
			operationId,
			"cursor",
			undefined,
			Math.max(0, this.#now() - startedAt),
			0,
			false,
			false,
		);
	}

	#openResultFromTransport(
		transport: ExtractTransportSnapshot,
		ref: RefRecord,
		fullViewKey: string | undefined,
		operationId: string,
		retrievalMode: "live" | "cache",
		cacheAgeSeconds: number | undefined,
		durationMs: number,
		viewTtlMs: number,
	): AgentToolResult<unknown> {
		const snapshot = materializeExtractSnapshot(transport, ref);
		const credits = retrievalMode === "cache" ? 0 : snapshot.usageCredits;
		const estimated = retrievalMode === "cache" ? false : snapshot.usageEstimated;
		const overrun = retrievalMode === "cache" ? false : snapshot.creditContractOverrun;
		if (snapshot.mode === "full") {
			if (fullViewKey === undefined) throw internalError("open");
			const existing = this.#cache.get(fullViewKey, {
				...(ref.freshnessNotBefore === undefined ? {} : { freshnessNotBefore: ref.freshnessNotBefore }),
			});
			if (existing?.value.kind === "full") {
				return this.#fullPageResult(
					existing.value,
					0,
					operationId,
					retrievalMode,
					cacheAgeSeconds,
					durationMs,
					credits,
					estimated,
					overrun,
				);
			}
			const value = this.#prepareFullCacheValue(snapshot);
			if (!this.#storeFullCache(fullViewKey, value, viewTtlMs) && value.pages.length > 1) {
				throw new TavilyToolError(
					"open",
					"tavily_response_too_large",
					"stop_turn",
					"The full Tavily snapshot cannot fit the configured bounded cache.",
				);
			}
			return this.#fullPageResult(
				value,
				0,
				operationId,
				retrievalMode,
				cacheAgeSeconds,
				durationMs,
				credits,
				estimated,
				overrun,
			);
		}
		const envelope = buildFocusedEnvelope(
			{
				refId: snapshot.refId,
				title: snapshot.title,
				titleSource: snapshot.titleSource,
				url: snapshot.url,
				mode: "focused",
				coverage: "focused_partial",
				retrievalMode,
				retrievedAt: snapshot.retrievedAt,
				...(cacheAgeSeconds === undefined ? {} : { cacheAgeSeconds }),
				effectiveFocus: snapshot.effectiveFocus ?? "",
			},
			snapshot.content,
			this.config.retrieval.maxOutputCharacters,
			snapshot.titleTruncated,
		);
		const details = this.#openDetails(
			snapshot,
			operationId,
			1,
			false,
			retrievalMode,
			cacheAgeSeconds,
			durationMs,
			credits,
			estimated,
			overrun,
			envelope.renderedContent,
			undefined,
		);
		return { content: [{ type: "text", text: envelope.content }], details };
	}

	#fullPageResult(
		value: FullCacheValue,
		pageIndex: number,
		operationId: string,
		retrievalMode: RetrievalMode,
		cacheAgeSeconds: number | undefined,
		durationMs: number,
		credits: number,
		estimated: boolean,
		overrun: boolean,
	): AgentToolResult<unknown> {
		const blocks = value.pages[pageIndex];
		if (!blocks) throw cursorExpiredError();
		const hasMore = pageIndex + 1 < value.pages.length;
		const nextCursor = hasMore ? value.cursors[pageIndex] : undefined;
		const content = buildOpenEnvelope({
			refId: value.snapshot.refId,
			title: value.snapshot.title,
			titleSource: value.snapshot.titleSource,
			url: value.snapshot.url,
			mode: "full",
			coverage: value.snapshot.coverage,
			retrievalMode,
			retrievedAt: value.snapshot.retrievedAt,
			...(cacheAgeSeconds === undefined ? {} : { cacheAgeSeconds }),
			page: pageIndex + 1,
			hasMore,
			contentTruncated: value.snapshot.titleTruncated,
			documentTruncated: value.snapshot.documentTruncated,
			blocks,
			...(nextCursor === undefined ? {} : { nextCursor }),
		});
		const renderedContent = blocks.map((block) => block.text).join("\n\n");
		const details = this.#openDetails(
			value.snapshot,
			operationId,
			pageIndex + 1,
			hasMore,
			retrievalMode,
			cacheAgeSeconds,
			durationMs,
			credits,
			estimated,
			overrun,
			renderedContent,
			nextCursor,
		);
		return { content: [{ type: "text", text: content }], details };
	}

	#openDetails(
		snapshot: Omit<ExtractSnapshot, "content">,
		operationId: string,
		page: number,
		hasMore: boolean,
		retrievalMode: RetrievalMode,
		cacheAgeSeconds: number | undefined,
		durationMs: number,
		usageCredits: number,
		usageEstimated: boolean,
		creditContractOverrun: boolean,
		renderedContent: string,
		nextCursor: string | undefined,
	): OpenToolDetails {
		return {
			tavily_details_version: 1,
			tavily_operation_id: operationId,
			tavily_ref_id: snapshot.refId,
			tavily_title: snapshot.title,
			tavily_title_truncated: snapshot.titleTruncated,
			tavily_url: snapshot.url,
			tavily_title_source: snapshot.titleSource,
			tavily_mode: snapshot.mode,
			tavily_coverage: snapshot.coverage,
			tavily_page: page,
			tavily_has_more: hasMore,
			tavily_character_count: codePointLength(renderedContent),
			tavily_retrieval_mode: retrievalMode,
			tavily_retrieved_at: snapshot.retrievedAt,
			...(cacheAgeSeconds === undefined ? {} : { tavily_cache_age_seconds: cacheAgeSeconds }),
			tavily_duration_ms: durationMs,
			tavily_usage_credits: usageCredits,
			tavily_usage_estimated: usageEstimated,
			tavily_credit_contract_overrun: creditContractOverrun,
			tavily_url_changed: snapshot.urlChanged,
			tavily_document_truncated: snapshot.documentTruncated,
			...(nextCursor === undefined ? {} : { tavily_next_cursor: nextCursor }),
			tavily_rendered_content: renderedContent,
		};
	}

	#prepareFullCacheValue(snapshot: ExtractSnapshot): FullCacheValue {
		if (snapshot.mode !== "full") throw internalError("open");
		const emptyBase = {
			refId: snapshot.refId,
			title: snapshot.title,
			titleSource: snapshot.titleSource,
			url: snapshot.url,
			mode: "full" as const,
			coverage: snapshot.coverage,
			retrievalMode: "cache" as const,
			retrievedAt: snapshot.retrievedAt,
			cacheAgeSeconds: 2_147_483_647,
			contentTruncated: snapshot.titleTruncated,
			documentTruncated: snapshot.documentTruncated,
		};
		const blockLimit = maximumSafeBlockCharacters(emptyBase, this.config.retrieval.maxOutputCharacters);
		const blocks = createDocumentBlocks(snapshot.refId, snapshot.content, blockLimit);
		const reservedCursors = new Set<string>();
		const provisionalCursors = blocks.map(() => {
			const cursor = this.#allocateCursor(reservedCursors);
			reservedCursors.add(cursor);
			return cursor;
		});
		const pages = paginateBlocks(emptyBase, blocks, this.config.retrieval.maxOutputCharacters, provisionalCursors);
		const cursors = provisionalCursors.slice(0, Math.max(0, pages.length - 1));
		return { kind: "full", snapshot: extractSnapshotMetadata(snapshot), pages, cursors };
	}

	#storeSearchCache(key: string, value: SearchCacheValue): void {
		if (this.config.cache.searchTtlSeconds === 0) return;
		this.#cache.set(key, value, {
			ttlMs: this.config.cache.searchTtlSeconds * 1_000,
			weight: estimateSearchWeight(key, value.snapshot),
			retrievedAt: Date.parse(value.snapshot.retrievedAt),
			networkAdmissionAt: value.snapshot.networkAdmissionAt,
		});
	}

	#storeExtractCache(key: string, value: ExtractCacheValue): void {
		this.#cache.set(key, value, {
			ttlMs: this.config.cache.extractTtlSeconds * 1_000,
			weight: estimateExtractWeight(key, value.snapshot),
			retrievedAt: Date.parse(value.snapshot.retrievedAt),
			networkAdmissionAt: value.snapshot.networkAdmissionAt,
		});
	}

	#storeFullCache(key: string, value: FullCacheValue, ttlMs: number): boolean {
		const safeTtlMs = Math.max(1, Math.min(ttlMs, this.config.cache.extractTtlSeconds * 1_000));
		const expiresAt = this.#now() + safeTtlMs;
		const inserted = this.#cache.set(key, value, {
			ttlMs: safeTtlMs,
			weight: estimateFullWeight(key, value),
			retrievedAt: Date.parse(value.snapshot.retrievedAt),
			networkAdmissionAt: value.snapshot.networkAdmissionAt,
		});
		if (inserted) this.#registerCursors(key, value, expiresAt);
		else this.#expireCursorsForSnapshot(key);
		return inserted;
	}

	#searchCacheKey(
		query: string,
		policy: EffectiveDomainPolicy,
		recency: SearchRecency | undefined,
		maxResults: number,
	): string {
		return `search:${JSON.stringify({ query, allow: policy.canonicalAllow, deny: policy.canonicalDeny, recency, depth: this.config.retrieval.searchDepth, maxResults, returnLimit: this.config.retrieval.maxSearchResults, output: this.config.retrieval.maxOutputCharacters, config: this.#configIdentity })}`;
	}

	#extractCacheKey(url: string, mode: OpenMode, focus: string | undefined, policy: EffectiveDomainPolicy): string {
		return `extract:${JSON.stringify({ url, mode, focus, allow: policy.canonicalAllow, deny: policy.canonicalDeny, depth: this.config.retrieval.extractDepth, output: this.config.retrieval.maxOutputCharacters, documentBytes: this.config.retrieval.maxDocumentBytes, config: this.#configIdentity })}`;
	}

	#fullViewCacheKey(extractKey: string, refId: string): string {
		return `full-view:${JSON.stringify({ extractKey, refId })}`;
	}

	#policyForRef(ref: RefRecord): EffectiveDomainPolicy {
		const storedAllow = ref.policyAllow.map(parseDomainPattern);
		const storedDeny = ref.policyDeny.map(parseDomainPattern);
		return createEffectiveDomainPolicy(this.config.domains.allow, this.config.domains.deny, storedAllow, storedDeny);
	}

	#assertOpenMetadataRepresentable(
		ref: RefRecord,
		target: NormalizedUrl,
		mode: OpenMode,
		effectiveFocus: string | undefined,
	): void {
		const base = {
			refId: ref.refId,
			title: ref.title,
			titleSource: "search_ref" as const,
			url: target.url,
			mode,
			coverage: mode === "focused" ? ("focused_partial" as const) : ("snapshot_complete" as const),
			retrievalMode: "cache" as const,
			retrievedAt: ref.retrievedAt,
			cacheAgeSeconds: 2_147_483_647,
			page: 1,
			hasMore: mode === "full",
			contentTruncated: ref.titleTruncated,
			documentTruncated: false,
			...(mode === "focused" ? { effectiveFocus: effectiveFocus ?? "" } : {}),
			blocks: [{ id: `${ref.refId}:b${Number.MAX_SAFE_INTEGER}`, text: "&".repeat(64) }],
			...(mode === "full" ? { nextCursor: `tavily_cursor_${"x".repeat(128)}` } : {}),
		};
		if (codePointLength(buildOpenEnvelope(base)) > this.config.retrieval.maxOutputCharacters) {
			throw new TavilyToolError(
				"open",
				"tavily_content_unavailable",
				"search_again",
				"The stored source metadata cannot fit the configured output limit. Search again for another source.",
			);
		}
	}

	#allocateCursor(reserved: ReadonlySet<string> = new Set()): string {
		for (let attempt = 0; attempt < 32; attempt += 1) {
			const suffix = this.#randomId().replace(/[^A-Za-z0-9_-]/gu, "");
			if (suffix.length < 16 || suffix.length > 128) throw new Error("Invalid Tavily cursor random source.");
			const cursor = `tavily_cursor_${suffix}`;
			if (!this.#cursors.has(cursor) && !reserved.has(cursor)) return cursor;
		}
		throw new Error("Unable to allocate a unique Tavily cursor.");
	}

	#expireCursorsForSnapshot(snapshotKey: string): void {
		for (const [cursor, record] of this.#cursors) {
			if (record.snapshotKey === snapshotKey) this.#cursors.delete(cursor);
		}
	}

	#registerCursors(snapshotKey: string, value: FullCacheValue, expiresAt: number): void {
		for (let index = 0; index < value.cursors.length; index += 1) {
			const cursor = value.cursors[index];
			if (!cursor) continue;
			this.#cursors.set(cursor, {
				cursor,
				snapshotKey,
				refId: value.snapshot.refId,
				pageIndex: index + 1,
				expiresAt,
				generation: this.generation,
			});
		}
	}

	#assertOpen(tool: TavilyTool): void {
		if (this.#closed) throw disabledError(tool);
	}

	#assertRefCapacity(count: number): void {
		if (
			!Number.isSafeInteger(this.#nextRef) ||
			!Number.isSafeInteger(count) ||
			count < 0 ||
			this.#nextRef > Number.MAX_SAFE_INTEGER - count
		) {
			throw new TavilyToolError(
				"search",
				"tavily_internal_error",
				"stop_turn",
				"The session has exhausted its safe Tavily ref identifier range.",
			);
		}
	}

	#assertGeneration(tool: TavilyTool, signal?: AbortSignal): void {
		if (this.#closed || this.#lifecycleController.signal.aborted || signal?.aborted) {
			throw new TavilyToolError(tool, "tavily_request_aborted", "stop_turn", "The Tavily lifecycle changed.");
		}
	}

	#assertNetworkAllowed(tool: TavilyTool): void {
		const circuit = this.#circuitState.read();
		if (circuit === "none") return;
		if (circuit === "auth") {
			throw new TavilyToolError(
				tool,
				"tavily_auth_failed",
				"ask_user",
				"Tavily networking is offline after a credential failure. Restart Pi after fixing TAVILY_API_KEY.",
			);
		}
		if (circuit === "quota") {
			throw new TavilyToolError(
				tool,
				"tavily_quota_exhausted",
				"ask_user",
				"Tavily networking is offline because the account quota is exhausted.",
			);
		}
		throw new TavilyToolError(
			tool,
			"tavily_credit_budget_exhausted",
			"stop_turn",
			"Tavily networking is offline after a supplier credit contract overrun.",
		);
	}

	#applyCircuitFromError(error: unknown): void {
		if (!(error instanceof TavilyToolError)) return;
		if (error.code === "tavily_auth_failed") this.#openCircuit("auth");
		if (error.code === "tavily_quota_exhausted") this.#openCircuit("quota");
	}

	#applyCircuitFromResponse(response: TavilyResponse): void {
		if (response.creditContractOverrun) this.#openCircuit("credit");
	}

	#openCircuit(reason: "auth" | "quota" | "credit"): void {
		this.#circuitState.open(reason);
	}
}

export function createTavilyToolDefinitions(
	executors: TavilyToolExecutors,
): readonly [ToolDefinition<SearchParameters, unknown>, ToolDefinition<OpenParameters, unknown>] {
	const search: ToolDefinition<SearchParameters, unknown> = {
		name: SEARCH_TOOL_NAME,
		label: "Tavily Search",
		description: SEARCH_DESCRIPTION,
		promptSnippet: SEARCH_PROMPT_SNIPPET,
		promptGuidelines: [...SEARCH_PROMPT_GUIDELINES],
		parameters: SEARCH_PARAMETERS,
		prepareArguments: prepareSearchArguments,
		async execute(_toolCallId, params, signal) {
			try {
				return await executors.executeSearch(params, signal);
			} catch (error) {
				throw normalizeToolError("search", error);
			}
		},
		renderCall: renderSearchCall,
		renderResult: renderSearchResult,
	};
	const open: ToolDefinition<OpenParameters, unknown> = {
		name: OPEN_TOOL_NAME,
		label: "Tavily Open",
		description: OPEN_DESCRIPTION,
		promptSnippet: OPEN_PROMPT_SNIPPET,
		promptGuidelines: [...OPEN_PROMPT_GUIDELINES],
		parameters: OPEN_PARAMETERS,
		prepareArguments: prepareOpenArguments,
		async execute(_toolCallId, params, signal) {
			try {
				return await executors.executeOpen(params, signal);
			} catch (error) {
				throw normalizeToolError("open", error);
			}
		},
		renderCall: renderOpenCall,
		renderResult: renderOpenResult,
	};
	return Object.freeze([Object.freeze(search), Object.freeze(open)]);
}

export function recoverRefsFromBranch(
	entries: readonly SessionEntry[],
	config: TavilyWebSearchConfig,
): { readonly refs: readonly RefRecord[]; readonly nextRef: number } {
	const refs = new Map<string, RefRecord>();
	const conflicts = new Set<string>();
	let nextRef = 1;
	for (const entry of entries) {
		if (
			entry.type !== "message" ||
			entry.message.role !== "toolResult" ||
			entry.message.toolName !== SEARCH_TOOL_NAME
		) {
			continue;
		}
		for (const ref of refFromUnknownDetails(entry.message.details)) {
			const number = refNumber(ref.refId);
			if (number > 0) nextRef = Math.max(nextRef, Math.min(Number.MAX_SAFE_INTEGER, number + 1));
			const validated = revalidateRecoveredRef(ref, config);
			if (!validated || conflicts.has(ref.refId)) continue;
			const existing = refs.get(ref.refId);
			if (existing && JSON.stringify(existing) !== JSON.stringify(validated)) {
				refs.delete(ref.refId);
				conflicts.add(ref.refId);
				continue;
			}
			refs.set(ref.refId, validated);
		}
	}
	return { refs: Object.freeze([...refs.values()]), nextRef };
}

export function parseTavilySearchResponse(
	body: unknown,
	policy: EffectiveDomainPolicy,
	returnLimit: number,
): {
	readonly candidates: readonly Omit<SearchCandidate, "refId" | "rank">[];
	readonly diagnostics: SearchDiagnostics;
} {
	if (!isRecord(body) || !Array.isArray(body.results)) throw protocolError("search");
	if (body.results.length === 0) {
		return {
			candidates: [],
			diagnostics: {
				inputResults: 0,
				malformedResults: 0,
				rejectedUrls: 0,
				policyRejected: 0,
				duplicates: 0,
				returnedResults: 0,
			},
		};
	}

	let malformedResults = 0;
	let rejectedUrls = 0;
	let policyRejected = 0;
	let structurallyValid = 0;
	let duplicates = 0;
	const byUrl = new Map<string, DraftCandidate>();
	for (let index = 0; index < body.results.length; index += 1) {
		const item = body.results[index];
		if (
			!isRecord(item) ||
			typeof item.title !== "string" ||
			typeof item.url !== "string" ||
			typeof item.content !== "string" ||
			(item.score !== undefined && (typeof item.score !== "number" || !Number.isFinite(item.score)))
		) {
			malformedResults += 1;
			continue;
		}
		structurallyValid += 1;
		let normalized: NormalizedUrl;
		try {
			normalized = normalizePublicUrl(item.url, policy);
		} catch (error) {
			if (error instanceof UrlAdmissionError && error.reason === "policy") policyRejected += 1;
			else rejectedUrls += 1;
			continue;
		}
		const title = cleanTitle(item.title, normalized.hostname);
		const snippet = cleanSnippet(item.content);
		const candidate: DraftCandidate = {
			sourceIndex: index,
			title: title.value,
			titleTruncated: title.truncated,
			url: normalized.url,
			hostname: normalized.hostname,
			snippet: snippet.value,
			snippetTruncated: snippet.truncated,
			contentTruncated: title.truncated || snippet.truncated,
			...(item.score === undefined ? {} : { score: item.score }),
		};
		const existing = byUrl.get(candidate.url);
		if (!existing) {
			byUrl.set(candidate.url, candidate);
			continue;
		}
		duplicates += 1;
		if (existing.score !== undefined && candidate.score !== undefined && candidate.score > existing.score) {
			byUrl.set(candidate.url, { ...candidate, sourceIndex: existing.sourceIndex });
		}
	}

	if (structurallyValid === 0) throw protocolError("search");
	if (byUrl.size === 0) {
		throw new TavilyToolError(
			"search",
			"tavily_no_allowed_results",
			"search_again",
			"Tavily returned candidates, but none passed the local URL and domain policy.",
		);
	}
	const candidates = [...byUrl.values()]
		.sort((first, second) => first.sourceIndex - second.sourceIndex)
		.slice(0, returnLimit)
		.map(({ sourceIndex: _sourceIndex, score: _score, ...candidate }) => Object.freeze(candidate));
	return {
		candidates: Object.freeze(candidates),
		diagnostics: {
			inputResults: body.results.length,
			malformedResults,
			rejectedUrls,
			policyRejected,
			duplicates,
			returnedResults: candidates.length,
		},
	};
}

export function parseTavilyExtractResponse(
	response: TavilyResponse,
	requestedUrl: string,
	mode: OpenMode,
	effectiveFocus: string | undefined,
	policy: EffectiveDomainPolicy,
	config: TavilyWebSearchConfig,
): ExtractTransportSnapshot {
	const body = response.body;
	if (!isRecord(body)) throw protocolError("open");
	if (body.results === undefined && Array.isArray(body.failed_results)) throw contentUnavailableError();
	if (!Array.isArray(body.results)) throw protocolError("open");
	const valid: { readonly url: string; readonly hostname: string; readonly content: string }[] = [];
	for (const item of body.results) {
		if (!isRecord(item) || typeof item.url !== "string" || typeof item.raw_content !== "string") continue;
		try {
			const normalized = normalizePublicUrl(item.url, policy);
			const content = sanitizeExternalText(item.raw_content).trim();
			if (content.length > 0) valid.push({ ...normalized, content });
		} catch {
			// A changed Extract URL must pass the same policy before it can be used.
		}
	}
	const exact = valid.find((item) => item.url === requestedUrl);
	const selected = exact ?? (valid.length === 1 ? valid[0] : undefined);
	if (!selected) {
		throw contentUnavailableError();
	}
	const normalized =
		mode === "full"
			? normalizeDocument(selected.content, config.retrieval.maxDocumentBytes)
			: { value: selected.content, truncated: false };
	if (normalized.value.length === 0) {
		throw contentUnavailableError();
	}
	const coverage: Coverage =
		mode === "focused" ? "focused_partial" : normalized.truncated ? "snapshot_truncated" : "snapshot_complete";
	return Object.freeze({
		requestedUrl,
		url: selected.url,
		hostname: selected.hostname,
		content: normalized.value,
		mode,
		coverage,
		...(effectiveFocus === undefined ? {} : { effectiveFocus }),
		retrievedAt: response.retrievedAt,
		networkAdmissionAt: response.networkAdmissionAt,
		documentTruncated: mode === "full" && normalized.truncated,
		usageCredits: response.credits,
		usageEstimated: response.usageEstimated,
		creditContractOverrun: response.creditContractOverrun,
	});
}

function materializeExtractSnapshot(transport: ExtractTransportSnapshot, ref: RefRecord): ExtractSnapshot {
	if (
		transport.requestedUrl !== ref.url ||
		(ref.freshnessNotBefore !== undefined && transport.networkAdmissionAt < ref.freshnessNotBefore)
	) {
		throw internalError("open");
	}
	const urlChanged = transport.url !== ref.url;
	return Object.freeze({
		refId: ref.refId,
		title: urlChanged ? transport.hostname : ref.title,
		titleTruncated: urlChanged ? false : ref.titleTruncated,
		titleSource: urlChanged ? "resolved_hostname" : "search_ref",
		url: transport.url,
		hostname: transport.hostname,
		content: transport.content,
		mode: transport.mode,
		coverage: transport.coverage,
		...(transport.effectiveFocus === undefined ? {} : { effectiveFocus: transport.effectiveFocus }),
		retrievedAt: transport.retrievedAt,
		networkAdmissionAt: transport.networkAdmissionAt,
		documentTruncated: transport.documentTruncated,
		urlChanged,
		usageCredits: transport.usageCredits,
		usageEstimated: transport.usageEstimated,
		creditContractOverrun: transport.creditContractOverrun,
	});
}

function prepareSearchArguments(value: unknown): Static<SearchParameters> {
	if (!isRecord(value)) throw invalidArguments("search", "Arguments must be an object.");
	assertAllowedArgumentKeys(value, ["query", "include_domains", "exclude_domains", "recency", "freshness"], "search");
	if (typeof value.query !== "string") throw invalidArguments("search", "query must be a string.");
	const includeDomains = rawStringArray(value.include_domains, "search", "include_domains");
	const excludeDomains = rawStringArray(value.exclude_domains, "search", "exclude_domains");
	const recency = rawOptionalEnum(value.recency, ["day", "week", "month", "year"], "search", "recency");
	const freshness = rawOptionalEnum(value.freshness, ["cache_ok", "live"], "search", "freshness");
	return {
		query: value.query,
		...(includeDomains === undefined ? {} : { include_domains: [...includeDomains] }),
		...(excludeDomains === undefined ? {} : { exclude_domains: [...excludeDomains] }),
		...(recency === undefined ? {} : { recency }),
		...(freshness === undefined ? {} : { freshness }),
	};
}

function prepareOpenArguments(value: unknown): Static<OpenParameters> {
	if (!isRecord(value)) throw invalidArguments("open", "Arguments must be an object.");
	assertAllowedArgumentKeys(value, ["ref_id", "mode", "focus", "cursor"], "open");
	if (value.ref_id !== undefined && typeof value.ref_id !== "string") {
		throw invalidArguments("open", "ref_id must be a string.");
	}
	if (value.focus !== undefined && typeof value.focus !== "string") {
		throw invalidArguments("open", "focus must be a string.");
	}
	if (value.cursor !== undefined && typeof value.cursor !== "string") {
		throw invalidArguments("open", "cursor must be a string.");
	}
	const mode = rawOptionalEnum(value.mode, ["focused", "full"], "open", "mode");
	return {
		...(value.ref_id === undefined ? {} : { ref_id: value.ref_id }),
		...(mode === undefined ? {} : { mode }),
		...(value.focus === undefined ? {} : { focus: value.focus }),
		...(value.cursor === undefined ? {} : { cursor: value.cursor }),
	};
}

function assertAllowedArgumentKeys(
	value: Readonly<Record<string, unknown>>,
	allowedKeys: readonly string[],
	tool: TavilyTool,
): void {
	const allowed = new Set(allowedKeys);
	const unexpected = Object.keys(value).find((key) => !allowed.has(key));
	if (unexpected !== undefined) {
		throw invalidArguments(tool, `Unexpected argument: ${unexpected}.`);
	}
}

function validateOpenInput(
	input: OpenInput,
):
	| { readonly kind: "cursor"; readonly cursor: string }
	| { readonly kind: "ref"; readonly refId: string; readonly mode: OpenMode; readonly focus?: string } {
	if (input.cursor !== undefined) {
		if (input.ref_id !== undefined || input.mode !== undefined || input.focus !== undefined) {
			throw invalidArguments("open", "cursor must be the only argument.");
		}
		return { kind: "cursor", cursor: input.cursor };
	}
	if (input.ref_id === undefined || !/^tavily_ref_[1-9][0-9]*$/u.test(input.ref_id)) {
		throw invalidArguments("open", "A valid tavily_search ref_id is required.");
	}
	const mode = input.mode ?? "focused";
	if (mode !== "focused" && mode !== "full") throw invalidArguments("open", "mode must be focused or full.");
	if (mode === "full" && input.focus !== undefined) throw invalidArguments("open", "full mode does not accept focus.");
	const focus = input.focus === undefined ? undefined : normalizeToolText(input.focus, "focus");
	return { kind: "ref", refId: input.ref_id, mode, ...(focus === undefined ? {} : { focus }) };
}

function revalidateRecoveredRef(ref: RefRecord, config: TavilyWebSearchConfig): RefRecord | undefined {
	try {
		if (normalizeToolText(ref.originatingQuery, "query") !== ref.originatingQuery) return undefined;
		if (
			!Number.isSafeInteger(ref.rank) ||
			ref.rank < 1 ||
			cleanTitle(ref.title, ref.hostname).value !== ref.title ||
			cleanSnippet(ref.snippet).value !== ref.snippet ||
			ref.contentTruncated !== (ref.titleTruncated || ref.snippetTruncated)
		) {
			return undefined;
		}
		if (!isStrictTimestamp(ref.retrievedAt)) return undefined;
		const retrievedAt = Date.parse(ref.retrievedAt);
		if (
			(ref.freshness === "live") !== (ref.freshnessNotBefore !== undefined) ||
			(ref.freshnessNotBefore !== undefined &&
				(!Number.isSafeInteger(ref.freshnessNotBefore) ||
					ref.freshnessNotBefore < 0 ||
					ref.freshnessNotBefore > retrievedAt))
		) {
			return undefined;
		}
		const storedAllow = ref.policyAllow.map(parseDomainPattern);
		const storedDeny = ref.policyDeny.map(parseDomainPattern);
		if (
			new Set(ref.policyAllow).size !== ref.policyAllow.length ||
			new Set(ref.policyDeny).size !== ref.policyDeny.length ||
			!isSorted(ref.policyAllow) ||
			!isSorted(ref.policyDeny) ||
			storedAllow.some((pattern, index) => pattern.canonical !== ref.policyAllow[index]) ||
			storedDeny.some((pattern, index) => pattern.canonical !== ref.policyDeny[index])
		) {
			return undefined;
		}
		const policy = createEffectiveDomainPolicy(config.domains.allow, config.domains.deny, storedAllow, storedDeny);
		const url = normalizePublicUrl(ref.url, policy);
		if (url.url !== ref.url || url.hostname !== ref.hostname) return undefined;
		return Object.freeze({ ...ref });
	} catch {
		return undefined;
	}
}

function serializeCandidate(candidate: SearchCandidate): PersistedCandidateDetails {
	return {
		tavily_ref_id: candidate.refId,
		tavily_rank: candidate.rank,
		tavily_title: candidate.title,
		tavily_title_truncated: candidate.titleTruncated,
		tavily_url: candidate.url,
		tavily_hostname: candidate.hostname,
		tavily_snippet: candidate.snippet,
		tavily_snippet_truncated: candidate.snippetTruncated,
		tavily_content_truncated: candidate.contentTruncated,
	};
}

function serializeRef(ref: RefRecord): PersistedRefDetails {
	return {
		tavily_details_version: 1,
		...serializeCandidate(ref),
		tavily_originating_query: ref.originatingQuery,
		tavily_retrieved_at: ref.retrievedAt,
		tavily_freshness: ref.freshness,
		...(ref.freshnessNotBefore === undefined ? {} : { tavily_freshness_not_before: ref.freshnessNotBefore }),
		tavily_policy_allow: [...ref.policyAllow],
		tavily_policy_deny: [...ref.policyDeny],
	};
}

function estimateSearchWeight(key: string, snapshot: SearchSnapshot): number {
	return estimateCacheEntryWeight(
		[
			key,
			snapshot.query,
			snapshot.retrievedAt,
			...snapshot.candidates.flatMap((candidate) => [
				candidate.refId,
				candidate.title,
				candidate.url,
				candidate.hostname,
				candidate.snippet,
			]),
			...snapshot.refs.flatMap((ref) => [ref.originatingQuery, ref.retrievedAt, ...ref.policyAllow, ...ref.policyDeny]),
		],
		2_048 + (snapshot.candidates.length + snapshot.refs.length) * 128,
	);
}

function estimateExtractWeight(key: string, snapshot: ExtractTransportSnapshot): number {
	return estimateCacheEntryWeight(
		[
			key,
			snapshot.requestedUrl,
			snapshot.url,
			snapshot.hostname,
			snapshot.content,
			snapshot.mode,
			snapshot.coverage,
			snapshot.effectiveFocus ?? "",
			snapshot.retrievedAt,
		],
		2_048,
	);
}

function estimateFullWeight(key: string, value: FullCacheValue): number {
	return estimateCacheEntryWeight(
		[
			key,
			value.snapshot.refId,
			value.snapshot.title,
			value.snapshot.url,
			value.snapshot.hostname,
			value.snapshot.mode,
			value.snapshot.coverage,
			value.snapshot.retrievedAt,
			...value.pages.flatMap((page) => page.flatMap((block) => [block.id, block.text])),
			...value.cursors,
		],
		4_096 + value.pages.length * 128 + value.cursors.length * 128,
	);
}

function extractSnapshotMetadata(snapshot: ExtractSnapshot): Omit<ExtractSnapshot, "content"> {
	return Object.freeze({
		refId: snapshot.refId,
		title: snapshot.title,
		titleTruncated: snapshot.titleTruncated,
		titleSource: snapshot.titleSource,
		url: snapshot.url,
		hostname: snapshot.hostname,
		mode: snapshot.mode,
		coverage: snapshot.coverage,
		...(snapshot.effectiveFocus === undefined ? {} : { effectiveFocus: snapshot.effectiveFocus }),
		retrievedAt: snapshot.retrievedAt,
		networkAdmissionAt: snapshot.networkAdmissionAt,
		documentTruncated: snapshot.documentTruncated,
		urlChanged: snapshot.urlChanged,
		usageCredits: snapshot.usageCredits,
		usageEstimated: snapshot.usageEstimated,
		creditContractOverrun: snapshot.creditContractOverrun,
	});
}

function maximumSafeBlockCharacters(base: Parameters<typeof paginateBlocks>[0], maxCharacters: number): number {
	let low = 1;
	let high = maxCharacters;
	let best = 0;
	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		const content = buildOpenEnvelope({
			...base,
			page: Number.MAX_SAFE_INTEGER,
			hasMore: true,
			blocks: [{ id: `${base.refId}:b${Number.MAX_SAFE_INTEGER}`, text: "&".repeat(middle) }],
			nextCursor: `tavily_cursor_${"x".repeat(128)}`,
		});
		if (codePointLength(content) <= maxCharacters) {
			best = middle;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}
	if (best < 64) {
		throw new TavilyToolError(
			"open",
			"tavily_content_unavailable",
			"choose_other_ref",
			"The source metadata leaves no safe room for document content.",
		);
	}
	return best;
}

function createDeadlineSignal(
	toolSignal: AbortSignal | undefined,
	lifecycleSignal: AbortSignal,
	durationMs: number,
	tool: TavilyTool,
	now: () => number,
): {
	readonly signal: AbortSignal;
	readonly deadlineAt: number;
	readonly timedOut: () => boolean;
	readonly externallyAborted: () => boolean;
	readonly dispose: () => void;
} {
	const deadlineAt = now() + durationMs;
	const controller = new AbortController();
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		controller.abort(
			new TavilyToolError(tool, "tavily_request_timeout", "stop_turn", "The Tavily tool deadline expired."),
		);
	}, durationMs);
	const signals = toolSignal ? [toolSignal, lifecycleSignal, controller.signal] : [lifecycleSignal, controller.signal];
	return {
		signal: AbortSignal.any(signals),
		deadlineAt,
		timedOut: () => timedOut,
		externallyAborted: () => lifecycleSignal.aborted || toolSignal?.aborted === true,
		dispose: () => clearTimeout(timeout),
	};
}

function normalizeServiceError(
	tool: TavilyTool,
	error: unknown,
	deadline: {
		readonly timedOut: () => boolean;
		readonly externallyAborted: () => boolean;
		readonly signal: AbortSignal;
	},
): TavilyToolError {
	if (deadline.externallyAborted()) {
		return new TavilyToolError(tool, "tavily_request_aborted", "stop_turn", "The Tavily request was cancelled.");
	}
	if (deadline.timedOut()) {
		return new TavilyToolError(tool, "tavily_request_timeout", "stop_turn", "The Tavily tool deadline expired.");
	}
	if (error instanceof TavilyToolError) return normalizeToolError(tool, error);
	const reason: unknown = deadline.signal.reason;
	if (reason instanceof TavilyToolError) return normalizeToolError(tool, reason);
	if (deadline.signal.aborted) {
		return new TavilyToolError(tool, "tavily_request_aborted", "stop_turn", "The Tavily request was cancelled.");
	}
	return internalError(tool);
}

function rawStringArray(value: unknown, tool: TavilyTool, field: string): readonly string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
		throw invalidArguments(tool, `${field} must be an array of strings.`);
	}
	return value;
}

function rawOptionalEnum<const Value extends string>(
	value: unknown,
	allowed: readonly Value[],
	tool: TavilyTool,
	field: string,
): Value | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !allowed.some((item) => item === value)) {
		throw invalidArguments(tool, `${field} has an invalid value.`);
	}
	return allowed.find((item) => item === value);
}

function validateRecency(value: SearchRecency | undefined): SearchRecency | undefined {
	if (value === undefined) return undefined;
	if (value !== "day" && value !== "week" && value !== "month" && value !== "year") {
		throw invalidArguments("search", "recency has an invalid value.");
	}
	return value;
}

function invalidArguments(tool: TavilyTool, message: string): TavilyToolError {
	return new TavilyToolError(tool, "tavily_invalid_arguments", "fix_call", message);
}

function internalError(tool: TavilyTool): TavilyToolError {
	return new TavilyToolError(tool, "tavily_internal_error", "stop_turn", "The Tavily extension failed internally.");
}

function protocolError(tool: TavilyTool): TavilyToolError {
	return new TavilyToolError(tool, "tavily_protocol_error", "stop_turn", "Tavily returned an invalid response shape.");
}

function cursorExpiredError(): TavilyToolError {
	return new TavilyToolError(
		"open",
		"tavily_cursor_expired",
		"reopen_ref",
		"This in-memory cursor has expired. Reopen the ref to obtain a new snapshot.",
	);
}

function contentUnavailableError(): TavilyToolError {
	return new TavilyToolError(
		"open",
		"tavily_content_unavailable",
		"choose_other_ref",
		"Tavily did not return non-empty extractable content for this ref.",
	);
}

function refNumber(refId: string): number {
	const value = Number(refId.slice("tavily_ref_".length));
	return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function isStrictTimestamp(value: string): boolean {
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isSorted(values: readonly string[]): boolean {
	for (let index = 1; index < values.length; index += 1) {
		const previous = values[index - 1];
		const current = values[index];
		if (previous === undefined || current === undefined || previous.localeCompare(current) > 0) return false;
	}
	return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
