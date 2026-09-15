import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { FakePiHost } from "test-host";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIRECTORY_NAME, DEFAULT_CONFIG, getEurekaUiConfigPath } from "../src/config.js";
import { ACTIVITY_WIDGET_KEY, ACTIVITY_WIDGET_PLACEMENT, loadEurekaUi, registerEurekaUi } from "../src/index.js";

const theme = {
	fg: (_color: string, value: string) => value,
	bold: (value: string) => value,
} as unknown as Theme;

interface WidgetComponent {
	render(width: number): string[];
}

interface WidgetHandle {
	readonly component: WidgetComponent;
	readonly requestRender: ReturnType<typeof vi.fn>;
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryAgentDir(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "eureka-ui-index-"));
	temporaryDirectories.push(directory);
	return directory;
}

/** Registers the widget through `session_start` and returns the rendered component. */
async function startWidget(host: FakePiHost): Promise<WidgetHandle> {
	await host.emit("session_start", { type: "session_start", reason: "startup" });
	const call = host.ui.setWidget.mock.calls.at(-1);
	if (call === undefined) throw new Error("session_start did not register a widget");
	const [, factory] = call;
	const requestRender = vi.fn();
	const component = (factory as (tui: unknown, theme: Theme) => WidgetComponent)({ requestRender }, theme);
	return { component, requestRender };
}

describe("eureka-ui widget lifecycle", () => {
	it("registers once and follows the tool activity", async () => {
		const host = new FakePiHost();
		registerEurekaUi(host.api, DEFAULT_CONFIG);
		expect(host.tools).toHaveLength(7);

		const { component, requestRender } = await startWidget(host);
		expect(host.ui.setWidget).toHaveBeenCalledTimes(1);
		expect(host.ui.setWidget.mock.calls[0]?.[0]).toBe(ACTIVITY_WIDGET_KEY);
		expect(host.ui.setWidget.mock.calls[0]?.[2]).toEqual({ placement: ACTIVITY_WIDGET_PLACEMENT });
		expect(component.render(100)).toEqual([]);

		const args = { command: "npm test" };
		await host.emit("tool_execution_start", { toolCallId: "1", toolName: "bash", args });
		expect(component.render(100)[0]).toContain("Running npm test…");
		expect(requestRender).toHaveBeenCalled();

		await host.emit("tool_execution_end", {
			toolCallId: "1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		expect(component.render(100)[0]).toContain("Ran npm test · 0.0s");

		await host.emit("agent_settled", { type: "agent_settled" });
		expect(component.render(100)).toEqual([]);

		expect(host.ui.setWidget).toHaveBeenCalledTimes(1);
	});

	it("keeps a failure until the next user message and clears on shutdown", async () => {
		const host = new FakePiHost();
		registerEurekaUi(host.api, DEFAULT_CONFIG);
		const { component } = await startWidget(host);

		const args = { command: "npm test" };
		await host.emit("tool_execution_start", { toolCallId: "1", toolName: "bash", args });
		await host.emit("tool_execution_end", {
			toolCallId: "1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "boom\n\nCommand exited with code 1" }] },
			isError: true,
		});
		expect(component.render(100)[0]).toContain("Failed npm test · exit 1");

		await host.emit("agent_settled", { type: "agent_settled" });
		expect(component.render(100)[0]).toContain("Failed npm test · exit 1");

		await host.emit("message_start", { message: { role: "user" } });
		expect(component.render(100)).toEqual([]);

		await host.emit("session_shutdown", { type: "session_shutdown" });
		expect(host.ui.setWidget).toHaveBeenLastCalledWith(ACTIVITY_WIDGET_KEY, undefined, {
			placement: ACTIVITY_WIDGET_PLACEMENT,
		});
	});

	it("publishes plain lines instead of a component in rpc mode", async () => {
		const host = new FakePiHost({ mode: "rpc" });
		registerEurekaUi(host.api, DEFAULT_CONFIG);

		await host.emit("session_start", { type: "session_start", reason: "startup" });
		expect(host.ui.setWidget).toHaveBeenLastCalledWith(ACTIVITY_WIDGET_KEY, [], {
			placement: ACTIVITY_WIDGET_PLACEMENT,
		});

		await host.emit("tool_execution_start", { toolCallId: "1", toolName: "bash", args: { command: "npm test" } });
		expect(host.ui.setWidget).toHaveBeenLastCalledWith(ACTIVITY_WIDGET_KEY, ["Running npm test…"], {
			placement: ACTIVITY_WIDGET_PLACEMENT,
		});
	});

	it("keeps the transcript untouched when no dialog UI is available", async () => {
		const host = new FakePiHost({ mode: "print", hasUI: false });
		registerEurekaUi(host.api, DEFAULT_CONFIG);

		await host.emit("session_start", { type: "session_start", reason: "startup" });
		await host.emit("tool_execution_start", { toolCallId: "1", toolName: "bash", args: { command: "npm test" } });

		expect(host.ui.setWidget).not.toHaveBeenCalled();
		expect(host.tools).toHaveLength(7);
	});
});

describe("eureka-ui startup", () => {
	it("registers overrides and the widget when the config loads", async () => {
		const host = new FakePiHost();
		await loadEurekaUi(host.api, { agentDir: await temporaryAgentDir(), withFileMutationQueue });

		expect(host.tools.map((tool) => tool.name)).toEqual(["read", "bash", "edit", "write", "grep", "find", "ls"]);
		await host.emit("session_start", { type: "session_start", reason: "startup" });
		expect(host.ui.setWidget).toHaveBeenCalledTimes(1);
	});

	it("registers nothing and warns once when the config is corrupt", async () => {
		const agentDir = await temporaryAgentDir();
		const configPath = getEurekaUiConfigPath(agentDir);
		await mkdir(join(agentDir, CONFIG_DIRECTORY_NAME), { recursive: true });
		await writeFile(configPath, "{ not json");

		const host = new FakePiHost();
		await loadEurekaUi(host.api, { agentDir, withFileMutationQueue });

		expect(host.tools).toHaveLength(0);
		await host.emit("session_start", { type: "session_start", reason: "startup" });
		expect(host.ui.setWidget).not.toHaveBeenCalled();
		expect(host.ui.notify).toHaveBeenCalledTimes(1);
		expect(host.ui.notify.mock.calls[0]?.[0]).toContain("eureka-ui is disabled");

		await host.emit("session_start", { type: "session_start", reason: "reload" });
		expect(host.ui.notify).toHaveBeenCalledTimes(1);
	});
});
