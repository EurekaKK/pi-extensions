import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import registerContextManagementExtension from "../src/index.js";

describe("extension registration", () => {
	it("registers the five prefixed tools, status command, and compaction barrier hooks without side effects", () => {
		const tools: string[] = [];
		const commands: string[] = [];
		const events: string[] = [];
		const api = {
			registerTool: (tool: { readonly name: string }) => tools.push(tool.name),
			registerCommand: (name: string) => commands.push(name),
			on: (event: string) => events.push(event),
			getActiveTools: vi.fn(() => []),
			getAllTools: vi.fn(() => []),
		} as unknown as ExtensionAPI;
		registerContextManagementExtension(api);
		expect(tools.sort()).toEqual([
			"context_management_evidence_read",
			"context_management_memory_forget",
			"context_management_memory_read",
			"context_management_memory_search",
			"context_management_memory_write",
		]);
		expect(commands).toEqual(["context-management-status"]);
		expect(events).toEqual(
			expect.arrayContaining([
				"context",
				"session_before_compact",
				"session_compact",
				"before_agent_start",
				"agent_settled",
				"session_shutdown",
			]),
		);
	});
});
