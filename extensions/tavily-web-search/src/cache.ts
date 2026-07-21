const CACHE_TEXT_ENCODER = new TextEncoder();

export type CacheEvictionReason = "capacity" | "expired" | "replaced" | "deleted" | "cleared";

export interface CacheWriteOptions {
	readonly ttlMs: number;
	readonly weight: number;
	readonly retrievedAt: number;
	readonly networkAdmissionAt: number;
}

export interface CacheReadOptions {
	readonly freshnessNotBefore?: number;
}

export interface CacheHit<Value> {
	readonly value: Value;
	readonly weight: number;
	readonly retrievedAt: number;
	readonly networkAdmissionAt: number;
	readonly expiresAt: number;
	readonly ageMs: number;
}

export interface CacheEviction<Key, Value> {
	readonly key: Key;
	readonly value: Value;
	readonly weight: number;
	readonly retrievedAt: number;
	readonly networkAdmissionAt: number;
	readonly reason: CacheEvictionReason;
}

export interface BoundedTtlLruCacheOptions<Key, Value> {
	readonly maxWeight: number;
	readonly now?: () => number;
	readonly onEvict?: (eviction: CacheEviction<Key, Value>) => void;
}

interface StoredCacheEntry<Value> {
	readonly value: Value;
	readonly weight: number;
	readonly retrievedAt: number;
	readonly networkAdmissionAt: number;
	readonly expiresAt: number;
}

/**
 * Counts both encoded UTF-8 bytes and a conservative two bytes per UTF-16 code
 * unit. Callers add a bounded metadata estimate for non-text fields.
 */
export function estimateCacheEntryWeight(strings: Iterable<string>, metadataBytes = 0): number {
	assertNonNegativeSafeInteger(metadataBytes, "metadataBytes");
	let weight = metadataBytes;
	for (const value of strings) {
		weight += CACHE_TEXT_ENCODER.encode(value).byteLength + value.length * 2;
		if (!Number.isSafeInteger(weight)) throw new RangeError("cache entry weight exceeds the safe integer range");
	}
	return weight;
}

/** Session-local TTL cache whose Map insertion order is the LRU order. */
export class BoundedTtlLruCache<Key, Value> {
	readonly maxWeight: number;
	private readonly entries = new Map<Key, StoredCacheEntry<Value>>();
	private readonly now: () => number;
	private readonly onEvict: ((eviction: CacheEviction<Key, Value>) => void) | undefined;
	private currentWeight = 0;

	constructor(options: BoundedTtlLruCacheOptions<Key, Value>) {
		assertPositiveSafeInteger(options.maxWeight, "maxWeight");
		this.maxWeight = options.maxWeight;
		this.now = options.now ?? Date.now;
		this.onEvict = options.onEvict;
	}

	get size(): number {
		return this.entries.size;
	}

	get totalWeight(): number {
		return this.currentWeight;
	}

	set(key: Key, value: Value, options: CacheWriteOptions): boolean {
		assertNonNegativeSafeInteger(options.ttlMs, "ttlMs");
		assertPositiveSafeInteger(options.weight, "weight");
		assertFiniteTimestamp(options.retrievedAt, "retrievedAt");
		assertFiniteTimestamp(options.networkAdmissionAt, "networkAdmissionAt");

		const now = this.readNow();
		const expiresAt = now + options.ttlMs;
		if (!Number.isSafeInteger(expiresAt)) throw new RangeError("cache expiry exceeds the safe integer range");

		this.remove(key, "replaced");
		if (options.ttlMs === 0 || options.weight > this.maxWeight) return false;

		const entry: StoredCacheEntry<Value> = {
			value,
			weight: options.weight,
			retrievedAt: options.retrievedAt,
			networkAdmissionAt: options.networkAdmissionAt,
			expiresAt,
		};
		this.entries.set(key, entry);
		this.currentWeight += entry.weight;

		const evictions: CacheEviction<Key, Value>[] = [];
		while (this.currentWeight > this.maxWeight) {
			const oldest = this.entries.keys().next();
			if (oldest.done) break;
			const eviction = this.removeWithoutNotification(oldest.value, "capacity");
			if (eviction) evictions.push(eviction);
		}
		for (const eviction of evictions) this.onEvict?.(eviction);
		return this.entries.has(key);
	}

