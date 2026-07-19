import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import {
	type ExtensionAPI,
	getAgentDir,
	isToolCallEventType,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { type FileMutationQueue, initializePolicy, type PolicySnapshot } from "./config.js";
import { decideCommand, formatRedReason, formatYellowReason, YellowReviewState } from "./policy.js";

const STATUS_KEY = "bash-permissions";
const DEFAULTS_DIRECTORY = fileURLToPath(new URL("../defaults/", import.meta.url));

export interface BashPermissionsDependencies {
	readonly getAgentDir: () => string;
	readonly getHomeDir: () => string;
	readonly defaultsDir: string;
	readonly withFileMutationQueue: FileMutationQueue;
}

interface EnabledSessionState {
	readonly status: "enabled";
	readonly snapshot: PolicySnapshot;
	readonly reviews: YellowReviewState;
}

interface DisabledSessionState {
	readonly status: "disabled";
}

type SessionState = EnabledSessionState | DisabledSessionState;

const DEFAULT_DEPENDENCIES: BashPermissionsDependencies = Object.freeze({
	getAgentDir,
	getHomeDir: homedir,
	defaultsDir: DEFAULTS_DIRECTORY,
	withFileMutationQueue,
});

export function registerBashPermissions(
	pi: ExtensionAPI,
	dependencies: BashPermissionsDependencies = DEFAULT_DEPENDENCIES,
): void {
	let lifecycleGeneration = 0;
	let sessionState: SessionState = Object.freeze({ status: "disabled" });

	pi.on("session_start", async (_event, ctx) => {
		const generation = lifecycleGeneration + 1;
		lifecycleGeneration = generation;
		sessionState = Object.freeze({ status: "disabled" });

		try {
			const result = await initializePolicy({
				agentDir: dependencies.getAgentDir(),
				defaultsDir: dependencies.defaultsDir,
				cwd: ctx.cwd,
				home: dependencies.getHomeDir(),
				withFileMutationQueue: dependencies.withFileMutationQueue,
			});
			if (generation !== lifecycleGeneration) {
				return;
			}

			sessionState = Object.freeze({
				status: "enabled",
				snapshot: result.snapshot,
				reviews: new YellowReviewState(),
			});

			if (result.createdFiles.length > 0 && ctx.hasUI) {
				ctx.ui.notify(`bash-permissions 已创建用户配置：\n${result.createdFiles.join("\n")}`, "info");
			}
		} catch (error) {
			if (generation !== lifecycleGeneration) {
				return;
			}
			sessionState = Object.freeze({ status: "disabled" });
			const detail = error instanceof Error ? error.message : String(error);
			const message = `bash-permissions 初始化失败：${detail}\nextension 没有正常运行，当前 session 的 bash 调用不受其保护。`;
			ctx.ui.setStatus(STATUS_KEY, "bash-permissions: disabled");
			if (ctx.hasUI) {
				ctx.ui.notify(message, "error");
			}
			throw new Error(message);
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		lifecycleGeneration += 1;
		if (sessionState.status === "enabled") {
			sessionState.reviews.reset();
		}
		sessionState = Object.freeze({ status: "disabled" });
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});

	pi.on("input", () => {
		if (sessionState.status === "enabled") {
			sessionState.reviews.reset();
		}
	});

	pi.on("message_start", (event) => {
		if (sessionState.status === "enabled" && event.message.role === "user") {
			sessionState.reviews.reset();
		}
	});

	pi.on("session_tree", () => {
		if (sessionState.status === "enabled") {
			sessionState.reviews.reset();
		}
	});

	pi.on("turn_start", () => {
		if (sessionState.status === "enabled") {
			sessionState.reviews.startResponse();
		}
	});

	pi.on("turn_end", () => {
		if (sessionState.status === "enabled") {
			sessionState.reviews.endResponse();
		}
	});

	pi.on("tool_call", (event) => {
		if (sessionState.status !== "enabled" || !isToolCallEventType("bash", event)) {
			return;
		}

		const command = event.input.command;
		if (typeof command !== "string") {
			return;
		}

		const decision = decideCommand(command, sessionState.snapshot, sessionState.reviews);
		if (decision.color === "green" || (decision.color === "yellow" && decision.allowedByReview)) {
			return;
		}
		if (decision.color === "red") {
			return { block: true, reason: formatRedReason(decision.matches) };
		}
		return { block: true, reason: formatYellowReason(decision.matches) };
	});
}

export default function bashPermissions(pi: ExtensionAPI): void {
	registerBashPermissions(pi);
}
