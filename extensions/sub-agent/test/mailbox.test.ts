import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ResultSpoolMetadata } from "../sidecar/protocol.js";
import {
	type ClaimedDelivery,
	type DeliveryRecord,
	Mailbox,
	MailboxError,
	type TerminalCommit,
	type WaitSatisfied,
} from "../src/mailbox.js";
import { spoolBasenameForDelivery } from "../src/spool.js";

let spoolRoot = "";

beforeEach(async () => {
	spoolRoot = await mkdtemp(join(tmpdir(), "sub-agent-mailbox-test-"));
	await chmod(spoolRoot, 0o700);
});

afterEach(async () => {
	if (spoolRoot.length > 0) await rm(spoolRoot, { recursive: true, force: true });
});

function createMailbox(onIntegrityFailure: (delivery: DeliveryRecord) => void = () => undefined): Mailbox {
	return new Mailbox({
		spoolRoot,
		observeRunState: () => "RUNNING",
		onIntegrityFailure,
	});
}

function failedCommit(runId: string, overrides: Partial<TerminalCommit> = {}): TerminalCommit {
	return {
		deliveryId: `delivery-${runId}`,
		agentId: `agent-${runId}`,
		runId,
		completedAt: 100,
		workerGeneration: 1,
		outcome: "FAILED",
		failureCode: "SUBAGENT_MODEL_RUN_FAILED",
		...overrides,
	};
}

function resultCommit(runId: string, deliveryId: string, spool: ResultSpoolMetadata): TerminalCommit {
	return {
		deliveryId,
		agentId: `agent-${runId}`,
		runId,
		completedAt: 100,
		workerGeneration: 1,
		outcome: "RESULT",
		spool,
	};
}

function requireSatisfied(resolution: Awaited<ReturnType<Mailbox["wait"]>>): asserts resolution is WaitSatisfied {
	if (resolution.status !== "SATISFIED") throw new Error("expected a satisfied wait");
}

async function expectMailboxError(promise: Promise<unknown>, code: MailboxError["code"]): Promise<void> {
	try {
		await promise;
		throw new Error("expected mailbox operation to fail");
	} catch (error) {
		expect(error).toBeInstanceOf(MailboxError);
		expect((error as MailboxError).code).toBe(code);
	}
}

async function writeResultSpool(deliveryId: string, text: string): Promise<ResultSpoolMetadata> {
	const bytes = Buffer.from(text, "utf8");
	const basename = spoolBasenameForDelivery(deliveryId);
	await writeFile(join(spoolRoot, basename), bytes, { mode: 0o600 });
	await chmod(join(spoolRoot, basename), 0o600);
	return {
		basename,
		byteSize: bytes.byteLength,
		digest: createHash("sha256").update(bytes).digest("hex"),
	};
}

