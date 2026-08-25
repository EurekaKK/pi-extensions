import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { TavilyClient } from "./client.js";
import { type FileMutationQueue, initializeTavilyConfig } from "./config.js";
import { API_KEY_ENV_VAR, API_KEYS_ENV_VAR, EXTENSION_ID } from "./constants.js";
import { registerTavilyTools } from "./tools.js";

export interface LoadTavilyDependencies {
	readonly agentDir: string;
	readonly withFileMutationQueue: FileMutationQueue;
	readonly fetch: typeof globalThis.fetch;
	readonly readApiKeys: () => readonly string[];
}

export function resolveApiKeys(keysEnv: string | undefined, keyEnv: string | undefined): readonly string[] {
	const pool = (keysEnv ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
	if (pool.length > 0) return pool;
	const single = keyEnv?.trim();
	return single === undefined || single.length === 0 ? [] : [single];
}

function notify(context: ExtensionContext, message: string): void {
	if (!context.hasUI) return;
	try {
		context.ui.notify(message, "error");
	} catch {
		// Advisory UI only.
	}
}

function registerDisabled(pi: ExtensionAPI, message: string): void {
	let shown = false;
	pi.on("session_start", (_event, context) => {
		if (shown || !context.hasUI) return;
		shown = true;
		notify(context, message);
	});
}

export async function loadTavilyWebSearch(pi: ExtensionAPI, dependencies: LoadTavilyDependencies): Promise<void> {
	try {
		const initialized = await initializeTavilyConfig({
			agentDir: dependencies.agentDir,
			withFileMutationQueue: dependencies.withFileMutationQueue,
		});
		const apiKeys = dependencies.readApiKeys();
		if (apiKeys.length === 0) {
			registerDisabled(
				pi,
				`${EXTENSION_ID} is disabled: ${API_KEYS_ENV_VAR} / ${API_KEY_ENV_VAR} is missing or empty.`,
			);
			return;
		}
		registerTavilyTools(pi, initialized.config, new TavilyClient({ apiKeys, fetch: dependencies.fetch }));
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		registerDisabled(pi, `${EXTENSION_ID} is disabled: ${detail}`);
	}
}

export default async function tavilyWebSearch(pi: ExtensionAPI): Promise<void> {
	await loadTavilyWebSearch(pi, {
		agentDir: getAgentDir(),
		withFileMutationQueue,
		fetch: globalThis.fetch,
		readApiKeys: () => resolveApiKeys(process.env[API_KEYS_ENV_VAR], process.env[API_KEY_ENV_VAR]),
	});
}

export type { TavilyConfigV1 } from "./config.js";
