import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPiChildSessionFactory } from "../src/child-session.js";
import type { ChildSessionRequest } from "../src/domain.js";

describe("Pi child session factory", () => {
	let agentDir: string;
	let cwd: string;
	let model: Model<string>;
	let parentContext: ExtensionContext;

	beforeEach(async () => {
		agentDir = await mkdtemp(join(tmpdir(), "sub-agent-child-agent-"));
		cwd = await mkdtemp(join(tmpdir(), "sub-agent-child-cwd-"));
		const faux = fauxProvider({ provider: "faux", api: "openai-completions" });
		faux.setResponses([fauxAssistantMessage("child-answer")]);
		model = faux.getModel();
		parentContext = {
			modelRegistry: {
				find: (provider: string, id: string) => (provider === "faux" && id === model.id ? model : undefined),
				getProvider: (provider: string) => (provider === "faux" ? faux.provider : undefined),
				getProviderAuth: async () => undefined,
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "spike-key" }),
			},
			isProjectTrusted: () => true,
		} as unknown as ExtensionContext;
	});

	afterEach(async () => {
		await rm(agentDir, { recursive: true, force: true });
		await rm(cwd, { recursive: true, force: true });
	});

	it("creates and runs a real one-shot child AgentSession in-process", async () => {
		const factory = createPiChildSessionFactory(parentContext, agentDir);
		const request: ChildSessionRequest = {
			childId: "child-1",
			provider: "spawn",
			mode: "one-shot",
			parentSessionId: "parent-1",
			cwd,
			depth: 1,
			model: { provider: model.provider, id: model.id },
			thinkingLevel: "minimal",
			toolNames: [],
			prompt: "hello",
			onReport: async () => "msg",
		};

		const handle = await factory.create(request);
		await handle.prompt("hello");
		const messages = handle.messages();
		await handle.dispose();

		expect(messages.some((message) => message.role === "assistant" && message.text === "child-answer")).toBe(true);
	});
});
