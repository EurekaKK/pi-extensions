import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Context, Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPiChildSessionFactory } from "../src/child-session.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import type { ChildSessionRequest } from "../src/domain.js";
import { SubagentManager } from "../src/runtime.js";

describe("Pi child session factory", () => {
	let agentDir: string;
	let cwd: string;
	let model: Model<string>;
	let parentContext: ExtensionContext;
	let modelInputs: string[];

	beforeEach(async () => {
		agentDir = await mkdtemp(join(tmpdir(), "sub-agent-child-agent-"));
		cwd = await mkdtemp(join(tmpdir(), "sub-agent-child-cwd-"));
		const faux = fauxProvider({ provider: "faux", api: "openai-completions" });
		modelInputs = [];
		const respond = (context: Context) => {
			modelInputs.push(JSON.stringify(context.messages));
			return fauxAssistantMessage("child-answer");
		};
		faux.setResponses([respond, respond]);
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

	it.each(["spawn", "fork"] as const)(
		"restores settled %s history when send_message creates a fresh instance",
		async (provider) => {
			const factory = createPiChildSessionFactory(parentContext, agentDir);
			const parent = SessionManager.create(cwd, join(agentDir, "parent-sessions"), { id: "cold-restore-parent" });
			parent.appendMessage({ role: "user", content: "completed parent turn", timestamp: Date.now() });
			const boundary = parent.appendMessage(fauxAssistantMessage("parent-answer"));
			parent.appendMessage({
				role: "user",
				content: "in-flight parent turn must not be copied",
				timestamp: Date.now(),
			});
			const histories: string[][] = [];
			const files: Array<string | undefined> = [];
			const pi = { sendMessage: vi.fn() };
			const manager = new SubagentManager({
				config: DEFAULT_CONFIG,
				pi,
				childFactory: {
					async create(request) {
						const handle = await factory.create(request);
						histories.push(handle.messages().map((message) => message.text));
						files.push(handle.sessionFile);
						return handle;
					},
				},
				ownerSessionId: "cold-restore-parent",
				parentSessionFile: parent.getSessionFile(),
				getForkBoundary: () => boundary,
				cwd,
				depth: 0,
				parentModel: { provider: model.provider, id: model.id },
				parentThinkingLevel: "minimal",
				parentToolNames: [],
				childSessionDir: join(agentDir, "sub-agent", "sessions", "cold-restore-parent"),
			});
			try {
				const policy = DEFAULT_CONFIG.delegationTools[0];
				if (policy === undefined) throw new Error("missing spawn policy");
				const child = await manager.start(
					{ ...policy, provider },
					"remember",
					"remember the unique first-turn fact",
					true,
				);
				await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(1));
				await manager.sendMessage(child.childId, "continue with that fact");
				await vi.waitFor(() => expect(pi.sendMessage).toHaveBeenCalledTimes(2));
				expect(histories[1]).toContain("remember the unique first-turn fact");
				expect(histories[1]).toContain("child-answer");
				expect(files[1]).toBe(files[0]);
				expect(dirname(files[0] ?? "")).toBe(join(agentDir, "sub-agent", "sessions", "cold-restore-parent"));
				expect(await readdir(join(agentDir, "sub-agent", "sessions", "cold-restore-parent"))).toHaveLength(1);
				expect(await readdir(join(agentDir, "parent-sessions"))).toHaveLength(1);
				expect(modelInputs).toHaveLength(2);
				expect(modelInputs[1]).toContain("remember the unique first-turn fact");
				expect(modelInputs[1]).toContain("child-answer");
				expect(modelInputs[1]).not.toContain("in-flight parent turn must not be copied");
				if (provider === "fork") expect(modelInputs[1]).toContain("completed parent turn");
			} finally {
				await manager.shutdown();
			}
		},
	);

	it.each(["missing", "empty", "corrupt", "wrong-child"])("fails closed on a %s continuation file", async (failure) => {
		const factory = createPiChildSessionFactory(parentContext, agentDir);
		const request: ChildSessionRequest = {
			childId: "restore-child",
			provider: "spawn",
			mode: "continuable",
			parentSessionId: "restore-parent",
			cwd,
			sessionDir: join(agentDir, "sub-agent", "sessions", "restore-parent"),
			depth: 1,
			model: { provider: model.provider, id: model.id },
			thinkingLevel: "minimal",
			toolNames: [],
			prompt: "first",
			onReport: async () => "msg",
		};
		const handle = await factory.create(request);
		try {
			await handle.prompt("first");
		} finally {
			await handle.dispose();
		}
		const path = handle.sessionFile;
		if (path === undefined) throw new Error("missing persisted session path");
		if (failure === "missing") await rm(path);
		if (failure === "empty") await writeFile(path, "");
		if (failure === "corrupt") await writeFile(path, "not a session\n");
		const before = failure === "missing" ? undefined : await readFile(path, "utf8");
		await expect(
			factory.create({
				...request,
				childId: failure === "wrong-child" ? "another-child" : request.childId,
				resumeSessionFile: path,
			}),
		).rejects.toThrow();
		expect(await readdir(dirname(path))).toHaveLength(failure === "missing" ? 0 : 1);
		if (before !== undefined) expect(await readFile(path, "utf8")).toBe(before);
		expect(modelInputs).toHaveLength(1);
	});
});