	get(key: Key, options: CacheReadOptions = {}): CacheHit<Value> | undefined {
		const entry = this.entries.get(key);
		if (!entry) return undefined;

		const now = this.readNow();
		if (now >= entry.expiresAt) {
			this.remove(key, "expired");
			return undefined;
		}
		if (options.freshnessNotBefore !== undefined) {
			assertFiniteTimestamp(options.freshnessNotBefore, "freshnessNotBefore");
			if (entry.networkAdmissionAt < options.freshnessNotBefore) return undefined;
		}

		this.entries.delete(key);
		this.entries.set(key, entry);
		return Object.freeze({
			value: entry.value,
			weight: entry.weight,
			retrievedAt: entry.retrievedAt,
			networkAdmissionAt: entry.networkAdmissionAt,
			expiresAt: entry.expiresAt,
			ageMs: Math.max(0, now - entry.retrievedAt),
		});
	}

	delete(key: Key): boolean {
		return this.remove(key, "deleted");
	}

	pruneExpired(): number {
		const now = this.readNow();
		const expired: Key[] = [];
		for (const [key, entry] of this.entries) {
			if (now >= entry.expiresAt) expired.push(key);
		}
		for (const key of expired) this.remove(key, "expired");
		return expired.length;
	}

	clear(): void {
		if (this.entries.size === 0) return;
		const evictions: CacheEviction<Key, Value>[] = [];
		for (const [key, entry] of this.entries) {
			evictions.push(this.toEviction(key, entry, "cleared"));
		}
		this.entries.clear();
		this.currentWeight = 0;
		for (const eviction of evictions) this.onEvict?.(eviction);
	}

	private readNow(): number {
		const value = this.now();
		assertFiniteTimestamp(value, "now");
		return value;
	}

	private remove(key: Key, reason: CacheEvictionReason): boolean {
		const eviction = this.removeWithoutNotification(key, reason);
		if (!eviction) return false;
		this.onEvict?.(eviction);
		return true;
	}

	private removeWithoutNotification(key: Key, reason: CacheEvictionReason): CacheEviction<Key, Value> | undefined {
		const entry = this.entries.get(key);
		if (!entry) return undefined;
		this.entries.delete(key);
		this.currentWeight -= entry.weight;
		return this.toEviction(key, entry, reason);
	}

	private toEviction(key: Key, entry: StoredCacheEntry<Value>, reason: CacheEvictionReason): CacheEviction<Key, Value> {
		return Object.freeze({
			key,
			value: entry.value,
			weight: entry.weight,
			retrievedAt: entry.retrievedAt,
			networkAdmissionAt: entry.networkAdmissionAt,
			reason,
		});
	}
}

export class SemaphoreClosedError extends Error {
	constructor(message = "The network concurrency queue is closed.") {
		super(message);
		this.name = "SemaphoreClosedError";
	}
}

export class QueueDeadlineExceededError extends Error {
	constructor(message = "The network concurrency queue deadline expired.") {
		super(message);
		this.name = "QueueDeadlineExceededError";
	}
}

export class QueueAbortedError extends Error {
	constructor(message = "The network concurrency queue wait was aborted.") {
		super(message);
		this.name = "QueueAbortedError";
	}
}

export interface SemaphoreAcquireOptions {
	readonly signal?: AbortSignal;
	/** Absolute timestamp in the same time domain as the semaphore's clock. */
	readonly deadlineAt?: number;
}

export interface SemaphoreLease {
	release(): void;
}

interface SemaphoreWaiter {
	readonly resolve: (lease: SemaphoreLease) => void;
	readonly reject: (reason: unknown) => void;
	readonly signal: AbortSignal | undefined;
	readonly deadlineAt: number | undefined;
	abortListener: (() => void) | undefined;
	timer: ReturnType<typeof setTimeout> | undefined;
	settled: boolean;
}

/** A closeable, session-level FIFO semaphore for real network attempts. */
export class FifoSemaphore {
	readonly capacity: number;
	private readonly now: () => number;
	private readonly queue: SemaphoreWaiter[] = [];
	private activeLeases = 0;
	private closed = false;
	private closeReason: Error | undefined;

	constructor(capacity: number, now: () => number = Date.now) {
		assertPositiveSafeInteger(capacity, "capacity");
		this.capacity = capacity;
		this.now = now;
	}

	get active(): number {
		return this.activeLeases;
	}

	get queued(): number {
		return this.queue.length;
	}

	get isClosed(): boolean {
		return this.closed;
	}