describe("wait selection and reservations", () => {
	it("wait any chooses the globally earliest READY delivery and preserves remaining input order", async () => {
		const mailbox = createMailbox();
		mailbox.registerRun("r1");
		mailbox.registerRun("r2");
		mailbox.registerRun("r3");
		mailbox.commitTerminal(failedCommit("r2"));
		mailbox.commitTerminal(failedCommit("r1"));
		mailbox.commitTerminal(failedCommit("r3"));

		const resolution = await mailbox.wait(["r1", "r3", "r2"], "any", 0);
		requireSatisfied(resolution);
		expect(resolution.selectedRunIds).toEqual(["r2"]);
		expect(resolution.remainingRunIds).toEqual(["r1", "r3"]);
	});

	it("wait all claims only after every run is READY and preserves caller run order", async () => {
		const mailbox = createMailbox();
		mailbox.registerRun("r1");
		mailbox.registerRun("r2");
		const pending = mailbox.wait(["r1", "r2"], "all", undefined);
		mailbox.commitTerminal(failedCommit("r2"));
		let resolved = false;
		void pending.then(() => {
			resolved = true;
		});
		await Promise.resolve();
		expect(resolved).toBe(false);

		mailbox.commitTerminal(failedCommit("r1"));
		const resolution = await pending;
		requireSatisfied(resolution);
		expect(resolution.selectedRunIds).toEqual(["r1", "r2"]);
		const renderedOrder: string[] = [];
		const claimed = await mailbox.claimAndRender(resolution.waitId, "tool-all", (deliveries) => {
			renderedOrder.push(...deliveries.map((delivery) => delivery.runId));
			return "rendered";
		});
		expect(renderedOrder).toEqual(["r1", "r2"]);
		expect(claimed.deliveries.map((delivery) => delivery.runId)).toEqual(["r1", "r2"]);
	});

	it("reserves every requested run and rejects any overlapping wait as a whole", async () => {
		const mailbox = createMailbox();
		mailbox.registerRun("r1");
		mailbox.registerRun("r2");
		const controller = new AbortController();
		const first = mailbox.wait(["r1", "r2"], "all", undefined, controller.signal);
		await expectMailboxError(mailbox.wait(["r2"], "any", 0), "SUBAGENT_WAIT_CONFLICT");
		controller.abort();
		await expect(first).rejects.toMatchObject({ name: "AbortError" });

		const retry = await mailbox.wait(["r2"], "any", 0);
		expect(retry).toMatchObject({ status: "TIMEOUT", pending: [{ runId: "r2", state: "RUNNING" }] });
	});

	it("keeps a satisfied wait reserved until claim/release", async () => {
		const mailbox = createMailbox();
		mailbox.registerRun("r1");
		mailbox.commitTerminal(failedCommit("r1"));
		const first = await mailbox.wait(["r1"], "any", 0);
		requireSatisfied(first);
		await expectMailboxError(mailbox.wait(["r1"], "any", 0), "SUBAGENT_WAIT_CONFLICT");
		mailbox.release(first.waitId);
		const retry = await mailbox.wait(["r1"], "any", 0);
		requireSatisfied(retry);
	});

	it("linearizes both 0ms poll orders without consuming a later delivery", async () => {
		const mailbox = createMailbox();
		mailbox.registerRun("ready-first");
		mailbox.commitTerminal(failedCommit("ready-first"));
		const satisfied = await mailbox.wait(["ready-first"], "any", 0);
		requireSatisfied(satisfied);

		mailbox.registerRun("timeout-first");
		const timedOut = await mailbox.wait(["timeout-first"], "any", 0);
		expect(timedOut).toMatchObject({
			status: "TIMEOUT",
			pending: [{ runId: "timeout-first", state: "RUNNING" }],
		});
		mailbox.commitTerminal(failedCommit("timeout-first"));
		const nextPoll = await mailbox.wait(["timeout-first"], "any", 0);
		requireSatisfied(nextPoll);
		expect(nextPoll.selectedRunIds).toEqual(["timeout-first"]);
	});
});

