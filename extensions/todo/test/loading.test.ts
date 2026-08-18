import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TODO_TOOL_NAME } from "../src/constants.js";
import { loadTodoExtension } from "../src/index.js";

type Handler = (event: Record<string, unknown>, context: ExtensionContext) => unknown | Promise<unknown>;

interface CapturedTool {
	readonly name: string;
	readonly description: string;
}

class LoadingHarness {
	readonly registeredTools: CapturedTool[] = [];
	readonly notify = vi.fn();
	readonly api: ExtensionAPI;
	readonly context: ExtensionContext;
	#handlers = new Map<string, Handler[]>();

	constructor(hasUI = true) {
		this.context = {
			mode: "tui",
			hasUI,
			ui: { notify: this.notify },
		} as unknown as ExtensionContext;
		this.api = {
			on: (event: string, handler: Handler) => {
				const handlers = this.#handlers.get(event) ?? [];
				handlers.push(handler);
				this.#handlers.set(event, handlers);
			},
			registerTool: (tool: CapturedTool) => {
				this.registeredTools.push(tool);
			},
		} as unknown as ExtensionAPI;
	}

	async sessionStart(): Promise<void> {
		for (const handler of this.#handlers.get("session_start") ?? []) {
			await handler({ type: "session_start" }, this.context);
		}
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
		await loadTodoExtension(harness.api, { agentDir, withFileMutationQueue });

		expect(harness.registeredTools).toHaveLength(1);
		expect(harness.registeredTools[0]?.name).toBe(TODO_TOOL_NAME);
		expect(harness.registeredTools[0]?.description).toContain("AT MOST ONE");
	});

	it("loads without a tool and notifies once when config is invalid", async () => {
		const configDir = join(agentDir, "todo");
		await mkdir(configDir, { recursive: true, mode: 0o700 });
		await writeFile(join(configDir, "config.json"), '{"version":1,"extra":true}', { mode: 0o600 });

		const harness = new LoadingHarness();
		await loadTodoExtension(harness.api, { agentDir, withFileMutationQueue });

		expect(harness.registeredTools).toHaveLength(0);
		await harness.sessionStart();
		expect(harness.notify).toHaveBeenCalledTimes(1);
		expect(String(harness.notify.mock.calls[0]?.[0])).toContain("Todo is disabled");
	});
});
