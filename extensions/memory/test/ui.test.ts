import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { FakePiHost } from "test-host";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { MEMORY_READ_TOOL, MEMORY_WRITE_TOOL } from "../src/constants.js";
import { registerMemoryExtension } from "../src/index.js";

const theme = {
	fg: (_color: string, value: string) => value,
	bold: (value: string) => value,
} as unknown as Theme;

interface RenderableTool {
	readonly name: string;
	readonly description?: string;
	execute(
		toolCallId: string,
		parameters: never,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		context: ExtensionContext,
	): Promise<{
		readonly content: readonly { readonly type: string; readonly text?: string }[];
		readonly details?: unknown;
	}>;
	renderCall(args: Record<string, unknown>, theme: Theme, context: unknown): { render(width: number): string[] };
	renderResult(
		result: {
			readonly content: readonly { readonly type: string; readonly text?: string }[];
			readonly details?: unknown;
		},
		options: { readonly expanded: boolean; readonly isPartial: boolean },
		theme: Theme,
		context: { readonly isError: boolean },
	): { render(width: number): string[] };
}

async function tempCwd(): Promise<string> {
	return mkdtemp(join(tmpdir(), "memory-ui-"));
}

const CONTENT =
	"The monorepo is managed with npm workspaces; never mix pnpm or Yarn. This sentence exists to make the content comfortably longer than the compact renderer.";

function toolAt(host: FakePiHost, name: string): RenderableTool {
	const tool = host.tools.find((candidate) => candidate.name === name);
	if (tool === undefined) throw new Error(`missing tool ${name}`);
	return tool as unknown as RenderableTool;
}

describe("memory compact/expanded TUI renderers", () => {
	it("renders a compact memory_write call line and full-content expanded results", async () => {
		const host = new FakePiHost({ cwd: await tempCwd(), mode: "tui", hasUI: true });
		registerMemoryExtension(host.api, DEFAULT_CONFIG);
		await host.emit("input", { type: "input", source: "interactive", text: "remember" });

		const write = toolAt(host, MEMORY_WRITE_TOOL);
		const callLines = write
			.renderCall({ operation: "add", summary: "npm workspaces", content: CONTENT }, theme, host.context)
			.render(120);
		expect(callLines.join("\n")).toContain("memory_write");
		expect(callLines.join("\n")).toContain("npm workspaces");

		const result = await write.execute(
			"write-1",
			{ operation: "add", summary: "npm workspaces", content: CONTENT } as never,
			undefined,
			undefined,
			host.context,
		);

		const expanded = write
			.renderResult(result, { expanded: true, isPartial: false }, theme, { isError: false })
			.render(200);
		expect(expanded.join("\n")).toContain(CONTENT);

		const collapsed = write
			.renderResult(result, { expanded: false, isPartial: false }, theme, { isError: false })
			.render(40);
		expect(collapsed.length).toBeLessThanOrEqual(4);
		expect(collapsed.join("\n")).toContain("memory_write");
		expect(collapsed.join("\n")).not.toContain("This sentence exists");
	});

	it("renders compact memory_read calls and results without raw JSON", async () => {
		const host = new FakePiHost({ cwd: await tempCwd(), mode: "tui", hasUI: true });
		registerMemoryExtension(host.api, DEFAULT_CONFIG);
		await host.emit("input", { type: "input", source: "interactive", text: "remember" });

		const write = toolAt(host, MEMORY_WRITE_TOOL);
		const written = await write.execute(
			"write-1",
			{ operation: "add", summary: "npm workspaces", content: CONTENT } as never,
			undefined,
			undefined,
			host.context,
		);
		const id = String((written.details as { record: { id: string } }).record.id);

		const read = toolAt(host, MEMORY_READ_TOOL);
		const callLines = read.renderCall({ id }, theme, host.context).render(120);
		expect(callLines.join("\n")).toContain("memory_read");
		expect(callLines.join("\n")).toContain(id);

		const result = await read.execute("read-1", { id } as never, undefined, undefined, host.context);
		const expanded = read
			.renderResult(result, { expanded: true, isPartial: false }, theme, { isError: false })
			.render(200);
		expect(expanded.join("\n")).toContain(CONTENT);
		expect(expanded.join("\n")).toContain(id);

		const collapsed = read
			.renderResult(result, { expanded: false, isPartial: false }, theme, { isError: false })
			.render(40);
		expect(collapsed.length).toBeLessThanOrEqual(4);
		expect(collapsed.join("\n")).toContain("memory_read");
	});
});

describe("memory_write supersede receipt TUI bound", () => {
	it("keeps compact results bounded while expanded results show both replaced and replacement content", async () => {
		const host = new FakePiHost({ cwd: await tempCwd(), mode: "tui", hasUI: true });
		registerMemoryExtension(host.api, DEFAULT_CONFIG);
		await host.emit("input", { type: "input", source: "interactive", text: "remember" });

		const write = toolAt(host, MEMORY_WRITE_TOOL);
		const added = await write.execute(
			"write-1",
			{ operation: "add", summary: "npm workspaces", content: CONTENT } as never,
			undefined,
			undefined,
			host.context,
		);
		const targetId = String((added.details as { record: { id: string } }).record.id);

		const result = await write.execute(
			"write-2",
			{
				operation: "supersede",
				targetId,
				targetRevision: 1,
				summary: "npm workspaces (corrected)",
				content: "CORRECTED monorepo guidance; this second sentence exists to exceed compact width safely.",
			} as never,
			undefined,
			undefined,
			host.context,
		);

		const details = result.details as { outcome: string; record: { id: string }; replaced: { id: string } };
		expect(details.outcome).toBe("superseded");
		expect(details.replaced.id).toBe(targetId);

		const expanded = write
			.renderResult(result, { expanded: true, isPartial: false }, theme, { isError: false })
			.render(200);
		const expandedText = expanded.join("\n");
		expect(expandedText).toContain(CONTENT);
		expect(expandedText).toContain(
			"CORRECTED monorepo guidance; this second sentence exists to exceed compact width safely.",
		);
		expect(expandedText).toContain("Replaced record");
		expect(expandedText).toContain(details.record.id);
		expect(expandedText).toContain(targetId);

		const collapsed = write
			.renderResult(result, { expanded: false, isPartial: false }, theme, { isError: false })
			.render(40);
		expect(collapsed.length).toBeLessThanOrEqual(4);
		const collapsedText = collapsed.join("\n");
		expect(collapsedText).toContain("memory_write");
		expect(collapsedText).not.toContain("exceed compact width safely");

		// The compact call line stays a single highlighted line.
		const callLines = write
			.renderCall(
				{ operation: "supersede", targetId, targetRevision: 1, summary: "npm workspaces (corrected)" },
				theme,
				host.context,
			)
			.render(120);
		expect(callLines.length).toBeLessThanOrEqual(2);
		expect(callLines.join("\n")).toContain("memory_write");
	});
});
