import { constants as fileConstants } from "node:fs";
import { copyFile, lstat, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { MAX_CONFIG_BYTES } from "./constants.js";
import { DomainPatternError, parseDomainPattern } from "./domains.js";
import type { RetrievalDepth, TavilyWebSearchConfig } from "./types.js";

export class ConfigurationError extends Error {
	readonly path: string;
	readonly field: string;

	constructor(path: string, field: string, reason: string) {
		super(`${path}: ${field}: ${reason}`);
		this.name = "ConfigurationError";
		this.path = path;
		this.field = field;
	}
}

export interface LoadedConfig {
	readonly config: TavilyWebSearchConfig;
	readonly created: boolean;
}

export async function loadOrCreateConfig(
	configPath: string,
	defaultsConfigPath: string,
	withFileMutationQueue: <T>(path: string, mutation: () => Promise<T>) => Promise<T>,
): Promise<LoadedConfig> {
	return withFileMutationQueue(configPath, async () => {
		await mkdir(dirname(configPath), { recursive: true });
		let created = false;
		try {
			await lstat(configPath);
		} catch (error) {
			if (!isNodeError(error) || error.code !== "ENOENT") throw configIoError(configPath, error);
			try {
				await copyFile(defaultsConfigPath, configPath, fileConstants.COPYFILE_EXCL);
				created = true;
			} catch (copyError) {
				if (!isNodeError(copyError) || copyError.code !== "EEXIST") throw configIoError(configPath, copyError);
			}
		}

		const before = await safeLstat(configPath);
		assertOrdinaryFile(configPath, before);
		assertFileSize(configPath, before.size);
		let bytes: Uint8Array;
		try {
			bytes = await readFile(configPath);
		} catch (error) {
			throw configIoError(configPath, error);
		}
		if (bytes.byteLength > MAX_CONFIG_BYTES) throw new ConfigurationError(configPath, "$", "file exceeds 64 KiB");
		const after = await safeLstat(configPath);
		assertOrdinaryFile(configPath, after);
		assertFileSize(configPath, after.size);
		if (before.dev !== after.dev || before.ino !== after.ino) {
			throw new ConfigurationError(configPath, "$", "file changed while it was being read");
		}
		if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
			throw new ConfigurationError(configPath, "$", "UTF-8 BOM is not allowed");
		}
		let text: string;
		try {
			text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch {
			throw new ConfigurationError(configPath, "$", "file is not valid UTF-8");
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text) as unknown;
		} catch {
			throw new ConfigurationError(configPath, "$", "file is not valid strict JSON");
		}
		return Object.freeze({ config: validateConfig(parsed, configPath), created });
	});
}

export function validateConfig(value: unknown, path = "config.json"): TavilyWebSearchConfig {
	const root = requireRecord(value, path, "$", ["version", "domains", "retrieval", "budgets", "cache"]);
	if (root.version !== 1) throw new ConfigurationError(path, "version", "must equal 1");

	const domains = requireRecord(root.domains, path, "domains", ["allow", "deny"]);
	const allow = validateDomainList(domains.allow, path, "domains.allow");
	const deny = validateDomainList(domains.deny, path, "domains.deny");

	const retrieval = requireRecord(root.retrieval, path, "retrieval", [
		"searchDepth",
		"extractDepth",
		"maxSearchResults",
		"maxOutputCharacters",
		"maxDocumentBytes",
	]);
	const searchDepth = requireDepth(retrieval.searchDepth, path, "retrieval.searchDepth");
	const extractDepth = requireDepth(retrieval.extractDepth, path, "retrieval.extractDepth");
	const maxSearchResults = requireInteger(retrieval.maxSearchResults, path, "retrieval.maxSearchResults", 1, 10);
	const maxOutputCharacters = requireInteger(
		retrieval.maxOutputCharacters,
		path,
		"retrieval.maxOutputCharacters",
		2_000,
		12_000,
	);
	const maxDocumentBytes = requireInteger(
		retrieval.maxDocumentBytes,
		path,
		"retrieval.maxDocumentBytes",
		32 * 1_024,
		256 * 1_024,
	);

	const budgets = requireRecord(root.budgets, path, "budgets", [
		"maxToolCallsPerTurn",
		"maxToolCallsPerAgentRun",
		"maxToolCallsPerBranchLineage",
		"maxTavilyCreditsPerAgentRun",
		"maxTavilyCreditsPerBranchLineage",
		"maxConcurrency",
	]);
	const maxToolCallsPerTurn = requireInteger(budgets.maxToolCallsPerTurn, path, "budgets.maxToolCallsPerTurn", 1, 16);
	const maxToolCallsPerAgentRun = requireInteger(
		budgets.maxToolCallsPerAgentRun,
		path,
		"budgets.maxToolCallsPerAgentRun",
		maxToolCallsPerTurn,
		64,
	);
	const maxToolCallsPerBranchLineage = requireInteger(
		budgets.maxToolCallsPerBranchLineage,
		path,
		"budgets.maxToolCallsPerBranchLineage",
		maxToolCallsPerAgentRun,
		500,
	);
	const worstAttemptCredits = searchDepth === "advanced" || extractDepth === "advanced" ? 2 : 1;
	const maxTavilyCreditsPerAgentRun = requireInteger(
		budgets.maxTavilyCreditsPerAgentRun,
		path,
		"budgets.maxTavilyCreditsPerAgentRun",
		worstAttemptCredits,
		100,
	);
	const maxTavilyCreditsPerBranchLineage = requireInteger(
		budgets.maxTavilyCreditsPerBranchLineage,
		path,
		"budgets.maxTavilyCreditsPerBranchLineage",
		maxTavilyCreditsPerAgentRun,
		1_000,
	);
	const maxConcurrency = requireInteger(budgets.maxConcurrency, path, "budgets.maxConcurrency", 1, 8);

	const cache = requireRecord(root.cache, path, "cache", ["searchTtlSeconds", "extractTtlSeconds", "maxBytes"]);
	const searchTtlSeconds = requireInteger(cache.searchTtlSeconds, path, "cache.searchTtlSeconds", 0, 3_600);
	const extractTtlSeconds = requireInteger(cache.extractTtlSeconds, path, "cache.extractTtlSeconds", 60, 3_600);
	const maxBytes = requireInteger(cache.maxBytes, path, "cache.maxBytes", 1 * 1_024 * 1_024, 16 * 1_024 * 1_024);
	if (maxBytes < maxDocumentBytes) {
		throw new ConfigurationError(path, "cache.maxBytes", "must be at least retrieval.maxDocumentBytes");
	}

	return deepFreeze({
		version: 1,
		domains: { allow, deny },
		retrieval: { searchDepth, extractDepth, maxSearchResults, maxOutputCharacters, maxDocumentBytes },
		budgets: {
			maxToolCallsPerTurn,
			maxToolCallsPerAgentRun,
			maxToolCallsPerBranchLineage,
			maxTavilyCreditsPerAgentRun,
			maxTavilyCreditsPerBranchLineage,
			maxConcurrency,
		},
		cache: { searchTtlSeconds, extractTtlSeconds, maxBytes },
	});
}

