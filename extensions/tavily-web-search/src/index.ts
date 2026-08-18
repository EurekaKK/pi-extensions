import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { TavilyClient } from "./client.js";
import { type FileMutationQueue, initializeTavilyConfig, TavilyConfigurationError } from "./config.js";
import { EXTENSION_ID } from "./constants.js";
import { registerTavilyTools } from "./tools.js";

export interface LoadTavilyDependencies {
	readonly agentDir: string;
	readonly withFileMutationQueue: FileMutationQueue;
	readonly fetch: typeof globalThis.fetch;
	readonly readApiKey: () => string | undefined;
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
		const apiKey = dependencies.readApiKey()?.trim();
		if (apiKey === undefined || apiKey.length === 0) {
			registerDisabled(pi, `${EXTENSION_ID} is disabled: TAVILY_API_KEY is missing or empty.`);
			return;
		}
		registerTavilyTools(pi, initialized.config, new TavilyClient({ apiKey, fetch: dependencies.fetch }));
	} catch (error) {
		const detail =
			error instanceof TavilyConfigurationError
				? error.message
				: error instanceof Error
					? error.message
					: String(error);
		registerDisabled(pi, `${EXTENSION_ID} is disabled: ${detail}`);
	}
}

export default async function tavilyWebSearch(pi: ExtensionAPI): Promise<void> {
	await loadTavilyWebSearch(pi, {
		agentDir: getAgentDir(),
		withFileMutationQueue,
		fetch: globalThis.fetch,
		readApiKey: () => process.env.TAVILY_API_KEY,
	});
}

export type { TavilyConfigV1 } from "./config.js";
export { TavilyConfigurationError };
