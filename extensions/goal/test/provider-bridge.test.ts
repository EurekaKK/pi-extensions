import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { createGoalProviderBridge } from "../src/provider-bridge.js";

describe("createGoalProviderBridge", () => {
	it("exposes only the active model and resolves authentication through the active registry", async () => {
		const faux = fauxProvider({ provider: "goal-faux", models: [{ id: "active" }, { id: "other" }] });
		const model = faux.getModel("active");
		if (model === undefined) throw new Error("Missing faux model.");
		const getProviderAuth = vi.fn(async () => ({ auth: { apiKey: "secret" }, source: "test" }));

		const bridge = await createGoalProviderBridge(
			{
				getProvider: () => faux.provider,
				getProviderAuth,
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "secret", headers: { "x-model": "yes" } }),
			},
			model,
		);

		expect(bridge.provider.getModels()).toEqual([model]);
		expect(await bridge.modelRuntime.getAuth(model)).toMatchObject({ auth: { apiKey: "secret" } });
		expect(getProviderAuth).toHaveBeenCalledWith("goal-faux");
	});

	it("delegates streaming to the effective provider", async () => {
		const faux = fauxProvider({ provider: "goal-faux", models: [{ id: "active" }] });
		const model = faux.getModel();
		faux.setResponses([fauxAssistantMessage("evaluated")]);
		const bridge = await createGoalProviderBridge(
			{
				getProvider: () => faux.provider,
				getProviderAuth: async () => ({ auth: { apiKey: "secret" } }),
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "secret" }),
			},
			model,
		);

		const message = await bridge.modelRuntime.completeSimple(model, { systemPrompt: "judge", messages: [] });
		expect(message.content).toEqual([{ type: "text", text: "evaluated" }]);
		expect(faux.state.callCount).toBe(1);
	});

	it("rejects an unavailable active provider", async () => {
		const faux = fauxProvider({ provider: "goal-faux", models: [{ id: "active" }] });
		await expect(
			createGoalProviderBridge(
				{
					getProvider: () => undefined,
					getProviderAuth: async () => undefined,
					getApiKeyAndHeaders: async () => ({ ok: false, error: "missing" }),
				},
				faux.getModel(),
			),
		).rejects.toThrow("active provider");
	});
});
