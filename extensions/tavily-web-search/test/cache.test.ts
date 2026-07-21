import { afterEach, describe, expect, it, vi } from "vitest";
import type { CacheEviction } from "../src/cache.js";
import {
	AllWaitersAbortedError,
	BoundedTtlLruCache,
	CancelableInFlightRegistry,
	estimateCacheEntryWeight,
	FifoSemaphore,
	InFlightRegistryClosedError,
	QueueDeadlineExceededError,
	SemaphoreClosedError,
} from "../src/cache.js";

interface Deferred<Value> {
	readonly promise: Promise<Value>;
	resolve(value: Value): void;
	reject(reason: unknown): void;
}

function deferred<Value>(): Deferred<Value> {
	let resolvePromise: ((value: Value) => void) | undefined;
	let rejectPromise: ((reason: unknown) => void) | undefined;
	const promise = new Promise<Value>((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});
	return {
		promise,
		resolve(value) {
			if (!resolvePromise) throw new Error("deferred promise is not initialized");
			resolvePromise(value);
		},
		reject(reason) {
			if (!rejectPromise) throw new Error("deferred promise is not initialized");
			rejectPromise(reason);
		},
	};
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

afterEach(() => {
	vi.useRealTimers();
});

describe("BoundedTtlLruCache", () => {
	it("counts UTF-8, conservative UTF-16, and bounded metadata weight", () => {
		// "a😀" is 5 UTF-8 bytes and 3 UTF-16 code units.
		expect(estimateCacheEntryWeight(["a😀"], 7)).toBe(18);
		expect(() => estimateCacheEntryWeight(["x"], -1)).toThrow(RangeError);
	});

	it("evicts the least recently used entry and exposes an eviction hook", () => {
		let now = 1_000;
		const evictions: CacheEviction<string, { readonly id: string }>[] = [];
		const cache = new BoundedTtlLruCache<string, { readonly id: string }>({
			maxWeight: 8,
			now: () => now,
			onEvict: (eviction) => evictions.push(eviction),
		});
		const first = { id: "first" } as const;
		const second = { id: "second" } as const;
		const third = { id: "third" } as const;

		expect(cache.set("first", first, { ttlMs: 100, weight: 4, retrievedAt: now, networkAdmissionAt: now })).toBe(true);
		expect(cache.set("second", second, { ttlMs: 100, weight: 4, retrievedAt: now, networkAdmissionAt: now })).toBe(
			true,
		);
		expect(cache.get("first")?.value).toBe(first);
		now += 1;
		expect(cache.set("third", third, { ttlMs: 100, weight: 4, retrievedAt: now, networkAdmissionAt: now })).toBe(true);

		expect(cache.get("second")).toBeUndefined();
		expect(cache.get("first")?.value).toBe(first);
		expect(cache.get("third")?.value).toBe(third);
		expect(cache.totalWeight).toBe(8);
		expect(evictions).toMatchObject([{ key: "second", value: second, reason: "capacity", weight: 4 }]);
	});

	it("expires at the TTL boundary without copying or refreshing retrieval metadata", () => {
		let now = 2_000;
		const value = { content: "snapshot" };
		const cache = new BoundedTtlLruCache<string, typeof value>({ maxWeight: 100, now: () => now });
		cache.set("snapshot", value, {
			ttlMs: 100,
			weight: 20,
			retrievedAt: 1_950,
			networkAdmissionAt: 1_940,
		});

		const hit = cache.get("snapshot");
		expect(hit?.value).toBe(value);
		expect(hit).toMatchObject({ retrievedAt: 1_950, networkAdmissionAt: 1_940, ageMs: 50 });

		now = 2_099;
		expect(cache.get("snapshot")?.ageMs).toBe(149);
		now = 2_100;
		expect(cache.get("snapshot")).toBeUndefined();
		expect(cache.size).toBe(0);
	});

	it("prunes every expired entry while retaining live LRU state", () => {
		let now = 10;
		const cache = new BoundedTtlLruCache<string, string>({ maxWeight: 10, now: () => now });
		cache.set("short", "short", { ttlMs: 5, weight: 5, retrievedAt: now, networkAdmissionAt: now });
		cache.set("long", "long", { ttlMs: 50, weight: 5, retrievedAt: now, networkAdmissionAt: now });
		now = 15;

		expect(cache.pruneExpired()).toBe(1);
		expect(cache.get("short")).toBeUndefined();
		expect(cache.get("long")?.value).toBe("long");
		expect(cache.totalWeight).toBe(5);
	});

	it("uses network admission time, not later retrieval time, for Open freshness", () => {
		let now = 300;
		const cache = new BoundedTtlLruCache<string, string>({ maxWeight: 10, now: () => now });
		cache.set("old", "old", { ttlMs: 100, weight: 5, retrievedAt: 250, networkAdmissionAt: 100 });
		cache.set("other", "other", { ttlMs: 100, weight: 5, retrievedAt: 250, networkAdmissionAt: 250 });

		expect(cache.get("old", { freshnessNotBefore: 150 })).toBeUndefined();
		expect(cache.size).toBe(2);
		now += 1;
		cache.set("new", "new", { ttlMs: 100, weight: 5, retrievedAt: now, networkAdmissionAt: now });

		// A freshness miss is not an LRU hit: the still-useful old entry is evicted first.
		expect(cache.get("old")).toBeUndefined();
		expect(cache.get("other")?.value).toBe("other");
		expect(cache.get("new")?.value).toBe("new");
	});

	it("disables TTL-zero entries, rejects oversized entries, and clears idempotently", () => {
		const evictions: string[] = [];
		const cache = new BoundedTtlLruCache<string, string>({
			maxWeight: 5,
			now: () => 10,
			onEvict: ({ key, reason }) => evictions.push(`${key}:${reason}`),
		});

		expect(cache.set("disabled", "x", { ttlMs: 0, weight: 1, retrievedAt: 10, networkAdmissionAt: 10 })).toBe(false);
		expect(cache.set("oversized", "x", { ttlMs: 10, weight: 6, retrievedAt: 10, networkAdmissionAt: 10 })).toBe(false);
		cache.set("kept", "x", { ttlMs: 10, weight: 5, retrievedAt: 10, networkAdmissionAt: 10 });
		cache.clear();
		cache.clear();

		expect(cache.size).toBe(0);
		expect(cache.totalWeight).toBe(0);
		expect(evictions).toEqual(["kept:cleared"]);
	});

	it("lets an eviction hook invalidate all cursors bound to a Full snapshot", () => {
		const cursors = new Map<string, Set<string>>([["full-a", new Set(["cursor-1", "cursor-2"])]]);
		const cache = new BoundedTtlLruCache<string, string>({
			maxWeight: 5,
			now: () => 100,
			onEvict: ({ key }) => cursors.delete(key),
		});
		cache.set("full-a", "snapshot-a", { ttlMs: 100, weight: 5, retrievedAt: 100, networkAdmissionAt: 100 });
		cache.set("full-b", "snapshot-b", { ttlMs: 100, weight: 5, retrievedAt: 100, networkAdmissionAt: 100 });

		expect(cursors.has("full-a")).toBe(false);
	});
});

describe("FifoSemaphore", () => {
	it("grants queued network slots in FIFO order and leases release idempotently", async () => {
		const semaphore = new FifoSemaphore(1);
		const first = await semaphore.acquire();
		const order: string[] = [];
		const secondPromise = semaphore.acquire().then((lease) => {
			order.push("second");
			return lease;
		});
		const thirdPromise = semaphore.acquire().then((lease) => {
			order.push("third");
			return lease;
		});

		expect(semaphore.active).toBe(1);
		expect(semaphore.queued).toBe(2);
		first.release();
		const second = await secondPromise;
		expect(order).toEqual(["second"]);
		second.release();
		second.release();
		const third = await thirdPromise;
		expect(order).toEqual(["second", "third"]);
		third.release();
		expect(semaphore.active).toBe(0);
	});

	it("removes an independently aborted waiter without disturbing FIFO", async () => {
		const semaphore = new FifoSemaphore(1);
		const first = await semaphore.acquire();
		const controller = new AbortController();
		const reason = new Error("caller cancelled");
		const cancelled = semaphore.acquire({ signal: controller.signal });
		const later = semaphore.acquire();
		const cancelledAssertion = expect(cancelled).rejects.toBe(reason);

		controller.abort(reason);
		await cancelledAssertion;
		expect(semaphore.queued).toBe(1);
		first.release();
		const laterLease = await later;
		laterLease.release();
	});

	it("counts queue wait against an absolute deadline", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000);
		const semaphore = new FifoSemaphore(1, Date.now);
		const first = await semaphore.acquire();
		const queued = semaphore.acquire({ deadlineAt: 1_050 });
		const rejected = expect(queued).rejects.toBeInstanceOf(QueueDeadlineExceededError);

		await vi.advanceTimersByTimeAsync(49);
		expect(semaphore.queued).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		await rejected;
		expect(semaphore.queued).toBe(0);
		first.release();
	});

	it("cleanup rejects all queued and future acquisitions without revoking an active lease", async () => {
		const semaphore = new FifoSemaphore(1);
		const first = await semaphore.acquire();
		const queued = semaphore.acquire();
		const queuedAssertion = expect(queued).rejects.toBeInstanceOf(SemaphoreClosedError);

		semaphore.close();
		semaphore.close(new Error("ignored second close"));
		await queuedAssertion;
		await expect(semaphore.acquire()).rejects.toBeInstanceOf(SemaphoreClosedError);
		expect(semaphore.active).toBe(1);
		expect(semaphore.queued).toBe(0);
		first.release();
		expect(semaphore.active).toBe(0);
	});
});