	acquire(options: SemaphoreAcquireOptions = {}): Promise<SemaphoreLease> {
		if (this.closed) return Promise.reject(this.closeReason ?? new SemaphoreClosedError());
		if (options.signal?.aborted) return Promise.reject(signalAbortReason(options.signal, new QueueAbortedError()));

		let deadlineAt: number | undefined;
		if (options.deadlineAt !== undefined) {
			assertFiniteTimestamp(options.deadlineAt, "deadlineAt");
			deadlineAt = options.deadlineAt;
			if (this.readNow() >= deadlineAt) return Promise.reject(new QueueDeadlineExceededError());
		}

		if (this.queue.length === 0 && this.activeLeases < this.capacity) {
			this.activeLeases += 1;
			return Promise.resolve(this.createLease());
		}

		return new Promise<SemaphoreLease>((resolve, reject) => {
			const waiter: SemaphoreWaiter = {
				resolve,
				reject,
				signal: options.signal,
				deadlineAt,
				abortListener: undefined,
				timer: undefined,
				settled: false,
			};
			this.queue.push(waiter);

			const signal = waiter.signal;
			if (signal) {
				waiter.abortListener = () => {
					this.rejectWaiter(waiter, signalAbortReason(signal, new QueueAbortedError()));
					this.drain();
				};
				signal.addEventListener("abort", waiter.abortListener, { once: true });
			}
			if (deadlineAt !== undefined) {
				this.scheduleDeadline(waiter);
			}
			if (waiter.signal?.aborted) waiter.abortListener?.();
		});
	}

	close(reason: Error = new SemaphoreClosedError()): void {
		if (this.closed) return;
		this.closed = true;
		this.closeReason = reason;
		const queued = this.queue.splice(0);
		for (const waiter of queued) this.settleRejectedWaiter(waiter, reason);
	}

	private createLease(): SemaphoreLease {
		let released = false;
		return Object.freeze({
			release: () => {
				if (released) return;
				released = true;
				this.activeLeases -= 1;
				this.drain();
			},
		});
	}

	private readNow(): number {
		const value = this.now();
		assertFiniteTimestamp(value, "now");
		return value;
	}

	private drain(): void {
		if (this.closed) return;
		while (this.activeLeases < this.capacity && this.queue.length > 0) {
			const waiter = this.queue.shift();
			if (!waiter || waiter.settled) continue;
			if (waiter.signal?.aborted) {
				this.settleRejectedWaiter(waiter, signalAbortReason(waiter.signal, new QueueAbortedError()));
				continue;
			}
			if (waiter.deadlineAt !== undefined && this.readNow() >= waiter.deadlineAt) {
				this.settleRejectedWaiter(waiter, new QueueDeadlineExceededError());
				continue;
			}
			waiter.settled = true;
			this.cleanupWaiter(waiter);
			this.activeLeases += 1;
			waiter.resolve(this.createLease());
		}
	}

	private rejectWaiter(waiter: SemaphoreWaiter, reason: unknown): void {
		if (waiter.settled) return;
		const index = this.queue.indexOf(waiter);
		if (index >= 0) this.queue.splice(index, 1);
		this.settleRejectedWaiter(waiter, reason);
	}

	private scheduleDeadline(waiter: SemaphoreWaiter): void {
		const deadlineAt = waiter.deadlineAt;
		if (deadlineAt === undefined || waiter.settled) return;
		const remaining = deadlineAt - this.readNow();
		if (remaining <= 0) {
			this.rejectWaiter(waiter, new QueueDeadlineExceededError());
			this.drain();
			return;
		}
		waiter.timer = setTimeout(
			() => {
				waiter.timer = undefined;
				this.scheduleDeadline(waiter);
			},
			Math.min(remaining, 2_147_483_647),
		);
	}

	private settleRejectedWaiter(waiter: SemaphoreWaiter, reason: unknown): void {
		if (waiter.settled) return;
		waiter.settled = true;
		this.cleanupWaiter(waiter);
		waiter.reject(reason);
	}

	private cleanupWaiter(waiter: SemaphoreWaiter): void {
		if (waiter.signal && waiter.abortListener) {
			waiter.signal.removeEventListener("abort", waiter.abortListener);
		}
		if (waiter.timer !== undefined) clearTimeout(waiter.timer);
		waiter.abortListener = undefined;
		waiter.timer = undefined;
	}
}

