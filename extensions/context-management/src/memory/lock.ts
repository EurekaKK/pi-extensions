import { randomBytes, randomInt } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rmdir, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { LOCK_HEARTBEAT_MS, LOCK_STALE_MS, LOCK_TIMEOUT_MS } from "../constants.js";
import { ContextManagementError, errorMessage, throwIfAborted } from "../errors.js";

interface LockOwner {
	readonly pid: number;
	readonly hostname: string;
	readonly nonce: string;
	readonly createdAt: string;
	readonly heartbeatAt: string;
}

function ownerPath(lockDirectory: string): string {
	return join(lockDirectory, "owner.json");
}

function parseOwner(value: unknown): LockOwner | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (
		!Number.isSafeInteger(record.pid) ||
		(record.pid as number) <= 0 ||
		typeof record.hostname !== "string" ||
		record.hostname.length === 0 ||
		typeof record.nonce !== "string" ||
		record.nonce.length === 0 ||
		typeof record.createdAt !== "string" ||
		!Number.isFinite(Date.parse(record.createdAt)) ||
		typeof record.heartbeatAt !== "string" ||
		!Number.isFinite(Date.parse(record.heartbeatAt))
	) {
		return null;
	}
	return {
		pid: record.pid as number,
		hostname: record.hostname,
		nonce: record.nonce,
		createdAt: record.createdAt,
		heartbeatAt: record.heartbeatAt,
	};
}

async function readOwner(lockDirectory: string): Promise<LockOwner | null> {
	try {
		return parseOwner(JSON.parse(await readFile(ownerPath(lockDirectory), "utf8")) as unknown);
	} catch {
		return null;
	}
}

async function atomicOwnerWrite(lockDirectory: string, owner: LockOwner): Promise<void> {
	const target = ownerPath(lockDirectory);
	const temp = join(lockDirectory, `.owner-${owner.nonce}-${randomBytes(6).toString("hex")}.tmp`);
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(temp, "wx", 0o600);
		await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
		await handle.sync();
		await handle.close();
		handle = undefined;
		await rename(temp, target);
	} catch (error) {
		await handle?.close().catch(() => undefined);
		await unlink(temp).catch(() => undefined);
		throw error;
	}
}

function isProcessDefinitelyDead(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH";
	}
}

async function stealStaleLock(lockDirectory: string): Promise<boolean> {
	const contents = await readdir(lockDirectory).catch(() => null);
	if (contents === null || contents.length !== 1 || contents[0] !== "owner.json") return false;
	const owner = await readOwner(lockDirectory);
	if (owner === null || owner.hostname !== hostname()) return false;
	if (Date.now() - Date.parse(owner.heartbeatAt) <= LOCK_STALE_MS || !isProcessDefinitelyDead(owner.pid)) return false;

	const stalePath = join(
		dirname(lockDirectory),
		`.${basename(lockDirectory)}.stale-${process.pid}-${randomBytes(8).toString("hex")}`,
	);
	try {
		await rename(lockDirectory, stalePath);
		await unlink(ownerPath(stalePath));
		await rmdir(stalePath);
		return true;
	} catch (error) {
		throw new ContextManagementError(
			"context_management.memory_lock_timeout",
			`Failed to quarantine and clean stale memory lock ${lockDirectory}: ${errorMessage(error)}`,
		);
	}
}

export interface MemoryLock {
	readonly owner: LockOwner;
	assertHealthy(): void;
	release(): Promise<void>;
}

async function ownLock(lockDirectory: string): Promise<MemoryLock> {
	const now = new Date().toISOString();
	const owner: LockOwner = Object.freeze({
		pid: process.pid,
		hostname: hostname(),
		nonce: randomBytes(16).toString("hex"),
		createdAt: now,
		heartbeatAt: now,
	});
	await atomicOwnerWrite(lockDirectory, owner);

	let released = false;
	let heartbeatError: unknown;
	let heartbeatChain = Promise.resolve();
	const timer = setInterval(() => {
		heartbeatChain = heartbeatChain
			.then(async () => {
				if (released) return;
				const current = await readOwner(lockDirectory);
				if (current?.nonce !== owner.nonce) throw new Error("Memory lock ownership changed.");
				await atomicOwnerWrite(lockDirectory, { ...owner, heartbeatAt: new Date().toISOString() });
			})
			.catch((error: unknown) => {
				heartbeatError = error;
			});
	}, LOCK_HEARTBEAT_MS);
	timer.unref();

	return {
		owner,
		assertHealthy() {
			if (heartbeatError !== undefined) {
				throw new ContextManagementError(
					"context_management.memory_lock_timeout",
					`Memory lock heartbeat failed: ${errorMessage(heartbeatError)}`,
				);
			}
		},
		async release() {
			if (released) return;
			released = true;
			clearInterval(timer);
			await heartbeatChain;
			const current = await readOwner(lockDirectory);
			if (current?.nonce !== owner.nonce) {
				throw new ContextManagementError(
					"context_management.memory_lock_timeout",
					`Memory lock ownership changed before release: ${lockDirectory}.`,
				);
			}
			await unlink(ownerPath(lockDirectory));
			await rmdir(lockDirectory);
		},
	};
}

export async function acquireMemoryLock(lockDirectory: string, signal?: AbortSignal): Promise<MemoryLock> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < LOCK_TIMEOUT_MS) {
		throwIfAborted(signal);
		try {
			await mkdir(lockDirectory, { mode: 0o700 });
			try {
				return await ownLock(lockDirectory);
			} catch (error) {
				await rmdir(lockDirectory).catch(() => undefined);
				throw error;
			}
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== "EEXIST") throw error;
			if (await stealStaleLock(lockDirectory)) continue;
		}
		const remaining = LOCK_TIMEOUT_MS - (Date.now() - startedAt);
		if (remaining <= 0) break;
		try {
			await delay(Math.min(remaining, randomInt(25, 101)), undefined, signal === undefined ? undefined : { signal });
		} catch (error) {
			throwIfAborted(signal);
			throw error;
		}
	}
	throw new ContextManagementError(
		"context_management.memory_lock_timeout",
		`Timed out after ${LOCK_TIMEOUT_MS}ms waiting for memory lock ${lockDirectory}.`,
	);
}
