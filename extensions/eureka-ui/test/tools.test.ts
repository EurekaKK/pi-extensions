import type { Theme } from "@earendil-works/pi-coding-agent";
import { FakePiHost } from "test-host";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { BuiltInToolName, EurekaUiConfigV1 } from "../src/domain.js";
import type { ToolResultLike } from "../src/format.js";
import {
	createBaseLookup,
	createToolOverride,
	type DelegatableTool,
	type RenderContext,
	type RowState,
	registerToolOverrides,
} from "../src/tools.js";

const theme = {
	fg: (_color: string, value: string) => value,
	bold: (value: string) => value,
} as unknown as Theme;

interface TestComponent {
	render(width: number): string[];
}

interface TestTool {
	readonly renderCall?: (args: unknown, theme: Theme, context: RenderContext) => TestComponent;
	readonly renderResult?: (
		result: ToolResultLike,
		options: { expanded: boolean; isPartial: boolean },
		theme: Theme,
		context: RenderContext,
	) => TestComponent;
}

function contextFor(state: RowState, overrides: Partial<RenderContext> = {}): RenderContext {
	return {
		args: {},
		cwd: "/tmp",
		expanded: false,
		isError: false,
		executionStarted: true,
		state,
		...overrides,
	};
}

interface TestDefinition extends TestTool {
	readonly description?: string;
	readonly parameters?: unknown;
	readonly renderShell?: string;
	readonly prepareArguments?: (args: unknown) => unknown;
}

function buildDefinition(name: BuiltInToolName, mode: "hidden" | "line"): TestDefinition {
	const lookup = createBaseLookup();
	const base = lookup(name, "/tmp");
	if (base === undefined) throw new Error(`${name} definition unavailable`);
	const source: Parameters<typeof createToolOverride>[2] = { metadata: base, forCwd: () => base };
	return createToolOverride(name, mode, source) as unknown as TestDefinition;
}

function buildOverride(name: BuiltInToolName, mode: "hidden" | "line"): TestTool {
	return buildDefinition(name, mode);
}

function configWith(mode: "hidden" | "line" | "native"): EurekaUiConfigV1 {
	const tools = { ...DEFAULT_CONFIG.tools };
	for (const name of Object.keys(tools) as BuiltInToolName[]) {
		tools[name] = { mode };
	}
	return { version: 1, tools };
}

function lines(component: TestComponent | undefined): string[] {
	return component === undefined ? [] : component.render(100);
}

function metadata(base: DelegatableTool | undefined): DelegatableTool {
	if (base === undefined) throw new Error("definition unavailable");
	return base;
}

