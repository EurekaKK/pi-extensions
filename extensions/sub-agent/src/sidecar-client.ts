import { type ChildProcess, spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
	assertControlMessageWithinLimit,
	type BootstrapFrame,
	type ChildFrame,
	isChildFrame,
	matchesProtocolIdentity,
	type ParentFrame,
	type ProtocolEnvelope,
	type ShutdownFrame,
} from "../sidecar/protocol.js";

export interface SidecarIdentity {
	sessionNonce: string;
	managerEpoch: string;
	workerGeneration: number;
}

export interface SidecarLaunchOptions {
	identity: SidecarIdentity;
	bootstrap: BootstrapFrame;
	guardianPath?: string;
	signal?: AbortSignal;
}

export interface SidecarProcessInfo {
	guardianPid: number;
	workerPid: number;
	workerPgid: number;
	piVersion: string;
}

export type SidecarFrameListener = (frame: ChildFrame) => void | Promise<void>;
export type SidecarExitListener = (exit: {
	code: number | null;
	signal: NodeJS.Signals | null;
}) => void | Promise<void>;

function defaultGuardianPath(): string {
	return fileURLToPath(new URL("../dist/sidecar/guardian.js", import.meta.url));
}

function abortError(): Error {
	const error = new Error("Sidecar launch aborted.");
	error.name = "AbortError";
	return error;
}

function isNoSuchProcess(error: unknown): boolean {
	return (
		typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ESRCH"
	);
}

function processGroupExists(pgid: number): boolean {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (error) {
		if (isNoSuchProcess(error)) return false;
		throw error;
	}
}

async function delay(milliseconds: number): Promise<void> {
	await new Promise<void>((resolve) => {
		setTimeout(resolve, milliseconds);
	});
}

async function waitForProcessGroupExit(pgid: number, deadlineAt: number): Promise<boolean> {
	while (Date.now() < deadlineAt) {
		if (!processGroupExists(pgid)) return true;
		await delay(Math.min(25, Math.max(1, deadlineAt - Date.now())));
	}
	return !processGroupExists(pgid);
}

async function waitForChildExit(child: ChildProcess, deadlineAt: number): Promise<boolean> {
	if (child.exitCode !== null || child.signalCode !== null) return true;
	const remaining = deadlineAt - Date.now();
	if (remaining <= 0) return false;
	return await new Promise<boolean>((resolve) => {
		let settled = false;
		const finish = (exited: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.off("exit", onExit);
			resolve(exited);
		};
		const onExit = () => finish(true);
		const timer = setTimeout(() => finish(false), remaining);
		timer.unref();
		child.once("exit", onExit);
		if (child.exitCode !== null || child.signalCode !== null) finish(true);
	});
}

async function cleanupFailedHandshake(
	child: ChildProcess,
	lease: Writable,
	workerPgid: number | undefined,
): Promise<void> {
	if (!lease.destroyed && !lease.writableEnded) lease.end();
	const startedAt = Date.now();
	const termAt = startedAt + 2000;
	const killAt = startedAt + 3000;
	const deadlineAt = startedAt + 4000;

	await waitForChildExit(child, termAt);
	if (workerPgid !== undefined) {
		if (processGroupExists(workerPgid)) {
			try {
				process.kill(-workerPgid, "SIGTERM");
			} catch (error) {
				if (!isNoSuchProcess(error)) throw error;
			}
			await waitForProcessGroupExit(workerPgid, killAt);
		}
		if (processGroupExists(workerPgid)) {
			try {
				process.kill(-workerPgid, "SIGKILL");
			} catch (error) {
				if (!isNoSuchProcess(error)) throw error;
			}
			await waitForProcessGroupExit(workerPgid, deadlineAt);
		}
	}
	if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	await waitForChildExit(child, deadlineAt);
}

export class SidecarClient {
	readonly identity: SidecarIdentity;
	readonly processInfo: SidecarProcessInfo;

	private readonly child: ChildProcess;
	private readonly lease: Writable;
	private readonly frameListeners = new Set<SidecarFrameListener>();
	private readonly exitListeners = new Set<SidecarExitListener>();
	private frameSequence = Promise.resolve();
	private exited = false;
	private exitResult: { code: number | null; signal: NodeJS.Signals | null } | undefined;
	private exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
	private resolveExit!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void;

