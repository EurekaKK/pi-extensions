import { isAbsolute, relative, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { ContextManagementError, throwIfAborted } from "../errors.js";
import { discoverRepositoryIdentity, type RepositoryIdentity, repositoryPaths } from "./identity.js";
import {
	type ActivationQuery,
	assembleMemoryPack,
	buildActivationQuery,
	isMemoryApplicable,
	type MemoryPack,
	rankMemoryRecords,
	selectMemorySearch,
} from "./retrieval.js";
import type { MemoryAuthorFields, MemoryOrigin, MemoryRecord } from "./schema.js";
import { type MemoryMutationResult, MemoryStore, type WriteMemoryValue } from "./store.js";

export class MemoryService {
	readonly #runtimeSignal: AbortSignal | undefined;
	#identity: RepositoryIdentity | null = null;
	#store: MemoryStore | null = null;
	#activationQuery: ActivationQuery = buildActivationQuery("");
	readonly #explicitReadIds = new Set<string>();

	constructor(runtimeSignal?: AbortSignal) {
		this.#runtimeSignal = runtimeSignal;
	}

	get store(): MemoryStore | null {
		return this.#store;
	}

	get identity(): RepositoryIdentity | null {
		return this.#identity;
	}

	setActivationPrompt(prompt: string): void {
		this.#activationQuery = this.#repositoryQuery(prompt);
		this.#explicitReadIds.clear();
	}

	async refresh(cwd: string, signal?: AbortSignal): Promise<MemoryStore> {
		const effectiveSignal = this.#effectiveSignal(signal);
		const identity = await discoverRepositoryIdentity(cwd, effectiveSignal);
		if (this.#store === null || this.#identity?.key !== identity.key) {
			this.#store = new MemoryStore(identity, repositoryPaths(getAgentDir(), identity));
		}
		this.#identity = identity;
		await this.#store.load(false, effectiveSignal);
		return this.#store;
	}

	async buildPack(
		cwd: string,
		prompt: string,
		precedingPackIds: ReadonlySet<string>,
		signal?: AbortSignal,
	): Promise<MemoryPack> {
		const effectiveSignal = this.#effectiveSignal(signal);
		const store = await this.refresh(cwd, effectiveSignal);
		throwIfAborted(effectiveSignal);
		const query = this.#repositoryQuery(prompt);
		const snapshot = store.snapshot;
		if (!snapshot.available) {
			throw new ContextManagementError(
				"context_management.memory_unavailable",
				`${snapshot.unavailableReason ?? "Memory store is unavailable."} Path: ${store.paths.memoryFile}`,
			);
		}
		if (snapshot.envelope === null) {
			return assembleMemoryPack([]);
		}
		const pack = assembleMemoryPack(
			rankMemoryRecords(snapshot.envelope.records, query, this.#identity?.branch ?? null, precedingPackIds),
		);
		throwIfAborted(effectiveSignal);
		return pack;
	}

	async search(cwd: string, queryText: string, signal?: AbortSignal): Promise<string> {
		const query = queryText.trim();
		if (query.length === 0) {
			throw new ContextManagementError(
				"context_management.memory_validation_failure",
				"Memory search query must not be empty.",
			);
		}
		const effectiveSignal = this.#effectiveSignal(signal);
		const store = await this.#requireAvailable(cwd, effectiveSignal);
		throwIfAborted(effectiveSignal);
		const selected = selectMemorySearch(
			rankMemoryRecords(
				store.snapshot.envelope?.records ?? [],
				this.#repositoryQuery(query),
				this.#identity?.branch ?? null,
			),
		);
		throwIfAborted(effectiveSignal);
		for (const id of selected.ids) this.#explicitReadIds.add(id);
		return selected.text;
	}

	async read(cwd: string, id: string, signal?: AbortSignal): Promise<MemoryRecord> {
		const effectiveSignal = this.#effectiveSignal(signal);
		const store = await this.#requireAvailable(cwd, effectiveSignal);
		throwIfAborted(effectiveSignal);
		const record = store.snapshot.envelope?.records.find((candidate) => candidate.id === id);
		const branchApplicable =
			record !== undefined &&
			record.supersededBy === null &&
			(record.scope.kind === "repository" || record.scope.branch === (this.#identity?.branch ?? null));
		if (
			record === undefined ||
			!branchApplicable ||
			(!this.#explicitReadIds.has(record.id) &&
				!isMemoryApplicable(record, this.#activationQuery, this.#identity?.branch ?? null))
		) {
			throw new ContextManagementError(
				"context_management.memory_validation_failure",
				`No active applicable Memory Record exists for exact ID ${id}.`,
			);
		}
		return record;
	}

	async write(
		cwd: string,
		fields: MemoryAuthorFields,
		origin: MemoryOrigin,
		signal?: AbortSignal,
	): Promise<MemoryMutationResult<WriteMemoryValue>> {
		const effectiveSignal = this.#effectiveSignal(signal);
		const store = await this.#requireAvailable(cwd, effectiveSignal);
		return store.write({ fields, origin }, effectiveSignal);
	}

	async forget(
		cwd: string,
		id: string,
		signal?: AbortSignal,
	): Promise<MemoryMutationResult<{ readonly id: string; readonly title: string }>> {
		const effectiveSignal = this.#effectiveSignal(signal);
		const store = await this.#requireAvailable(cwd, effectiveSignal);
		return store.forget(id, effectiveSignal);
	}

	#effectiveSignal(signal?: AbortSignal): AbortSignal | undefined {
		if (this.#runtimeSignal === undefined) return signal;
		if (signal === undefined || signal === this.#runtimeSignal) return this.#runtimeSignal;
		return AbortSignal.any([this.#runtimeSignal, signal]);
	}

	async #requireAvailable(cwd: string, signal?: AbortSignal): Promise<MemoryStore> {
		const store = await this.refresh(cwd, signal);
		if (!store.snapshot.available) {
			throw new ContextManagementError(
				"context_management.memory_unavailable",
				`${store.snapshot.unavailableReason ?? "Memory store is unavailable."} Path: ${store.paths.memoryFile}`,
			);
		}
		return store;
	}

	#repositoryQuery(text: string): ActivationQuery {
		const query = buildActivationQuery(text);
		const root = this.#identity?.repositoryRoot;
		if (root === undefined) return query;
		const explicitPaths = query.explicitPaths.map((path) => {
			if (!isAbsolute(path)) return path;
			const candidate = relative(root, path);
			if (candidate === "" || candidate === ".." || candidate.startsWith(`..${sep}`) || isAbsolute(candidate)) {
				return path;
			}
			return candidate.split(sep).join("/").toLowerCase();
		});
		return Object.freeze({
			...query,
			explicitPaths: Object.freeze([...new Set(explicitPaths)].sort()),
			exactLiterals: Object.freeze([...new Set([...query.exactLiterals, ...explicitPaths])].sort()),
		});
	}
}