export class InFlightRegistryClosedError extends Error {
	constructor(message = "The in-flight request registry is closed.") {
		super(message);
		this.name = "InFlightRegistryClosedError";
	}
}

export class InFlightRequestsAbortedError extends Error {
	constructor(message = "The in-flight requests were aborted by lifecycle cleanup.") {
		super(message);
		this.name = "InFlightRequestsAbortedError";
	}
}

export class AllWaitersAbortedError extends Error {
	constructor(message = "All waiters for the shared request were aborted.") {
		super(message);
		this.name = "AllWaitersAbortedError";
	}
}

export class InFlightWaiterAbortedError extends Error {
	constructor(message = "The caller stopped waiting for the shared request.") {
		super(message);
		this.name = "InFlightWaiterAbortedError";
	}
}

export interface InFlightRunOptions<Metadata> {
	readonly metadata: Metadata;
	readonly signal?: AbortSignal;
	/** Set false for live calls that must start a new request. */
	readonly joinExisting?: boolean;
	/** Set false when this new request must never accept later joiners. */
	readonly acceptJoiners?: boolean;
	readonly canJoin?: (metadata: Metadata) => boolean;
}

interface InFlightWaiter<Value> {
	readonly resolve: (value: Value) => void;
	readonly reject: (reason: unknown) => void;
	readonly signal: AbortSignal | undefined;
	abortListener: (() => void) | undefined;
	settled: boolean;
}

interface InFlightEntry<Metadata, Value> {
	readonly metadata: Metadata;
	readonly controller: AbortController;
	readonly waiters: Set<InFlightWaiter<Value>>;
	accepting: boolean;
	settled: boolean;
}

/**
 * Session-local request coalescing. Every caller gets an independent waiter;
 * the producer signal is aborted only after all waiters leave.
 */
export class CancelableInFlightRegistry<Key, Metadata, Value> {
	private readonly entries = new Map<Key, InFlightEntry<Metadata, Value>[]>();
	private closed = false;
	private closeReason: Error | undefined;

	get activeRequests(): number {
		let count = 0;
		for (const entries of this.entries.values()) count += entries.length;
		return count;
	}

	get waitingCallers(): number {
		let count = 0;
		for (const entries of this.entries.values()) {
			for (const entry of entries) count += entry.waiters.size;
		}
		return count;
	}

	run(
		key: Key,
		options: InFlightRunOptions<Metadata>,
		producer: (signal: AbortSignal) => Value | PromiseLike<Value>,
	): Promise<Value> {
		if (this.closed) return Promise.reject(this.closeReason ?? new InFlightRegistryClosedError());
		if (options.signal?.aborted) {
			return Promise.reject(signalAbortReason(options.signal, new InFlightWaiterAbortedError()));
		}

		if (options.joinExisting !== false) {
			const candidates = this.entries.get(key);
			if (candidates) {
				for (let index = candidates.length - 1; index >= 0; index -= 1) {
					const candidate = candidates[index];
					if (!candidate?.accepting || candidate.settled) continue;
					let compatible = true;
					try {
						compatible = options.canJoin?.(candidate.metadata) ?? true;
					} catch (error) {
						return Promise.reject(error);
					}
					if (compatible) return this.addWaiter(candidate, options.signal);
				}
			}
		}

		const entry: InFlightEntry<Metadata, Value> = {
			metadata: options.metadata,
			controller: new AbortController(),
			waiters: new Set(),
			accepting: options.acceptJoiners ?? true,
			settled: false,
		};
		const bucket = this.entries.get(key);
		if (bucket) bucket.push(entry);
		else this.entries.set(key, [entry]);

		const waiter = this.addWaiter(entry, options.signal);
		void Promise.resolve()
			.then(() => {
				if (entry.settled || entry.controller.signal.aborted) {
					const reason: unknown = entry.controller.signal.reason;
					throw reason ?? new AllWaitersAbortedError();
				}
				return producer(entry.controller.signal);
			})
			.then(
				(value) => this.resolveEntry(key, entry, value),
				(error: unknown) => this.rejectEntry(key, entry, error),
			);
		return waiter;
	}

	abortAll(reason: Error = new InFlightRequestsAbortedError()): void {
		const entries = [...this.entries.entries()].flatMap(([key, values]) => values.map((entry) => ({ key, entry })));
		for (const { key, entry } of entries) this.terminateEntry(key, entry, reason);
	}

