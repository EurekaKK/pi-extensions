import {
	type Api,
	type AuthResult,
	InMemoryCredentialStore,
	InMemoryModelsStore,
	type Model,
	type Provider,
} from "@earendil-works/pi-ai";
import { type ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

export type GoalProviderRegistry = Pick<ModelRegistry, "getProvider" | "getProviderAuth" | "getApiKeyAndHeaders">;

export interface GoalProviderBridge {
	readonly modelRuntime: ModelRuntime;
	readonly provider: Provider;
}

export async function createGoalProviderBridge(
	registry: GoalProviderRegistry,
	model: Model<Api>,
): Promise<GoalProviderBridge> {
	const source = registry.getProvider(model.provider);
	if (source === undefined) {
		throw new Error(`The active provider ${JSON.stringify(model.provider)} is unavailable.`);
	}

	const provider: Provider = {
		id: source.id,
		name: source.name,
		...(source.baseUrl === undefined ? {} : { baseUrl: source.baseUrl }),
		...(source.headers === undefined ? {} : { headers: source.headers }),
		auth: {
			apiKey: {
				name: `${source.name} active session authentication`,
				resolve: async (): Promise<AuthResult | undefined> => {
					const providerAuth = await registry.getProviderAuth(source.id);
					const requestAuth = await registry.getApiKeyAndHeaders(model);
					if (!requestAuth.ok) throw new Error(requestAuth.error);
					const apiKey = requestAuth.apiKey ?? providerAuth?.auth.apiKey;
					const headers = { ...providerAuth?.auth.headers, ...requestAuth.headers };
					const env = { ...providerAuth?.env, ...requestAuth.env };
					const auth = {
						...(apiKey === undefined ? {} : { apiKey }),
						...(Object.keys(headers).length === 0 ? {} : { headers }),
						...(providerAuth?.auth.baseUrl === undefined ? {} : { baseUrl: providerAuth.auth.baseUrl }),
					};
					if (Object.keys(auth).length === 0 && Object.keys(env).length === 0) return undefined;
					return {
						auth,
						...(Object.keys(env).length === 0 ? {} : { env }),
						...(providerAuth?.source === undefined ? {} : { source: providerAuth.source }),
					};
				},
			},
		},
		getModels: () => [model],
		stream: (requestedModel, context, options) => source.stream(requestedModel, context, options),
		streamSimple: (requestedModel, context, options) => source.streamSimple(requestedModel, context, options),
	};

	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsStore: new InMemoryModelsStore(),
		modelsPath: null,
	});
	modelRuntime.registerNativeProvider(provider);

	return { modelRuntime, provider };
}
