import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { generateCheckpoint } from "../src/compaction/generator.js";
import { CHECKPOINT_PREAMBLE, COMPACTION_INSTRUCTION, SUMMARY_OPEN_TAG } from "../src/constants.js";
import { ContextManagementError } from "../src/errors.js";
import { userMessage } from "./harness.js";

describe("checkpoint generator", () => {
	it("replays system, tools, and the eight-section instruction, then frames the checkpoint", async () => {
		const { pi, context, faux } = createGeneratorHost();
		let sawInstruction = false;
		faux.setResponses([
			(request) => {
				const last = request.messages.at(-1);
				const lastText =
					last?.role === "user"
						? typeof last.content === "string"
							? last.content
							: last.content.find((block) => block.type === "text")?.text
						: undefined;
				sawInstruction =
					request.systemPrompt === "system prompt" &&
					request.tools?.some((tool) => tool.name === "bash") === true &&
					lastText === COMPACTION_INSTRUCTION;
				return fauxAssistantMessage("## Next Step\n- continue");
			},
		]);
		const generated = await generateCheckpoint({
			context,
			pi,
			messages: [userMessage("old work")],
			shadowedTokenCount: 10_000,
			maxTokens: 1_024,
			calibration: 1,
			regenerateOnce: false,
		});
		expect(sawInstruction).toBe(true);
		expect(generated.summary.startsWith(CHECKPOINT_PREAMBLE)).toBe(true);
		expect(generated.summary).toContain(`${SUMMARY_OPEN_TAG}\n## Next Step\n- continue`);
		expect(faux.state.callCount).toBe(1);
	});

	it("regenerates once after empty output", async () => {
		const { pi, context, faux } = createGeneratorHost();
		faux.setResponses([fauxAssistantMessage("   "), fauxAssistantMessage("## Current Work\n- still going")]);
		const generated = await generateCheckpoint({
			context,
			pi,
			messages: [userMessage("history")],
			shadowedTokenCount: 10_000,
			maxTokens: 1_024,
			calibration: 1,
			regenerateOnce: true,
		});
		expect(faux.state.callCount).toBe(2);
		expect(generated.summary).toContain("## Current Work");
	});

	it("aborts before calling the provider", async () => {
		const { pi, context, faux } = createGeneratorHost();
		await expect(
			generateCheckpoint({
				context,
				pi,
				messages: [userMessage("history")],
				shadowedTokenCount: 10_000,
				maxTokens: 1_024,
				calibration: 1,
				signal: AbortSignal.abort(),
				regenerateOnce: false,
			}),
		).rejects.toMatchObject({ code: "context_management.operation_aborted" });
		expect(faux.state.callCount).toBe(0);
	});

	it("fails closed when the framed checkpoint is not smaller than the shadowed span", async () => {
		const { pi, context } = createGeneratorHost();
		await expect(
			generateCheckpoint({
				context,
				pi,
				messages: [userMessage("tiny")],
				shadowedTokenCount: 1,
				maxTokens: 1_024,
				calibration: 1,
				regenerateOnce: false,
			}),
		).rejects.toBeInstanceOf(ContextManagementError);
	});
});

function createGeneratorHost(): {
	readonly pi: ExtensionAPI;
	readonly context: ExtensionContext;
	readonly faux: ReturnType<typeof fauxProvider>;
} {
	const faux = fauxProvider({
		models: [{ id: "faux-1", name: "Faux", contextWindow: 128_000, maxTokens: 16_384 }],
	});
	const model = faux.getModel();
	faux.setResponses([fauxAssistantMessage("## Next Step\n- continue")]);
	const pi = {
		getActiveTools: () => ["bash"],
		getAllTools: () => [
			{
				name: "bash",
				description: "Run a command",
				parameters: { type: "object", properties: {} },
				sourceInfo: { path: "/bash", source: "pi", scope: "temporary", origin: "top-level" },
			},
		],
	} as unknown as ExtensionAPI;
	const context = {
		model,
		getSystemPrompt: () => "system prompt",
		sessionManager: { getSessionId: () => "session-1" },
		modelRegistry: {
			getProvider: (provider: string) => (provider === model.provider ? faux.provider : undefined),
			getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "test-key" }),
		},
	} as unknown as ExtensionContext;
	return { pi, context, faux };
}