	close(reason: Error = new InFlightRegistryClosedError()): void {
		if (this.closed) return;
		this.closed = true;
		this.closeReason = reason;
		this.abortAll(reason);
	}

	private addWaiter(entry: InFlightEntry<Metadata, Value>, signal: AbortSignal | undefined): Promise<Value> {
		return new Promise<Value>((resolve, reject) => {
			const waiter: InFlightWaiter<Value> = {
				resolve,
				reject,
				signal,
				abortListener: undefined,
				settled: false,
			};
			entry.waiters.add(waiter);
			if (signal) {
				waiter.abortListener = () => {
					this.cancelWaiter(entry, waiter, signalAbortReason(signal, new InFlightWaiterAbortedError()));
				};
				signal.addEventListener("abort", waiter.abortListener, { once: true });
				if (signal.aborted) waiter.abortListener();
			}
		});
	}

	private cancelWaiter(entry: InFlightEntry<Metadata, Value>, waiter: InFlightWaiter<Value>, reason: unknown): void {
		if (waiter.settled) return;
		waiter.settled = true;
		entry.waiters.delete(waiter);
		this.cleanupInFlightWaiter(waiter);
		waiter.reject(reason);
		if (entry.waiters.size > 0 || entry.settled) return;

		entry.accepting = false;
		entry.settled = true;
		this.removeEntry(entry);
		entry.controller.abort(new AllWaitersAbortedError());
	}

	private resolveEntry(key: Key, entry: InFlightEntry<Metadata, Value>, value: Value): void {
		if (entry.settled) return;
		entry.settled = true;
		entry.accepting = false;
		this.removeEntry(entry, key);
		for (const waiter of entry.waiters) {
			if (waiter.settled) continue;
			waiter.settled = true;
			this.cleanupInFlightWaiter(waiter);
			waiter.resolve(value);
		}
		entry.waiters.clear();
	}

	private rejectEntry(key: Key, entry: InFlightEntry<Metadata, Value>, reason: unknown): void {
		if (entry.settled) return;
		entry.settled = true;
		entry.accepting = false;
		this.removeEntry(entry, key);
		for (const waiter of entry.waiters) {
			if (waiter.settled) continue;
			waiter.settled = true;
			this.cleanupInFlightWaiter(waiter);
			waiter.reject(reason);
		}
		entry.waiters.clear();
	}

	private terminateEntry(key: Key, entry: InFlightEntry<Metadata, Value>, reason: Error): void {
		if (entry.settled) return;
		entry.settled = true;
		entry.accepting = false;
		this.removeEntry(entry, key);
		entry.controller.abort(reason);
		for (const waiter of entry.waiters) {
			if (waiter.settled) continue;
			waiter.settled = true;
			this.cleanupInFlightWaiter(waiter);
			waiter.reject(reason);
		}
		entry.waiters.clear();
	}

	private removeEntry(entry: InFlightEntry<Metadata, Value>, knownKey?: Key): void {
		if (knownKey !== undefined) {
			this.removeEntryFromBucket(knownKey, entry);
			return;
		}
		for (const [key, bucket] of this.entries) {
			if (bucket.includes(entry)) {
				this.removeEntryFromBucket(key, entry);
				return;
			}
		}
	}

	private removeEntryFromBucket(key: Key, entry: InFlightEntry<Metadata, Value>): void {
		const bucket = this.entries.get(key);
		if (!bucket) return;
		const index = bucket.indexOf(entry);
		if (index >= 0) bucket.splice(index, 1);
		if (bucket.length === 0) this.entries.delete(key);
	}

	private cleanupInFlightWaiter(waiter: InFlightWaiter<Value>): void {
		if (waiter.signal && waiter.abortListener) {
			waiter.signal.removeEventListener("abort", waiter.abortListener);
		}
		waiter.abortListener = undefined;
	}
}

function signalAbortReason(signal: AbortSignal, fallback: Error): unknown {
	const reason: unknown = signal.reason;
	return reason ?? fallback;
}

function assertPositiveSafeInteger(value: number, field: string): void {
	if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${field} must be a positive safe integer`);
}

function assertNonNegativeSafeInteger(value: number, field: string): void {
	if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${field} must be a non-negative safe integer`);
}

function assertFiniteTimestamp(value: number, field: string): void {
	if (!Number.isFinite(value)) throw new RangeError(`${field} must be finite`);
}