	private constructor(
		child: ChildProcess,
		lease: Writable,
		identity: SidecarIdentity,
		processInfo: SidecarProcessInfo,
	) {
		this.child = child;
		this.lease = lease;
		this.identity = identity;
		this.processInfo = processInfo;
		this.exitPromise = new Promise((resolve) => {
			this.resolveExit = resolve;
		});
		this.attachRuntimeListeners();
		if (child.exitCode !== null || child.signalCode !== null) {
			this.recordExit(child.exitCode, child.signalCode);
		}
	}

	static async launch(options: SidecarLaunchOptions): Promise<SidecarClient> {
		const guardianPath = options.guardianPath ?? defaultGuardianPath();
		await access(guardianPath, fsConstants.R_OK);
		assertControlMessageWithinLimit(options.bootstrap);

		if (options.signal?.aborted) throw abortError();

		const child = spawn(process.execPath, [guardianPath], {
			detached: true,
			env: { ...process.env },
			serialization: "advanced",
			stdio: ["ignore", "pipe", "pipe", "ipc", "pipe"],
		});
		child.stdout?.resume();
		child.stderr?.resume();

		const leaseCandidate = child.stdio[4];
		if (!(leaseCandidate instanceof Writable)) {
			child.kill("SIGKILL");
			throw new Error("Guardian lease channel was not created.");
		}

		const processInfo = await SidecarClient.performHandshake(
			child,
			leaseCandidate,
			options.identity,
			options.bootstrap,
			options.signal,
		);
		return new SidecarClient(child, leaseCandidate, options.identity, processInfo);
	}

	private static async performHandshake(
		child: ChildProcess,
		lease: Writable,
		identity: SidecarIdentity,
		bootstrap: BootstrapFrame,
		signal: AbortSignal | undefined,
	): Promise<SidecarProcessInfo> {
		return await new Promise<SidecarProcessInfo>((resolve, reject) => {
			let settled = false;
			let guardian: Extract<ChildFrame, { type: "GUARDIAN_READY" }> | undefined;
			let worker: Extract<ChildFrame, { type: "WORKER_READY" }> | undefined;

			const finishError = (error: Error) => {
				if (settled) return;
				settled = true;
				cleanup();
				const workerPgid = guardian?.workerPgid ?? worker?.workerPgid;
				void cleanupFailedHandshake(child, lease, workerPgid)
					.catch(() => {
						if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
					})
					.finally(() => reject(error));
			};

			const finishIfReady = () => {
				if (settled || !guardian || !worker) return;
				if (guardian.workerPid !== worker.workerPid || guardian.workerPgid !== worker.workerPgid) {
					finishError(new Error("Guardian and Worker handshake identities disagree."));
					return;
				}
				settled = true;
				cleanup();
				resolve({
					guardianPid: guardian.guardianPid,
					workerPid: worker.workerPid,
					workerPgid: worker.workerPgid,
					piVersion: worker.piVersion,
				});
			};

			const onMessage = (value: unknown) => {
				if (!isChildFrame(value) || !matchesProtocolIdentity(value, identity)) {
					finishError(new Error("SUBAGENT_PROTOCOL_MISMATCH"));
					return;
				}
				if (value.type === "GUARDIAN_READY") guardian = value;
				if (value.type === "WORKER_READY") worker = value;
				if (value.type === "PROTOCOL_ERROR") finishError(new Error(value.code));
				finishIfReady();
			};

			const onError = (error: Error) => finishError(error);
			const onExit = (code: number | null, exitSignal: NodeJS.Signals | null) =>
				finishError(new Error(`Guardian exited during startup (code=${String(code)}, signal=${String(exitSignal)}).`));
			const onAbort = () => finishError(abortError());

			const cleanup = () => {
				child.off("message", onMessage);
				child.off("error", onError);
				child.off("exit", onExit);
				signal?.removeEventListener("abort", onAbort);
			};

			child.on("message", onMessage);
			child.once("error", onError);
			child.once("exit", onExit);
			signal?.addEventListener("abort", onAbort, { once: true });
			if (signal?.aborted) {
				finishError(abortError());
				return;
			}

			if (!child.send) {
				finishError(new Error("Guardian IPC channel is unavailable."));
				return;
			}
			child.send(bootstrap, (error) => {
				if (error) finishError(error);
			});
		});
	}

