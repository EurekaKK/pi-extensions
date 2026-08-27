import { relative } from "node:path";
import type { MemoryConfigV1 } from "./config.js";
import { MEMORY_STATUS_COMMAND } from "./constants.js";
import { MemoryError } from "./errors.js";
import { checkMemoryStoreGitTracking, type GitTrackState } from "./git.js";
import { resolveDirectoryIdentity } from "./identity.js";
import { classifyMemoryStore, type StoreClassification } from "./store.js";
import { getMemoryStoreDirectory, getMemoryStorePath } from "./store-layout.js";

export interface MemoryStatusReport {
	readonly isError: boolean;
	readonly directoryIdentity: string;
	readonly directoryIdentityFailed: string | null;
	readonly storePath: string;
	readonly store: StoreClassification;
	readonly git: GitTrackState;
	readonly recallBudget: Readonly<{ maxRecords: number; maxChars: number }>;
	readonly proactiveWrites: boolean;
	readonly automaticRecall: boolean;
	readonly text: string;
}

export interface BuildMemoryStatusReportOptions {
	readonly cwd: string;
	readonly config: MemoryConfigV1;
	readonly signal?: AbortSignal;
}

function gitLabel(state: GitTrackState): string {
	switch (state.kind) {
		case "non-git":
			return "not a git repository";
		case "tracked":
			return "tracked by git";
		case "untracked":
			return "untracked by git";
		case "ignored":
			return "ignored by git";
		case "timed-out":
			return "git diagnostic timed out";
		case "cancelled":
			return "git diagnostic cancelled";
		case "unavailable":
			return `git diagnostic unavailable (${state.reason})`;
	}
}

function storeLabel(store: StoreClassification): string {
	switch (store.kind) {
		case "missing":
			return "missing (no Store yet)";
		case "healthy":
			return "healthy";
		case "unreadable":
		case "corrupt":
		case "over-limit":
		case "unsupported":
			return `${store.kind} (${store.reason})`;
	}
}

/**
 * Build the full read-only status report for the exact Working Directory:
 * Directory Identity, Store health (never written here), revision, record
 * counts, configured recall budget, and advisory Git tracking state.
 *
 * When identity resolution succeeds, the canonical real path is used for both
 * the Store location and the Git diagnostic cwd/pathspec derivation, so symlink
 * aliases converge in the displayed Store path and diagnostics. On identity
 * failure the raw cwd is kept for path derivation with a safe error reported.
 */
export async function buildMemoryStatusReport(options: BuildMemoryStatusReportOptions): Promise<MemoryStatusReport> {
	const { cwd, config } = options;

	let base = cwd;
	let identity: string;
	let identityFailed: string | null = null;
	try {
		identity = await resolveDirectoryIdentity(cwd);
		base = identity;
	} catch (error) {
		identity = cwd;
		identityFailed = error instanceof MemoryError ? error.message : String(error);
	}

	const storePath = getMemoryStorePath(base);
	const store = await classifyMemoryStore({
		storePath,
		limits: config.store,
		...(options.signal === undefined ? {} : { signal: options.signal }),
	});

	const storeDirectory = getMemoryStoreDirectory(base);
	const git = await checkMemoryStoreGitTracking({
		cwd: base,
		// Git pathspecs are relative to the derived cwd, never absolute paths.
		paths: [relative(base, storeDirectory), relative(base, storePath)],
		timeoutMs: config.git.diagnosticTimeoutMs,
		...(options.signal === undefined ? {} : { signal: options.signal }),
	});

	const active =
		store.kind === "healthy" ? store.store.records.filter((record) => record.state === "active").length : 0;
	const superseded =
		store.kind === "healthy" ? store.store.records.filter((record) => record.state === "superseded").length : 0;

	const lines = [
		`${MEMORY_STATUS_COMMAND} · ${identityFailed === null ? "usable" : "identity failed"}`,
		`Directory: ${identity}`,
		...(identityFailed === null ? [] : [`Directory error: ${identityFailed}`]),
		`Store: ${storeDirectory}`,
		`Store health: ${storeLabel(store)}`,
		...(store.kind === "healthy" ? [`Store revision: ${store.store.revision}`] : []),
		...(store.kind === "healthy" ? [`Records: ${active} active · ${superseded} superseded`] : []),
		`Recall budget: ${config.recall.maxRecords} records · ${config.recall.maxChars} chars`,
		`Proactive writes: ${config.proactiveWrites ? "enabled" : "disabled"} · Automatic recall: ${config.automaticRecall ? "enabled" : "disabled"}`,
		`Git: ${gitLabel(git)}`,
	];

	const isError =
		identityFailed !== null ||
		store.kind === "unreadable" ||
		store.kind === "corrupt" ||
		store.kind === "over-limit" ||
		store.kind === "unsupported";

	return {
		isError,
		directoryIdentity: identity,
		directoryIdentityFailed: identityFailed,
		storePath,
		store,
		git,
		recallBudget: { maxRecords: config.recall.maxRecords, maxChars: config.recall.maxChars },
		proactiveWrites: config.proactiveWrites,
		automaticRecall: config.automaticRecall,
		text: lines.join("\n"),
	};
}

export function renderMemoryStatusFailure(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return [`${MEMORY_STATUS_COMMAND} · unavailable`, `Error: ${message}`].join("\n");
}
