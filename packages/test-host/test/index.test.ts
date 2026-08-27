import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FakePiHost } from "../src/index.js";

function appendUserMessageEntry(
	host: FakePiHost,
	id: string,
	parentId: string | null,
	content: string,
	timestamp: number,
): void {
	host.branchEntry(id, parentId, {
		type: "message",
		message: { role: "user", content, timestamp },
	});
}

describe("FakePiHost", () => {
	it("exposes the chosen Working Directory without touching the real project", () => {
		const cwd = join(tmpdir(), "fake-pi-working-directory");
		const host = new FakePiHost({ cwd });

		expect(host.context.cwd).toBe(cwd);
	});

	it("observes lifecycle handler results without changing the existing emit contract", async () => {
		const host = new FakePiHost();
		const injected = {
			message: {
				customType: "test-host:context",
				content: "Remember the selected context.",
				display: true,
			},
		};
		host.api.on("before_agent_start", () => injected);
		host.api.on("before_agent_start", () => ({ systemPrompt: "overridden prompt" }));

		await expect(
			host.emitResults("before_agent_start", {
				type: "before_agent_start",
				prompt: "continue",
				images: [],
				systemPrompt: "base prompt",
			}),
		).resolves.toEqual([injected, { systemPrompt: "overridden prompt" }]);
		await expect(host.emit("session_start", { type: "session_start", reason: "startup" })).resolves.toBeUndefined();
	});

	it("represents persisted custom messages on whichever branch is active", () => {
		const host = new FakePiHost();
		appendUserMessageEntry(host, "root", null, "start", 1);
		const root = host.branch()[0];
		if (root === undefined) throw new Error("missing root fixture");

		const firstId = host.appendCustomMessageEntry("test-host:recall", "first branch", true, {
			fingerprint: "first",
		});
		expect(host.branch().map((entry) => entry.id)).toEqual(["root", firstId]);
		expect(host.branch().at(-1)).toMatchObject({
			type: "custom_message",
			customType: "test-host:recall",
			content: "first branch",
			display: true,
			details: { fingerprint: "first" },
		});

		host.setBranch([root]);
		const forkId = host.appendCustomMessageEntry("test-host:recall", "forked branch", false);

		expect(host.context.sessionManager.getBranch().map((entry) => entry.id)).toEqual(["root", forkId]);
		expect(host.branch().at(-1)).toMatchObject({
			type: "custom_message",
			customType: "test-host:recall",
			content: "forked branch",
			display: false,
		});
	});

	it("does not reuse persisted entry ids after a branch fixture is restored", () => {
		const host = new FakePiHost();
		host.branchEntry("entry-1", null, {
			type: "custom",
			customType: "test-host:state",
			data: { restored: true },
		});

		expect(host.appendCustomMessageEntry("test-host:recall", "new context", true)).toBe("entry-2");
		host.api.appendEntry("test-host:state", { appended: true });
		expect(host.branch().at(-1)?.id).toBe("entry-3");
	});

	it("exposes Pi's model-visible branch after compaction", () => {
		const host = new FakePiHost();
		appendUserMessageEntry(host, "root", null, "original request", 1);
		const recalledId = host.appendCustomMessageEntry("test-host:recall", "recalled context", true, {
			fingerprint: "old-recall",
		});
		appendUserMessageEntry(host, "kept", recalledId, "latest request", 2);

		expect(host.context.sessionManager.buildContextEntries().map((entry) => entry.id)).toEqual([
			"root",
			recalledId,
			"kept",
		]);

		host.branchEntry("compaction", "kept", {
			type: "compaction",
			summary: "Summary of earlier context",
			firstKeptEntryId: "kept",
			tokensBefore: 2_000,
		});

		expect(host.context.sessionManager.buildContextEntries().map((entry) => entry.id)).toEqual(["compaction", "kept"]);
	});

	it("delivers event bus messages and supports unsubscribe", () => {
		const host = new FakePiHost();
		const handler = vi.fn();
		const unsubscribe = host.api.events.on("test:event", handler);

		host.api.events.emit("test:event", { value: 1 });
		expect(handler).toHaveBeenCalledWith({ value: 1 });
		unsubscribe();
		host.api.events.emit("test:event", { value: 2 });
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it("captures and invokes extension shortcuts", async () => {
		const host = new FakePiHost();
		const handler = vi.fn();
		host.api.registerShortcut("ctrl+alt+o", { description: "Switch view", handler });

		await host.invokeShortcut("ctrl+alt+o");
		expect(handler).toHaveBeenCalledWith(host.context);
	});
});
