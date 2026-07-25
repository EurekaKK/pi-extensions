import {
	type BootstrapFrame,
	type ChildFrame,
	isControlMessageWithinLimit,
	isParentFrame,
	type ProtocolErrorFrame,
	SUBAGENT_PROTOCOL_VERSION,
} from "./protocol.js";
import { WorkerRuntime } from "./worker-runtime.js";

async function sendFrame(frame: ChildFrame): Promise<void> {
	if (!process.send || !process.connected) throw new Error("SUBAGENT_IPC_LOST");
	if (!isControlMessageWithinLimit(frame)) throw new Error("SUBAGENT_CONTROL_MESSAGE_TOO_LARGE");
	await new Promise<void>((resolve, reject) => {
		process.send?.(frame, (error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}

async function sendBootstrapError(frame: BootstrapFrame): Promise<void> {
	const errorFrame: ProtocolErrorFrame = {
		type: "PROTOCOL_ERROR",
		protocolVersion: SUBAGENT_PROTOCOL_VERSION,
		sessionNonce: frame.sessionNonce,
		managerEpoch: frame.managerEpoch,
		workerGeneration: frame.workerGeneration,
		code: "SUBAGENT_PI_API_UNSUPPORTED",
	};
	await sendFrame(errorFrame).catch(() => undefined);
}

export async function runWorkerProcess(): Promise<number> {
	if (process.env.PI_SUBAGENT_WORKER !== "1" || !process.send) {
		throw new Error("The sub-agent Worker must be launched by its Guardian.");
	}

	let runtime: WorkerRuntime | undefined;
	let finished = false;
	let resolveDone!: (exitCode: number) => void;
	const done = new Promise<number>((resolve) => {
		resolveDone = resolve;
	});
	let inbound = Promise.resolve();

	const finish = (exitCode: number): void => {
		if (finished) return;
		finished = true;
		process.off("message", onMessage);
		process.off("disconnect", onDisconnect);
		if (process.connected) process.disconnect();
		resolveDone(exitCode);
	};

	const fail = async (): Promise<void> => {
		if (finished) return;
		await runtime?.shutdown().catch(() => undefined);
		finish(1);
	};

	const handleMessage = async (value: unknown): Promise<void> => {
		if (!isParentFrame(value) || !isControlMessageWithinLimit(value)) {
			await fail();
			return;
		}
		if (!runtime) {
			if (value.type !== "BOOTSTRAP") {
				await fail();
				return;
			}
			try {
				runtime = await WorkerRuntime.bootstrap(value, {
					sendFrame,
					onFatal: () => {
						void fail();
					},
					onShutdownComplete: () => finish(0),
				});
				await runtime.sendReady();
			} catch {
				await sendBootstrapError(value);
				finish(1);
			}
			return;
		}
		await runtime.handle(value);
	};

	const onMessage = (value: unknown): void => {
		inbound = inbound.then(() => handleMessage(value)).catch(() => fail());
	};
	const onDisconnect = (): void => {
		if (finished) return;
		inbound = inbound
			.then(async () => {
				await runtime?.shutdown();
				finish(0);
			})
			.catch(() => fail());
	};

	process.on("message", onMessage);
	process.once("disconnect", onDisconnect);
	return await done;
}

try {
	process.exitCode = await runWorkerProcess();
} catch {
	process.exitCode = 1;
	if (process.connected) process.disconnect();
}
