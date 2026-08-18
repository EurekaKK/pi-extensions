import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STATUS_COMMAND } from "../src/constants.js";
import { loadContextManagementExtension } from "../src/index.js";

type Handler = (event: Record<string, unknown>, context: ExtensionContext) => unknown | Promise<unknown>;

class LoadingHarness {
	readonly registeredTools: unknown[] = [];
	readonly registeredCommands: string[] = [];
	readonly notify = vi.fn();
	readonly api: ExtensionAPI;
	readonly context: ExtensionContext;
	#handlers = new Map<string, Handler[]>();

	constructor() {
		this.context = {
			mode: "tui",
			hasUI: true,
			ui: { notify: this.notify },
		} as unknown as ExtensionContext;
		this.api = {
			on: (event: string, handler: Handler) => {
				const handlers = this.#handlers.get(event) ?? [];
				handlers.push(handler);
				this.#handlers.set(event, handlers);
			},
			registerTool: (tool: unknown) => {
				this.registeredTools.push(tool);
			},
			registerCommand: (name: string) => {
				this.registeredCommands.push(name);
			},
		} as unknown as ExtensionAPI;
	}

	async sessionStart(): Promise<void> {
		for (const handler of this.#handlers.get("session_start") ?? []) {
			await handler({ type: "session_start" }, this.context);
		}
	}
}

describe("context-management loading", () => {
	let agentDir: string;

	beforeEach(async () => {
		agentDir = await mkdtemp(join(tmpdir(), "cm-load-"));
	});

	afterEach(async () => {
		await rm(agentDir, { recursive: true, force: true });
	});

	it("loads defaults, registers no tools, and registers the status command", async () => {
		const harness = new LoadingHarness();
		await loadContextManagementExtension(harness.api, { agentDir, withFileMutationQueue });
		expect(harness.registeredTools).toEqual([]);
		expect(harness.registeredCommands).toEqual([STATUS_COMMAND]);
	});

	it("disables the extension and notifies once when config is invalid", async () => {
		const configDir = join(agentDir, "context-management");
		await mkdir(configDir, { recursive: true, mode: 0o700 });
		await writeFile(join(configDir, "config.json"), '{"version":1,"extra":true}', { mode: 0o600 });
		const harness = new LoadingHarness();
		await loadContextManagementExtension(harness.api, { agentDir, withFileMutationQueue });
		expect(harness.registeredTools).toEqual([]);
		expect(harness.registeredCommands).toEqual([]);
		await harness.sessionStart();
		expect(harness.notify).toHaveBeenCalledTimes(1);
		expect(String(harness.notify.mock.calls[0]?.[0])).toContain("context-management is disabled");
	});
});
