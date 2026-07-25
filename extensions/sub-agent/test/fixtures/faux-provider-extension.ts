import { type Api, createFauxCore, fauxAssistantMessage, type Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const FAUX_PROVIDER_ID = "sub-agent-faux";
export const FAUX_MODEL_ID = "fixture-model";

export default function fauxProviderExtension(pi: ExtensionAPI): void {
	const faux = createFauxCore({
		api: "sub-agent-faux-api",
		provider: FAUX_PROVIDER_ID,
		models: [
			{
				id: FAUX_MODEL_ID,
				name: "Sub-agent fixture model",
				reasoning: true,
				input: ["text"],
				contextWindow: 32_000,
				maxTokens: 4_096,
			},
		],
		tokensPerSecond: 0,
	});
	faux.setResponses(
		Array.from({ length: 16 }, () =>
			fauxAssistantMessage("fixture child report", {
				stopReason: "stop",
			}),
		),
	);
	pi.registerProvider(FAUX_PROVIDER_ID, {
		name: "Sub-agent faux provider",
		api: faux.api,
		baseUrl: "https://fixture.invalid",
		apiKey: "fixture-api-key",
		streamSimple: (model, context, options) => faux.streamSimple(model as Model<Api>, context, options),
		models: [
			{
				id: FAUX_MODEL_ID,
				name: "Sub-agent fixture model",
				api: faux.api,
				reasoning: true,
				thinkingLevelMap: { xhigh: "xhigh", max: "max" },
				input: ["text"],
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
				},
				contextWindow: 32_000,
				maxTokens: 4_096,
			},
		],
	});
}
