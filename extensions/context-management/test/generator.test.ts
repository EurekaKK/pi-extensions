import {
	type Api,
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type Model,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { generateCheckpoint } from "../src/compaction/generator.js";
import type { NormalizedCompactorSource } from "../src/compaction/source.js";

function fixture() {
	const faux = createFauxCore({
		api: "context-management-generator-faux-api",
		provider: "context-management-generator-faux",
		models: [{ id: "fixture", contextWindow: 200_000, maxTokens: 32_000 }],
		tokensPerSecond: 0,
	});
	const context = {
		model: faux.getModel() as Model<Api>,
		thinkingLevel: "high",
		modelRegistry: {
			getProvider: () => faux,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "fixture-key" }),
		},
	} as unknown as ExtensionContext;
	const source: NormalizedCompactorSource = {
		content: [{ type: "text", text: '<context-management-data role="user">state</context-management-data>' }],
		allowedEvidenceReferences: new Set(),
		estimatedTokens: 20,
		fingerprintInput: "state",
	};
	return { context, faux, source };
}

describe("checkpoint generator", () => {
	it("does not send or regenerate when the operation is already aborted", async () => {
		const test = fixture();
		const controller = new AbortController();
		controller.abort();
		await expect(
			generateCheckpoint({
				context: test.context,
				source: test.source,
				hardLimit: 20_000,
				signal: controller.signal,
				regenerateOnce: true,
			}),
		).rejects.toMatchObject({ code: "context_management.operation_aborted" });
		expect(test.faux.state.callCount).toBe(0);
	});

	it("regenerates exactly once for a mechanically invalid blocking candidate", async () => {
		const test = fixture();
		test.faux.setResponses([fauxAssistantMessage(""), fauxAssistantMessage("# Checkpoint\n\nValid.")]);
		const checkpoint = await generateCheckpoint({
			context: test.context,
			source: test.source,
			hardLimit: 20_000,
			regenerateOnce: true,
		});
		expect(checkpoint.summary).toBe("# Checkpoint\n\nValid.");
		expect(test.faux.state.callCount).toBe(2);
	});

	it("does not immediately regenerate an invalid background candidate", async () => {
		const test = fixture();
		test.faux.setResponses([fauxAssistantMessage(""), fauxAssistantMessage("unused")]);
		await expect(
			generateCheckpoint({
				context: test.context,
				source: test.source,
				hardLimit: 20_000,
				regenerateOnce: false,
			}),
		).rejects.toMatchObject({ code: "context_management.checkpoint_validation_failure" });
		expect(test.faux.state.callCount).toBe(1);
	});

	it("retries transient transport failures without consuming mechanical regeneration", async () => {
		vi.useFakeTimers();
		try {
			const test = fixture();
			test.faux.setResponses([
				(_context, options) => {
					expect(options?.timeoutMs).toBe(300_000);
					expect(options?.maxRetries).toBe(0);
					return fauxAssistantMessage("", { stopReason: "error", errorMessage: "stream terminated" });
				},
				fauxAssistantMessage("# Checkpoint\n\nRecovered."),
			]);
			const pending = generateCheckpoint({
				context: test.context,
				source: test.source,
				hardLimit: 20_000,
				regenerateOnce: false,
			});
			await vi.advanceTimersByTimeAsync(2_000);
			expect((await pending).summary).toBe("# Checkpoint\n\nRecovered.");
			expect(test.faux.state.callCount).toBe(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not spend mechanical regeneration after transport retries are exhausted", async () => {
		vi.useFakeTimers();
		try {
			const test = fixture();
			test.faux.setResponses(
				Array.from({ length: 4 }, () =>
					fauxAssistantMessage("", { stopReason: "error", errorMessage: "stream terminated" }),
				),
			);
			const pending = generateCheckpoint({
				context: test.context,
				source: test.source,
				hardLimit: 20_000,
				regenerateOnce: true,
			});
			const rejected = expect(pending).rejects.toMatchObject({
				code: "context_management.compactor_transport_failure",
			});
			await vi.advanceTimersByTimeAsync(14_000);
			await rejected;
			expect(test.faux.state.callCount).toBe(4);
		} finally {
			vi.useRealTimers();
		}
	});

	it("rejects an infeasible compactor request before sending it", async () => {
		const test = fixture();
		await expect(
			generateCheckpoint({
				context: test.context,
				source: { ...test.source, estimatedTokens: 190_000 },
				hardLimit: 20_000,
				regenerateOnce: true,
			}),
		).rejects.toMatchObject({ code: "context_management.compaction_infeasible" });
		expect(test.faux.state.callCount).toBe(0);
	});

	it("rejects a text-bearing tool-use response instead of treating it as a finished checkpoint", async () => {
		const test = fixture();
		test.faux.setResponses([
			fauxAssistantMessage([fauxText("partial"), fauxToolCall("unexpected", {})], { stopReason: "toolUse" }),
		]);
		await expect(
			generateCheckpoint({
				context: test.context,
				source: test.source,
				hardLimit: 20_000,
				regenerateOnce: false,
			}),
		).rejects.toMatchObject({ code: "context_management.checkpoint_validation_failure" });
		expect(test.faux.state.callCount).toBe(1);
	});
});
