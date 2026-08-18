import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
	type Api,
	type AuthResult,
	InMemoryCredentialStore,
	InMemoryModelsStore,
	type Model,
	type Provider,
} from "@earendil-works/pi-ai";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	type ExtensionContext,
	getAgentDir,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { DESCRIPTOR_ENTRY_TYPE, DESCRIPTOR_VERSION } from "./constants.js";
import type {
	ChildMessage,
	ChildSessionFactory,
	ChildSessionHandle,
	ChildSessionRequest,
	SubAgentDescriptorV1,
} from "./domain.js";
import { SubagentError } from "./domain.js";
import { CHILD_SYSTEM_PROMPT, CONTINUABLE_CHILD_REPORT_INSTRUCTION } from "./prompts.js";
import { createReportToolDefinition } from "./tools/report.js";

function textContent(message: { content: unknown }): string {
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((block): block is { type: "text"; text: string } => {
			if (typeof block !== "object" || block === null) return false;
			const record = block as Record<string, unknown>;
			return record.type === "text" && typeof record.text === "string";
		})
		.map((block) => (block as { text: string }).text)
		.join("");
}

function childMessages(session: {
	messages: Array<{ role: string; content: unknown; toolName?: string; isError?: boolean }>;
}): readonly ChildMessage[] {
	return session.messages.map((message) => ({
		role: message.role === "user" || message.role === "toolResult" ? message.role : "assistant",
		text: textContent(message as { content: unknown }),
		...(message.role === "toolResult" && typeof message.toolName === "string" ? { toolName: message.toolName } : {}),
		...(message.role === "toolResult" && typeof message.isError === "boolean" ? { isError: message.isError } : {}),
	}));
}

async function createChildModelRuntime(parentContext: ExtensionContext, model: Model<Api>): Promise<ModelRuntime> {
	const source = parentContext.modelRegistry.getProvider(model.provider);
	if (source === undefined) {
		throw new SubagentError(`The active provider ${JSON.stringify(model.provider)} is unavailable.`);
	}
	const provider: Provider = {
		id: source.id,
		name: source.name,
		...(source.baseUrl === undefined ? {} : { baseUrl: source.baseUrl }),
		...(source.headers === undefined ? {} : { headers: source.headers }),
		auth: {
			apiKey: {
				name: `${source.name} child session authentication`,
				resolve: async (): Promise<AuthResult | undefined> => {
					const providerAuth = await parentContext.modelRegistry.getProviderAuth(source.id);
					const requestAuth = await parentContext.modelRegistry.getApiKeyAndHeaders(model);
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
	return modelRuntime;
}

function descriptorFor(request: ChildSessionRequest): SubAgentDescriptorV1 {
	return {
		version: DESCRIPTOR_VERSION,
		childId: request.childId,
		parentSessionId: request.parentSessionId,
		provider: request.provider,
		mode: request.mode,
		depth: request.depth,
		model: request.model,
		thinkingLevel: request.thinkingLevel,
		...(request.toolFilter === undefined ? {} : { toolFilter: request.toolFilter }),
		...(request.persona === undefined ? {} : { persona: request.persona }),
		createdAt: Date.now(),
	};
}

function createSessionManager(request: ChildSessionRequest): SessionManager {
	if (request.mode === "continuable" && request.sessionDir !== undefined) {
		mkdirSync(request.sessionDir, { recursive: true, mode: 0o700 });
		const manager = SessionManager.create(request.cwd, request.sessionDir, {
			id: request.childId,
			...(request.parentSessionFile === undefined ? {} : { parentSession: request.parentSessionFile }),
		});
		manager.appendCustomEntry(DESCRIPTOR_ENTRY_TYPE, descriptorFor(request));
		return manager;
	}
	const manager = SessionManager.inMemory(request.cwd, { id: request.childId });
	manager.appendCustomEntry(DESCRIPTOR_ENTRY_TYPE, descriptorFor(request));
	return manager;
}

function createForkSessionManager(request: ChildSessionRequest): SessionManager {
	const parentFile = request.parentSessionFile;
	if (parentFile === undefined) throw new SubagentError("fork requires a persisted parent session file");
	const parentManager = SessionManager.open(parentFile, dirname(parentFile), request.cwd);
	let boundaryId = request.forkBeforeEntryId;
	if (boundaryId === undefined) {
		const branch = parentManager.getBranch();
		let lastUserIndex = -1;
		for (const [index, entry] of branch.entries()) {
			if (entry.type === "message" && entry.message.role === "user") lastUserIndex = index;
		}
		boundaryId = branch[lastUserIndex - 1]?.id;
		if (boundaryId === undefined) {
			const manager = SessionManager.create(request.cwd, request.sessionDir, { id: request.childId });
			manager.appendCustomEntry(DESCRIPTOR_ENTRY_TYPE, descriptorFor(request));
			return manager;
		}
	}
	const childFile = parentManager.createBranchedSession(boundaryId);
	if (childFile === undefined) throw new SubagentError("fork could not create a child session");
	const childManager = SessionManager.open(childFile, request.sessionDir ?? dirname(childFile), request.cwd);
	childManager.appendCustomEntry(DESCRIPTOR_ENTRY_TYPE, descriptorFor(request));
	return childManager;
}

export function createPiChildSessionFactory(
	parentContext: ExtensionContext,
	agentDirOverride?: string,
): ChildSessionFactory {
	return {
		async create(request): Promise<ChildSessionHandle> {
			request.signal?.throwIfAborted();
			const model = parentContext.modelRegistry.find(request.model.provider, request.model.id);
			if (model === undefined) {
				throw new SubagentError(`model ${request.model.provider}/${request.model.id} was not found`);
			}
			const modelRuntime = await createChildModelRuntime(parentContext, model);
			const agentDir = agentDirOverride ?? getAgentDir();
			const settingsManager = SettingsManager.create(request.cwd, agentDir, {
				projectTrusted: parentContext.isProjectTrusted(),
			});
			const sessionManager =
				request.provider === "fork" ? createForkSessionManager(request) : createSessionManager(request);

			const appendSystemPrompt = [
				CHILD_SYSTEM_PROMPT,
				...(request.persona === undefined ? [] : [request.persona]),
				...(request.mode === "continuable" ? [CONTINUABLE_CHILD_REPORT_INSTRUCTION] : []),
			];

			const services = await createAgentSessionServices({
				cwd: request.cwd,
				agentDir,
				settingsManager,
				modelRuntime,
				resourceLoaderOptions: {
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					systemPrompt: CHILD_SYSTEM_PROMPT,
					appendSystemPrompt,
				},
			});

			const customTools =
				request.mode === "continuable" ? [createReportToolDefinition((output) => request.onReport(output))] : [];

			const created = await createAgentSessionFromServices({
				services,
				sessionManager,
				model,
				thinkingLevel: request.thinkingLevel as "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
				tools: [...request.toolNames],
				customTools,
			});

			await created.session.bindExtensions({ mode: "print" });

			return {
				childId: request.childId,
				...(sessionManager.getSessionFile() === undefined ? {} : { sessionFile: sessionManager.getSessionFile() }),
				async prompt(text) {
					request.signal?.throwIfAborted();
					await created.session.prompt(text, { expandPromptTemplates: false, source: "extension" });
				},
				async abort() {
					await created.session.abort();
				},
				async dispose() {
					created.session.dispose();
				},
				messages() {
					return childMessages(
						created.session as unknown as {
							messages: Array<{ role: string; content: unknown; toolName?: string; isError?: boolean }>;
						},
					);
				},
			};
		},
	};
}
