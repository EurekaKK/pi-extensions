import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import type { BootstrapFrame, ChildFrame, KillFrame, SendFrame } from "../sidecar/protocol.js";
import { SidecarClient } from "../src/sidecar-client.js";

const TEST_MODE_ENV = "PI_SUBAGENT_GUARDIAN_TEST_MODE";
const TEST_ROOT_ENV = "PI_SUBAGENT_GUARDIAN_TEST_ROOT";
const TEST_WORKER_ENV = "PI_SUBAGENT_GUARDIAN_TEST_WORKER_PATH";
const TEST_TOKEN_ENV = "PI_SUBAGENT_GUARDIAN_TEST_TOKEN";
const FIXTURE_MODE_ENV = "PI_SUBAGENT_TEST_FIXTURE_MODE";
const MANAGED_ENV_NAMES = [TEST_MODE_ENV, TEST_ROOT_ENV, TEST_WORKER_ENV, TEST_TOKEN_ENV, FIXTURE_MODE_ENV] as const;

interface LaunchedFixture {
	readonly client: SidecarClient;
	readonly caseRoot: string;
	readonly spoolDir: string;
}

interface PendingFixture {
	readonly launch: Promise<SidecarClient>;
	readonly caseRoot: string;
	readonly spoolDir: string;
}

interface TrackedClient {
	readonly client: SidecarClient;
	exited: boolean;
}

const guardianPath = fileURLToPath(new URL("../dist/sidecar/guardian.js", import.meta.url));
const fixtureSourcePath = fileURLToPath(new URL("./fixtures/guardian-worker.ts", import.meta.url));
const originalEnvironment = new Map<string, string | undefined>();
const trackedClients: TrackedClient[] = [];
const caseRoots = new Set<string>();

let testRoot = "";
let fixtureWorkerPath = "";
let fixtureToken = "";

function isNoSuchProcess(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
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

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return false;
		throw error;
	}
}