describe("claim and persistence barriers", () => {
	it("rolls a CLAIMED delivery back to READY and makes it claimable again", async () => {
		const mailbox = createMailbox();
		mailbox.registerRun("r1");
		mailbox.commitTerminal(failedCommit("r1"));
		const resolution = await mailbox.wait(["r1"], "any", 0);
		requireSatisfied(resolution);
		await mailbox.claimAndRender(resolution.waitId, "tool-rollback", () => "failed envelope");
		expect(mailbox.get("r1")?.state).toBe("CLAIMED");

		mailbox.rollback("tool-rollback");
		expect(mailbox.get("r1")).toMatchObject({ state: "READY" });
		const retry = await mailbox.wait(["r1"], "any", 0);
		requireSatisfied(retry);
	});

	it("keeps AWAITING_PERSISTENCE reserved and confirms it only at the persistence barrier", async () => {
		const mailbox = createMailbox();
		mailbox.registerRun("r1");
		mailbox.commitTerminal(failedCommit("r1"));
		const resolution = await mailbox.wait(["r1"], "any", 0);
		requireSatisfied(resolution);
		await mailbox.claimAndRender(resolution.waitId, "tool-persist", () => "failed envelope");
		mailbox.markAwaitingPersistence("tool-persist");
		expect(mailbox.get("r1")).toMatchObject({
			state: "AWAITING_PERSISTENCE",
			toolCallId: "tool-persist",
		});
		await expectMailboxError(mailbox.wait(["r1"], "any", 0), "SUBAGENT_WAIT_CONFLICT");

		await mailbox.confirmPersisted("tool-persist");
		expect(mailbox.get("r1")?.state).toBe("DELIVERED");
		await expectMailboxError(mailbox.wait(["r1"], "any", 0), "SUBAGENT_RUN_ALREADY_DELIVERED");
	});

	it("reconciles an unpersisted AWAITING_PERSISTENCE result back to READY", async () => {
		const mailbox = createMailbox();
		mailbox.registerRun("r1");
		mailbox.commitTerminal(failedCommit("r1"));
		const resolution = await mailbox.wait(["r1"], "any", 0);
		requireSatisfied(resolution);
		await mailbox.claimAndRender(resolution.waitId, "tool-missing", () => "failed envelope");
		mailbox.markAwaitingPersistence("tool-missing");

		await mailbox.reconcile("tool-missing", false);
		expect(mailbox.get("r1")).toMatchObject({ state: "READY" });
		expect(mailbox.get("r1")?.toolCallId).toBeUndefined();
		const retry = await mailbox.wait(["r1"], "any", 0);
		requireSatisfied(retry);
	});

	it("deletes a verified RESULT spool only after persistence confirmation", async () => {
		const mailbox = createMailbox();
		const metadata = await writeResultSpool("delivery-result", "verified report");
		mailbox.registerRun("result");
		mailbox.commitTerminal(resultCommit("result", "delivery-result", metadata));
		const resolution = await mailbox.wait(["result"], "any", 0);
		requireSatisfied(resolution);
		const claimed = await mailbox.claimAndRender(resolution.waitId, "tool-result", (deliveries) => {
			return deliveries[0]?.report ?? "";
		});
		expect(claimed.content).toBe("verified report");
		expect(await lstat(join(spoolRoot, metadata.basename))).toBeDefined();

		mailbox.markAwaitingPersistence("tool-result");
		await mailbox.confirmPersisted("tool-result");
		await expect(lstat(join(spoolRoot, metadata.basename))).rejects.toMatchObject({ code: "ENOENT" });
	});
});

describe("RESULT integrity revalidation", () => {
	it("downgrades a tampered READY RESULT in place and never returns suspect report bytes", async () => {
		const integrityFailures: DeliveryRecord[] = [];
		const mailbox = createMailbox((delivery) => integrityFailures.push(delivery));
		const metadata = await writeResultSpool("delivery-tampered", "trusted bytes");
		mailbox.registerRun("tampered");
		mailbox.commitTerminal(resultCommit("tampered", "delivery-tampered", metadata));
		await writeFile(join(spoolRoot, metadata.basename), "forged!bytes", { mode: 0o600 });

		const resolution = await mailbox.wait(["tampered"], "any", 0);
		requireSatisfied(resolution);
		let rendered: readonly ClaimedDelivery[] = [];
		const claimed = await mailbox.claimAndRender(resolution.waitId, "tool-tampered", (deliveries) => {
			rendered = deliveries;
			return "synthetic failure";
		});

		expect(claimed.isError).toBe(true);
		expect(rendered).toHaveLength(1);
		expect(rendered[0]).toMatchObject({
			deliveryId: "delivery-tampered",
			runId: "tampered",
			outcome: "FAILED",
			failureCode: "SUBAGENT_DELIVERY_INTEGRITY_FAILED",
		});
		expect(rendered[0]?.report).toBeUndefined();
		expect(integrityFailures).toHaveLength(1);
		expect(integrityFailures[0]).toMatchObject({
			deliveryId: "delivery-tampered",
			outcome: "FAILED",
			failureCode: "SUBAGENT_DELIVERY_INTEGRITY_FAILED",
		});
	});
});