	private attachRuntimeListeners(): void {
		this.child.on("message", (value: unknown) => {
			if (!isChildFrame(value) || !matchesProtocolIdentity(value, this.identity)) {
				this.frameSequence = this.frameSequence.then(async () => {
					await this.emitFrame({
						type: "PROTOCOL_ERROR",
						protocolVersion: 1,
						...this.identity,
						code: "SUBAGENT_PROTOCOL_MISMATCH",
					});
				});
				return;
			}
			this.frameSequence = this.frameSequence.then(async () => {
				await this.emitFrame(value);
			});
		});

		this.child.once("exit", (code, signal) => this.recordExit(code, signal));
	}

	private recordExit(code: number | null, signal: NodeJS.Signals | null): void {
		if (this.exited) return;
		this.exited = true;
		this.exitResult = { code, signal };
		this.resolveExit(this.exitResult);
		this.frameSequence = this.frameSequence.then(async () => {
			for (const listener of this.exitListeners) await listener(this.exitResult as NonNullable<typeof this.exitResult>);
		});
	}

	private async emitFrame(frame: ChildFrame): Promise<void> {
		for (const listener of this.frameListeners) await listener(frame);
	}

	onFrame(listener: SidecarFrameListener): () => void {
		this.frameListeners.add(listener);
		return () => this.frameListeners.delete(listener);
	}

	onExit(listener: SidecarExitListener): () => void {
		this.exitListeners.add(listener);
		if (this.exitResult) {
			void listener(this.exitResult);
		}
		return () => this.exitListeners.delete(listener);
	}

	async send(frame: ParentFrame): Promise<void> {
		if (this.exited || !this.child.connected || !this.child.send) {
			throw new Error("SUBAGENT_IPC_LOST");
		}
		if (!matchesProtocolIdentity(frame, this.identity)) {
			throw new Error("SUBAGENT_PROTOCOL_MISMATCH");
		}
		assertControlMessageWithinLimit(frame);
		await new Promise<void>((resolve, reject) => {
			this.child.send?.(frame, (error) => {
				if (error) reject(error);
				else resolve();
			});
		});
	}

	closeLease(): void {
		if (!this.lease.destroyed && !this.lease.writableEnded) this.lease.end();
	}

	async requestShutdown(deadlineAt: number): Promise<void> {
		const frame: ShutdownFrame = {
			type: "SHUTDOWN",
			protocolVersion: 1,
			...this.identity,
			deadlineAt,
		};
		try {
			await this.send(frame);
		} finally {
			this.closeLease();
		}
	}

	async waitForExit(deadlineAt: number): Promise<boolean> {
		if (this.exited) return true;
		const remaining = deadlineAt - Date.now();
		if (remaining <= 0) return false;
		const timeout = new Promise<false>((resolve) => {
			const timer = setTimeout(() => resolve(false), remaining);
			timer.unref();
		});
		return await Promise.race([this.exitPromise.then(() => true), timeout]);
	}

	async forceCleanup(deadlineAt = Date.now() + 2000): Promise<void> {
		const termDeadline = Math.min(deadlineAt, Date.now() + 1000);
		try {
			process.kill(-this.processInfo.workerPgid, "SIGTERM");
		} catch (error) {
			if (!isNoSuchProcess(error)) throw error;
		}
		if (!(await waitForProcessGroupExit(this.processInfo.workerPgid, termDeadline))) {
			try {
				process.kill(-this.processInfo.workerPgid, "SIGKILL");
			} catch (error) {
				if (!isNoSuchProcess(error)) throw error;
			}
			await waitForProcessGroupExit(this.processInfo.workerPgid, deadlineAt);
		}

		if (!this.exited) this.child.kill("SIGKILL");
		await this.waitForExit(deadlineAt);
	}

	envelope(): ProtocolEnvelope {
		return {
			protocolVersion: 1,
			...this.identity,
		};
	}
}
