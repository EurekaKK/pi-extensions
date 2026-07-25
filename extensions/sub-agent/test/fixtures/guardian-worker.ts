import { type ChildProcess, type Serializable, spawn } from "node:child_process";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Writable } from "node:stream";
import type { BootstrapFrame, ProtocolEnvelope } from "../../sidecar/protocol.js";

const FIXTURE_MODE = process.env.PI_SUBAGENT_TEST_FIXTURE_MODE ?? "normal";
const OUTPUT_CHUNK = Buffer.alloc(256 * 1024, "x");
const OUTPUT_CHUNK_COUNT = 32;

let identity: ProtocolEnvelope | undefined;
let descendant: ChildProcess | undefined;
let actionStarted = false;
let inbound = Promise.resolve();

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBootstrap(value: unknown): value is BootstrapFrame {
	return (
		isRecord(value) &&
		value.type === "BOOTSTRAP" &&
		value.protocolVersion === 1 &&
		typeof value.sessionNonce === "string" &&
		typeof value.managerEpoch === "string" &&
		typeof value.workerGeneration === "number"
	);
}

function currentEnvelope(): ProtocolEnvelope {
	if (!identity) throw new Error("Fixture Worker has not received BOOTSTRAP.");
	return identity;
}

async function sendFrame(frame: Serializable): Promise<void> {
	if (!process.send || !process.connected) throw new Error("Fixture Worker IPC is unavailable.");
	await new Promise<void>((resolveSend, rejectSend) => {
		process.send?.(frame, (error) => {
			if (error) rejectSend(error);
			else resolveSend();
		});
	});
}

async function writeChunk(stream: Writable, chunk: Buffer): Promise<void> {
	await new Promise<void>((resolveWrite, rejectWrite) => {
		stream.write(chunk, (error) => {
			if (error) rejectWrite(error);
			else resolveWrite();
		});
	});
}

async function floodOutput(): Promise<void> {
	for (let index = 0; index < OUTPUT_CHUNK_COUNT; index += 1) {
		await Promise.all([writeChunk(process.stdout, OUTPUT_CHUNK), writeChunk(process.stderr, OUTPUT_CHUNK)]);
	}
	await sendFrame({
		type: "WORKER_WARNING",
		...currentEnvelope(),
		code: "fixture_flood_complete",
	});
}

async function startDescendant(): Promise<void> {
	if (descendant) return;
	descendant = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'], {
		detached: false,
		stdio: "ignore",
	});
	await once(descendant, "spawn");
	if (typeof descendant.pid !== "number") throw new Error("Fixture descendant did not expose a PID.");
	await sendFrame({
		type: "WORKER_WARNING",
		...currentEnvelope(),
		code: `fixture_descendant_ready:${descendant.pid}`,
	});
}

async function sendProtocolMismatch(): Promise<void> {
	const envelope = currentEnvelope();
	await sendFrame({
		type: "WORKER_WARNING",
		...envelope,
		managerEpoch: `${envelope.managerEpoch}-mismatch`,
		code: "fixture_protocol_mismatch",
	});
}

async function sendOversizeFrame(): Promise<void> {
	await sendFrame({
		type: "WORKER_WARNING",
		...currentEnvelope(),
		code: "x".repeat(1024 * 1024),
	});
}

async function handleAction(value: Record<string, unknown>): Promise<void> {
	if (value.type === "SHUTDOWN") {
		if (process.connected) process.disconnect();
		process.exit(0);
	}

	if (FIXTURE_MODE === "descendant" && value.type === "KILL") {
		process.kill(process.pid, "SIGKILL");
		return;
	}
	if (value.type !== "SEND" || actionStarted) return;
	actionStarted = true;

	switch (FIXTURE_MODE) {
		case "flood":
			await floodOutput();
			break;
		case "descendant":
			await startDescendant();
			break;
		case "protocol":
			await sendProtocolMismatch();
			break;
		case "oversize":
			await sendOversizeFrame();
			break;
		case "echo":
			await sendFrame({
				type: "WORKER_WARNING",
				...currentEnvelope(),
				code: `fixture_echo:${String(value.message)}`,
			});
			actionStarted = false;
			break;
		default:
			break;
	}
}

async function handleMessage(value: unknown): Promise<void> {
	if (!identity) {
		if (!isBootstrap(value)) throw new Error("Fixture Worker expected BOOTSTRAP.");
		identity = {
			protocolVersion: value.protocolVersion,
			sessionNonce: value.sessionNonce,
			managerEpoch: value.managerEpoch,
			workerGeneration: value.workerGeneration,
		};
		if (FIXTURE_MODE === "hang-handshake") {
			await writeFile(join(process.cwd(), "hang-handshake.pid"), String(process.pid), { mode: 0o600 });
			return;
		}
		await sendFrame({
			type: "WORKER_READY",
			...identity,
			workerPid: process.pid,
			workerPgid: process.pid,
			piVersion: "guardian-fixture-1",
		});
		return;
	}
	if (!isRecord(value)) throw new Error("Fixture Worker received a non-object control frame.");
	await handleAction(value);
}

process.on("message", (value: unknown) => {
	inbound = inbound.then(async () => {
		await handleMessage(value);
	});
	inbound.catch(() => {
		process.exit(2);
	});
});