async function waitForPidFile(path: string, timeoutMs = 2_000): Promise<number> {
	const deadlineAt = Date.now() + timeoutMs;
	while (Date.now() < deadlineAt) {
		try {
			const pid = Number.parseInt(await readFile(path, "utf8"), 10);
			if (Number.isSafeInteger(pid) && pid > 0) return pid;
		} catch (error) {
			if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw error;
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${path}.`);
}

async function processGroupId(pid: number): Promise<number> {
	return await new Promise<number>((resolvePgid, rejectPgid) => {
		execFile("/bin/ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }, (error, stdout) => {
			if (error) {
				rejectPgid(error);
				return;
			}
			const pgid = Number.parseInt(stdout.trim(), 10);
			if (!Number.isSafeInteger(pgid) || pgid <= 0) {
				rejectPgid(new Error(`Unable to parse PGID for PID ${pid}.`));
				return;
			}
			resolvePgid(pgid);
		});
	});
}

function waitForFrame(
	client: SidecarClient,
	predicate: (frame: ChildFrame) => boolean,
	timeoutMs = 6_000,
): Promise<ChildFrame> {
	return new Promise<ChildFrame>((resolveFrame, rejectFrame) => {
		let stopExit = () => {};
		const timer = setTimeout(() => {
			stopFrame();
			stopExit();
			rejectFrame(new Error(`Timed out waiting for a Guardian frame after ${timeoutMs}ms.`));
		}, timeoutMs);
		const stopFrame = client.onFrame((frame) => {
			if (!predicate(frame)) return;
			clearTimeout(timer);
			stopFrame();
			stopExit();
			resolveFrame(frame);
		});
		stopExit = client.onExit((exit) => {
			clearTimeout(timer);
			stopFrame();
			stopExit();
			rejectFrame(
				new Error(
					`Guardian exited before the expected frame (code=${String(exit.code)}, signal=${String(exit.signal)}).`,
				),
			);
		});
	});
}

function sendFrame(client: SidecarClient, suffix: string): SendFrame {
	return {
		type: "SEND",
		...client.envelope(),
		opId: `send-${suffix}`,
		agentId: "fixture-agent",
		runId: "fixture-run",
		deliveryId: `delivery-${suffix}`,
		message: suffix,
	};
}

function killFrame(client: SidecarClient): KillFrame {
	return {
		type: "KILL",
		...client.envelope(),
		opId: "kill-fixture",
		agentId: "fixture-agent",
		lastRunId: "fixture-run",
	};
}

async function startFixture(mode: string, signal?: AbortSignal): Promise<PendingFixture> {
	process.env[FIXTURE_MODE_ENV] = mode;
	const caseRoot = await realpath(await mkdtemp(join(testRoot, "case-")));
	caseRoots.add(caseRoot);
	const agentDir = join(caseRoot, "agents");
	const piPackageDir = join(caseRoot, "pi-package");
	const spoolDir = join(caseRoot, "spool");
	const selfExtensionPath = join(caseRoot, "extension.ts");
	await Promise.all([
		mkdir(agentDir),
		mkdir(piPackageDir),
		mkdir(spoolDir, { mode: 0o700 }),
		writeFile(selfExtensionPath, "export default () => {};\n", { mode: 0o600 }),
	]);
	await chmod(spoolDir, 0o700);

	const identity = {
		sessionNonce: randomUUID(),
		managerEpoch: randomUUID(),
		workerGeneration: 1,
	};
	const bootstrap: BootstrapFrame = {
		type: "BOOTSTRAP",
		protocolVersion: 1,
		...identity,
		parentPid: process.pid,
		cwd: caseRoot,
		agentDir,
		piPackageDir,
		spoolDir,
		selfExtensionPath,
		settingsSnapshot: { __guardianFixtureToken: fixtureToken },
		projectTrusted: false,
	};
	const launch = SidecarClient.launch({
		guardianPath,
		identity,
		bootstrap,
		...(signal === undefined ? {} : { signal }),
	});
	return { launch, caseRoot, spoolDir };
}

async function launchFixture(mode: string): Promise<LaunchedFixture> {
	const pending = await startFixture(mode);
	const client = await pending.launch;
	const tracked: TrackedClient = { client, exited: false };
	trackedClients.push(tracked);
	client.onExit(() => {
		tracked.exited = true;
	});
	return { client, caseRoot: pending.caseRoot, spoolDir: pending.spoolDir };
}

async function requestCleanShutdown(fixture: LaunchedFixture): Promise<void> {
	const complete = waitForFrame(fixture.client, (frame) => frame.type === "SHUTDOWN_COMPLETE");
	await fixture.client.requestShutdown(Date.now() + 4_000);
	await complete;
	expect(await fixture.client.waitForExit(Date.now() + 2_000)).toBe(true);
	expect(processGroupExists(fixture.client.processInfo.workerPgid)).toBe(false);
	expect(await pathExists(fixture.spoolDir)).toBe(false);
}

beforeAll(async () => {
	for (const name of MANAGED_ENV_NAMES) originalEnvironment.set(name, process.env[name]);
	testRoot = await realpath(await mkdtemp(join(tmpdir(), "subagent-guardian-test-")));
	await chmod(testRoot, 0o700);
	fixtureToken = `${randomUUID()}${randomUUID()}`;
	fixtureWorkerPath = join(testRoot, "guardian-worker.mjs");
	const fixtureSource = await readFile(fixtureSourcePath, "utf8");
	const fixtureJavaScript = stripTypeScriptTypes(fixtureSource, {
		mode: "transform",
		sourceMap: false,
		sourceUrl: fixtureSourcePath,
	});
	await writeFile(fixtureWorkerPath, fixtureJavaScript, { mode: 0o600 });
	await chmod(fixtureWorkerPath, 0o600);
	process.env[TEST_MODE_ENV] = "1";
	process.env[TEST_ROOT_ENV] = testRoot;
	process.env[TEST_WORKER_ENV] = fixtureWorkerPath;
	process.env[TEST_TOKEN_ENV] = fixtureToken;
});

afterEach(async () => {
	for (const tracked of trackedClients.splice(0)) {
		if (!tracked.exited) await tracked.client.forceCleanup(Date.now() + 3_000);
	}
	for (const caseRoot of caseRoots) await rm(caseRoot, { recursive: true, force: true });
	caseRoots.clear();
});

afterAll(async () => {
	for (const [name, value] of originalEnvironment) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	if (testRoot) await rm(testRoot, { recursive: true, force: true });
});

const describePosix = process.platform === "win32" ? describe.skip : describe;

describePosix.sequential("Guardian sidecar", () => {
	test("runs Guardian and Worker in distinct detached process groups", async () => {
		const fixture = await launchFixture("normal");
		expect(fixture.client.processInfo.piVersion).toBe("guardian-fixture-1");
		expect(await processGroupId(fixture.client.processInfo.guardianPid)).toBe(fixture.client.processInfo.guardianPid);
		expect(await processGroupId(fixture.client.processInfo.workerPid)).toBe(fixture.client.processInfo.workerPid);
		expect(fixture.client.processInfo.workerPgid).toBe(fixture.client.processInfo.workerPid);
		await requestCleanShutdown(fixture);
	});

	test("treats lease EOF as shutdown and proves the Worker did not inherit the lease", async () => {
		const fixture = await launchFixture("normal");
		const complete = waitForFrame(fixture.client, (frame) => frame.type === "SHUTDOWN_COMPLETE");
		fixture.client.closeLease();
		await complete;
		expect(await fixture.client.waitForExit(Date.now() + 2_000)).toBe(true);
		expect(processGroupExists(fixture.client.processInfo.workerPgid)).toBe(false);
		expect(await pathExists(fixture.spoolDir)).toBe(false);
	});

	test("aborts an in-flight handshake through lease cleanup without orphaning the Worker group", async () => {
		const controller = new AbortController();
		const pending = await startFixture("hang-handshake", controller.signal);
		const markerPath = join(pending.caseRoot, "hang-handshake.pid");
		try {
			const workerPgid = await waitForPidFile(markerPath);
			expect(processGroupExists(workerPgid)).toBe(true);

			controller.abort();
			await expect(pending.launch).rejects.toMatchObject({ name: "AbortError" });
			expect(processGroupExists(workerPgid)).toBe(false);
			expect(await pathExists(pending.spoolDir)).toBe(false);
		} finally {
			controller.abort();
			await pending.launch.then(async (client) => client.forceCleanup(Date.now() + 3_000)).catch(() => undefined);
		}
	});

	test("drains high-volume Worker stdout and stderr without blocking control IPC", async () => {
		const fixture = await launchFixture("flood");
		const flooded = waitForFrame(
			fixture.client,
			(frame) => frame.type === "WORKER_WARNING" && frame.code === "fixture_flood_complete",
			10_000,
		);
		await fixture.client.send(sendFrame(fixture.client, "flood"));
		await flooded;
		await requestCleanShutdown(fixture);
	});

	test("proxies Parent frames and Worker frames in FIFO order", async () => {
		const fixture = await launchFixture("echo");
		const observed: string[] = [];
		const stop = fixture.client.onFrame((frame) => {
			if (frame.type === "WORKER_WARNING" && frame.code.startsWith("fixture_echo:")) observed.push(frame.code);
		});
		const third = waitForFrame(
			fixture.client,
			(frame) => frame.type === "WORKER_WARNING" && frame.code === "fixture_echo:three",
		);
		await Promise.all([
			fixture.client.send(sendFrame(fixture.client, "one")),
			fixture.client.send(sendFrame(fixture.client, "two")),
			fixture.client.send(sendFrame(fixture.client, "three")),
		]);
		await third;
		stop();
		expect(observed).toEqual(["fixture_echo:one", "fixture_echo:two", "fixture_echo:three"]);
		await requestCleanShutdown(fixture);
	});

	test("kills the exact Worker process group, including a TERM-resistant descendant, on Worker loss", async () => {
		const fixture = await launchFixture("descendant");
		const descendantReady = waitForFrame(
			fixture.client,
			(frame) => frame.type === "WORKER_WARNING" && frame.code.startsWith("fixture_descendant_ready:"),
		);
		await fixture.client.send(sendFrame(fixture.client, "spawn-descendant"));
		const readyFrame = await descendantReady;
		if (readyFrame.type !== "WORKER_WARNING") throw new Error("Expected descendant readiness warning.");
		const descendantPid = Number.parseInt(readyFrame.code.slice("fixture_descendant_ready:".length), 10);
		expect(await processGroupId(descendantPid)).toBe(fixture.client.processInfo.workerPgid);

		const observed: ChildFrame["type"][] = [];
		const stop = fixture.client.onFrame((frame) => {
			observed.push(frame.type);
		});
		const cleaned = waitForFrame(fixture.client, (frame) => frame.type === "LOSS_CLEANED");
		await fixture.client.send(killFrame(fixture.client));
		await cleaned;
		stop();
		expect(observed.indexOf("WORKER_EXITED")).toBeGreaterThanOrEqual(0);
		expect(observed.indexOf("LOSS_CLEANED")).toBeGreaterThan(observed.indexOf("WORKER_EXITED"));
		expect(processGroupExists(fixture.client.processInfo.workerPgid)).toBe(false);
		expect(await pathExists(fixture.spoolDir)).toBe(true);
		expect(await fixture.client.waitForExit(Date.now() + 2_000)).toBe(true);
	});

	test.each(["protocol", "oversize"])(
		"loss-cleans before reporting a %s Worker protocol violation and preserves committed spool state",
		async (mode) => {
			const fixture = await launchFixture(mode);
			const observed: ChildFrame["type"][] = [];
			const stop = fixture.client.onFrame((frame) => {
				observed.push(frame.type);
			});
			const protocolError = waitForFrame(fixture.client, (frame) => frame.type === "PROTOCOL_ERROR", 8_000);
			await fixture.client.send(sendFrame(fixture.client, mode));
			const errorFrame = await protocolError;
			stop();
			if (errorFrame.type !== "PROTOCOL_ERROR") throw new Error("Expected protocol error.");
			expect(errorFrame.code).toBe("SUBAGENT_PROTOCOL_MISMATCH");
			expect(observed.indexOf("LOSS_CLEANED")).toBeGreaterThan(observed.indexOf("WORKER_EXITED"));
			expect(observed.indexOf("PROTOCOL_ERROR")).toBeGreaterThan(observed.indexOf("LOSS_CLEANED"));
			expect(processGroupExists(fixture.client.processInfo.workerPgid)).toBe(false);
			expect(await pathExists(fixture.spoolDir)).toBe(true);
			expect(await fixture.client.waitForExit(Date.now() + 2_000)).toBe(true);
		},
	);
});