describe("CancelableInFlightRegistry", () => {
	type Metadata = { readonly admissionAt: number };

	it("coalesces a compatible key into one producer and one shared value", async () => {
		const registry = new CancelableInFlightRegistry<string, Metadata, { readonly snapshot: string }>();
		const result = deferred<{ readonly snapshot: string }>();
		let starts = 0;
		const first = registry.run("same", { metadata: { admissionAt: 10 } }, () => {
			starts += 1;
			return result.promise;
		});
		const second = registry.run("same", { metadata: { admissionAt: 10 } }, () => {
			throw new Error("joined producer must not run");
		});

		await flushMicrotasks();
		expect(starts).toBe(1);
		expect(registry.activeRequests).toBe(1);
		expect(registry.waitingCallers).toBe(2);
		const shared = { snapshot: "one" } as const;
		result.resolve(shared);
		expect(await first).toBe(shared);
		expect(await second).toBe(shared);
		expect(registry.activeRequests).toBe(0);
	});

	it("cancels one waiter without aborting the producer needed by another", async () => {
		const registry = new CancelableInFlightRegistry<string, Metadata, string>();
		const result = deferred<string>();
		const firstController = new AbortController();
		let producerSignal: AbortSignal | undefined;
		const first = registry.run("same", { metadata: { admissionAt: 10 }, signal: firstController.signal }, (signal) => {
			producerSignal = signal;
			return result.promise;
		});
		const second = registry.run("same", { metadata: { admissionAt: 10 } }, () => "unused");
		await flushMicrotasks();

		const reason = new Error("only first caller stopped");
		const firstRejected = expect(first).rejects.toBe(reason);
		firstController.abort(reason);
		await firstRejected;
		expect(producerSignal?.aborted).toBe(false);
		expect(registry.waitingCallers).toBe(1);

		result.resolve("shared result");
		expect(await second).toBe("shared result");
	});

	it("aborts the underlying producer only after every waiter cancels", async () => {
		const registry = new CancelableInFlightRegistry<string, Metadata, string>();
		const firstController = new AbortController();
		const secondController = new AbortController();
		let producerSignal: AbortSignal | undefined;
		const producer = (signal: AbortSignal) => {
			producerSignal = signal;
			return new Promise<string>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		};
		const first = registry.run("same", { metadata: { admissionAt: 10 }, signal: firstController.signal }, producer);
		const second = registry.run("same", { metadata: { admissionAt: 10 }, signal: secondController.signal }, producer);
		await flushMicrotasks();

		const firstReason = new Error("first stopped");
		const secondReason = new Error("second stopped");
		const firstRejected = expect(first).rejects.toBe(firstReason);
		const secondRejected = expect(second).rejects.toBe(secondReason);
		firstController.abort(firstReason);
		await firstRejected;
		expect(producerSignal?.aborted).toBe(false);
		secondController.abort(secondReason);
		await secondRejected;
		expect(producerSignal?.aborted).toBe(true);
		expect(producerSignal?.reason).toBeInstanceOf(AllWaitersAbortedError);
		expect(registry.activeRequests).toBe(0);
	});

	it("uses metadata compatibility and can keep multiple attempts for one base key", async () => {
		const registry = new CancelableInFlightRegistry<string, Metadata, string>();
		const oldResult = deferred<string>();
		const freshResult = deferred<string>();
		let starts = 0;
		const old = registry.run("open-key", { metadata: { admissionAt: 10 } }, () => {
			starts += 1;
			return oldResult.promise;
		});
		const fresh = registry.run(
			"open-key",
			{ metadata: { admissionAt: 20 }, canJoin: ({ admissionAt }) => admissionAt >= 20 },
			() => {
				starts += 1;
				return freshResult.promise;
			},
		);
		const alsoFresh = registry.run(
			"open-key",
			{ metadata: { admissionAt: 21 }, canJoin: ({ admissionAt }) => admissionAt >= 15 },
			() => "must join the newer attempt",
		);
		await flushMicrotasks();

		expect(starts).toBe(2);
		expect(registry.activeRequests).toBe(2);
		oldResult.resolve("old");
		freshResult.resolve("fresh");
		expect(await old).toBe("old");
		expect(await fresh).toBe("fresh");
		expect(await alsoFresh).toBe("fresh");
	});

	it("lets live callers refuse older in-flight work while remaining joinable by later cache-ok callers", async () => {
		const registry = new CancelableInFlightRegistry<string, Metadata, string>();
		const olderResult = deferred<string>();
		const liveResult = deferred<string>();
		let starts = 0;
		const older = registry.run("search-key", { metadata: { admissionAt: 10 } }, () => {
			starts += 1;
			return olderResult.promise;
		});
		const live = registry.run("search-key", { metadata: { admissionAt: 20 }, joinExisting: false }, () => {
			starts += 1;
			return liveResult.promise;
		});
		const cacheOk = registry.run("search-key", { metadata: { admissionAt: 21 } }, () => "must join live");
		await flushMicrotasks();

		expect(starts).toBe(2);
		olderResult.resolve("older");
		liveResult.resolve("live");
		expect(await older).toBe("older");
		expect(await live).toBe("live");
		expect(await cacheOk).toBe("live");
	});

	it("lifecycle cleanup aborts producers, rejects waiters, and close rejects future work", async () => {
		const registry = new CancelableInFlightRegistry<string, Metadata, string>();
		let producerSignal: AbortSignal | undefined;
		const pending = registry.run("key", { metadata: { admissionAt: 10 } }, (signal) => {
			producerSignal = signal;
			return new Promise<string>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		});
		await flushMicrotasks();

		const cleanup = new Error("generation changed");
		const rejected = expect(pending).rejects.toBe(cleanup);
		registry.abortAll(cleanup);
		await rejected;
		expect(producerSignal?.aborted).toBe(true);
		expect(registry.activeRequests).toBe(0);
		expect(await registry.run("new", { metadata: { admissionAt: 20 } }, () => "new result")).toBe("new result");

		registry.close();
		await expect(registry.run("closed", { metadata: { admissionAt: 30 } }, () => "never")).rejects.toBeInstanceOf(
			InFlightRegistryClosedError,
		);
	});

	it("does not start work for a caller whose signal is already aborted", async () => {
		const registry = new CancelableInFlightRegistry<string, Metadata, string>();
		const controller = new AbortController();
		const reason = new Error("already stopped");
		controller.abort(reason);
		let starts = 0;

		await expect(
			registry.run("key", { metadata: { admissionAt: 10 }, signal: controller.signal }, () => {
				starts += 1;
				return "never";
			}),
		).rejects.toBe(reason);
		expect(starts).toBe(0);
	});
});