describe("eureka-ui tool overrides", () => {
	it("registers every non-native built-in tool and leaves powershell alone", () => {
		const host = new FakePiHost();
		const registered = registerToolOverrides(host.api, DEFAULT_CONFIG, { cwd: "/tmp" });

		expect(registered).toEqual(["read", "bash", "edit", "write", "grep", "find", "ls"]);
		expect(host.tools.map((tool) => tool.name)).toEqual(["read", "bash", "edit", "write", "grep", "find", "ls"]);
		expect(registered).not.toContain("powershell");
	});

	it("registers nothing when every tool is native", () => {
		const host = new FakePiHost();
		expect(registerToolOverrides(host.api, configWith("native"), { cwd: "/tmp" })).toEqual([]);
		expect(host.tools).toHaveLength(0);
	});

	it("keeps prompt metadata from the built-in definition", () => {
		const host = new FakePiHost();
		registerToolOverrides(host.api, configWith("line"), { cwd: "/tmp" });
		const bash = host.tools.find((tool) => tool.name === "bash");
		expect(bash?.description).toBe(metadata(createBaseLookup()("bash", "/tmp")).description);
		expect(bash?.promptGuidelines).toEqual(metadata(createBaseLookup()("bash", "/tmp")).promptGuidelines);
	});

	it("renders no lines for a collapsed hidden tool", () => {
		const tool = buildOverride("read", "hidden");
		const state: RowState = {};
		expect(lines(tool.renderCall?.({ path: "src/index.ts" }, theme, contextFor(state)))).toEqual([]);
		expect(
			lines(
				tool.renderResult?.(
					{ content: [{ type: "text", text: "file body" }] },
					{ expanded: false, isPartial: false },
					theme,
					contextFor(state),
				),
			),
		).toEqual([]);
	});

	it("shows one failure line for a collapsed hidden tool", () => {
		const tool = buildOverride("read", "hidden");
		const state: RowState = {};
		const rendered = lines(
			tool.renderResult?.(
				{ content: [{ type: "text", text: "Error: file is missing" }] },
				{ expanded: false, isPartial: false },
				theme,
				contextFor(state, { isError: true, args: { path: "missing.ts" } }),
			),
		);
		expect(rendered).toHaveLength(1);
		expect(rendered[0]).toContain("read missing.ts");
		expect(rendered[0]).toContain("✗ Error: file is missing");
	});

	it("delegates to the built-in renderers when expanded", () => {
		const tool = buildOverride("read", "hidden");
		const state: RowState = {};
		const call = lines(tool.renderCall?.({ path: "src/index.ts" }, theme, contextFor(state, { expanded: true })));
		expect(call.length).toBeGreaterThan(0);
		expect(call.join("\n")).toContain("src/index.ts");
	});

	it("keeps a line tool on a single row while it runs and finishes", () => {
		const tool = buildOverride("bash", "line");
		const state: RowState = {};
		const call = lines(tool.renderCall?.({ command: "npm test" }, theme, contextFor(state)));
		expect(call).toHaveLength(1);
		expect(call[0]).toContain("$ npm test");

		const result = lines(
			tool.renderResult?.(
				{ content: [{ type: "text", text: "ok\nsecond" }] },
				{ expanded: false, isPartial: false },
				theme,
				contextFor(state, { args: { command: "npm test" } }),
			),
		);
		expect(result).toEqual([]);

		const updated = lines(state.line);
		expect(updated).toHaveLength(1);
		expect(updated[0]).toContain("$ npm test");
		expect(updated[0]).toContain("✓ 2 lines");
	});

	it("rewrites the same row when a line tool fails", () => {
		const tool = buildOverride("bash", "line");
		const state: RowState = {};
		const args = { command: "npm test" };
		expect(lines(tool.renderCall?.(args, theme, contextFor(state, { args })))).toHaveLength(1);

		const rendered = lines(
			tool.renderResult?.(
				{ content: [{ type: "text", text: "boom\n\nCommand exited with code 1" }] },
				{ expanded: false, isPartial: false },
				theme,
				contextFor(state, { args, isError: true }),
			),
		);
		expect(rendered).toEqual([]);
		const updated = lines(state.line);
		expect(updated).toHaveLength(1);
		expect(updated[0]).toContain("✗ exit 1");
	});

	it("inherits the built-in definition fields it does not render itself", () => {
		const base = metadata(createBaseLookup()("edit", "/tmp"));
		const override = buildDefinition("edit", "line");

		expect(override.parameters).toBe(base.parameters);
		expect(override.description).toBe(base.description);
		expect(override.renderShell).toBe("self");
		expect(typeof override.prepareArguments).toBe("function");
		expect(override.prepareArguments?.({ path: "a.ts", oldText: "x", newText: "y" })).toEqual({
			path: "a.ts",
			edits: [{ oldText: "x", newText: "y" }],
		});
		expect(override.prepareArguments?.({ path: "a.ts", edits: '[{"oldText":"x","newText":"y"}]' })).toEqual({
			path: "a.ts",
			edits: [{ oldText: "x", newText: "y" }],
		});
	});

	it("carries every field of every built-in definition into its override", () => {
		for (const name of ["read", "bash", "edit", "write", "grep", "find", "ls"] as const) {
			const base = metadata(createBaseLookup()(name, "/tmp"));
			const override = buildDefinition(name, "line");
			for (const field of Object.keys(base)) expect(override, `${name}.${field}`).toHaveProperty(field);
		}
	});
});
