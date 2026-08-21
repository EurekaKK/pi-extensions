import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { FakePiHost } from "test-host";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TODO_TOOL_NAME } from "../src/constants.js";
import { loadTodoExtension } from "../src/index.js";

class LoadingHarness {
	readonly host = new FakePiHost({ mode: "tui", hasUI: true });

	get registeredTools(): readonly { name: string; description?: string }[] {
		return this.host.tools;
	}

	get notify(): FakePiHost["ui"]["notify"] {
		return this.host.ui.notify;
	}

	async sessionStart(): Promise<void> {
		await this.host.emit("session_start", { type: "session_start" });
	}
}

describe("Todo extension config loading", () => {
	let agentDir: string;

	beforeEach(async () => {
		agentDir = await mkdtemp(join(tmpdir(), "todo-load-"));
	});

	afterEach(async () => {
		await rm(agentDir, { recursive: true, force: true });
	});

	it("loads config, creates the default file, and registers todo_write", async () => {
		const harness = new LoadingHarness();
		await loadTodoExtension(harness.host.api, { agentDir, withFileMutationQueue });

		expect(harness.registeredTools).toHaveLength(1);
		expect(harness.registeredTools[0]?.name).toBe(TODO_TOOL_NAME);
		expect(harness.registeredTools[0]?.description).toContain("AT MOST ONE");
	});

	it("loads without a tool and notifies once when config is invalid", async () => {
		const configDir = join(agentDir, "todo");
		await mkdir(configDir, { recursive: true, mode: 0o700 });
		await writeFile(join(configDir, "config.json"), '{"version":1,"extra":true}', { mode: 0o600 });

		const harness = new LoadingHarness();
		await loadTodoExtension(harness.host.api, { agentDir, withFileMutationQueue });

		expect(harness.registeredTools).toHaveLength(0);
		await harness.sessionStart();
		expect(harness.notify).toHaveBeenCalledTimes(1);
		expect(String(harness.notify.mock.calls[0]?.[0])).toContain("Todo is disabled");
	});
});