function validateDomainList(value: unknown, path: string, field: string): readonly string[] {
	if (!Array.isArray(value)) throw new ConfigurationError(path, field, "must be an array");
	if (value.length > 200) throw new ConfigurationError(path, field, "must contain at most 200 patterns");
	const result: string[] = [];
	const seen = new Set<string>();
	for (let index = 0; index < value.length; index += 1) {
		const item = value[index];
		if (typeof item !== "string") throw new ConfigurationError(path, `${field}[${index}]`, "must be a string");
		let canonical: string;
		try {
			canonical = parseDomainPattern(item).canonical;
		} catch (error) {
			const reason = error instanceof DomainPatternError ? error.message : "is invalid";
			throw new ConfigurationError(path, `${field}[${index}]`, reason);
		}
		if (seen.has(canonical))
			throw new ConfigurationError(path, `${field}[${index}]`, "duplicates a normalized pattern");
		seen.add(canonical);
		result.push(canonical);
	}
	return Object.freeze(result);
}

function requireRecord(
	value: unknown,
	path: string,
	field: string,
	allowedKeys: readonly string[],
): Record<string, unknown> {
	if (!isRecord(value)) throw new ConfigurationError(path, field, "must be an object");
	const allowed = new Set(allowedKeys);
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) throw new ConfigurationError(path, `${field}.${key}`.replace(/^\$\./u, ""), "unknown field");
	}
	for (const key of allowedKeys) {
		if (!Object.hasOwn(value, key)) {
			throw new ConfigurationError(path, `${field}.${key}`.replace(/^\$\./u, ""), "field is required");
		}
	}
	return value;
}

function requireDepth(value: unknown, path: string, field: string): RetrievalDepth {
	if (value !== "basic" && value !== "advanced") {
		throw new ConfigurationError(path, field, 'must be "basic" or "advanced"');
	}
	return value;
}

function requireInteger(value: unknown, path: string, field: string, minimum: number, maximum: number): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new ConfigurationError(path, field, `must be a safe integer from ${minimum} through ${maximum}`);
	}
	return value;
}

function assertOrdinaryFile(path: string, stats: Awaited<ReturnType<typeof lstat>>): void {
	if (!stats.isFile() || stats.isSymbolicLink()) throw new ConfigurationError(path, "$", "must be an ordinary file");
}

function assertFileSize(path: string, size: number | bigint): void {
	if (typeof size !== "number" || !Number.isSafeInteger(size) || size > MAX_CONFIG_BYTES) {
		throw new ConfigurationError(path, "$", "file exceeds 64 KiB");
	}
}

async function safeLstat(path: string): Promise<Awaited<ReturnType<typeof lstat>>> {
	try {
		return await lstat(path);
	} catch (error) {
		throw configIoError(path, error);
	}
}

function configIoError(path: string, _error: unknown): ConfigurationError {
	return new ConfigurationError(path, "$", "file could not be accessed safely");
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
	return value instanceof Error && "code" in value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze(config: TavilyWebSearchConfig): TavilyWebSearchConfig {
	Object.freeze(config.domains.allow);
	Object.freeze(config.domains.deny);
	Object.freeze(config.domains);
	Object.freeze(config.retrieval);
	Object.freeze(config.budgets);
	Object.freeze(config.cache);
	return Object.freeze(config);
}
