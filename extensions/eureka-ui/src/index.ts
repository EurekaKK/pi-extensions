import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { ActivityTracker, activityLineText } from "./activity.js";
import { ActivityLineComponent } from "./components.js";
import { type FileMutationQueue, initializeEurekaUiConfig } from "./config.js";
import type { EurekaUiConfigV1 } from "./domain.js";
import { registerToolOverrides } from "./tools.js";

export const ACTIVITY_WIDGET_KEY = "eureka-ui:activity";
export const ACTIVITY_WIDGET_PLACEMENT = "aboveEditor" as const;

/** The slice of Pi's TUI handle the activity line needs to request a redraw. */
interface RenderTarget {
	requestRender(): void;
}

interface ActivityWidget {
	readonly component: ActivityLineComponent;
	readonly tui: RenderTarget;
}

function supportsWidget(context: ExtensionContext): boolean {
	return context.hasUI && (context.mode === "tui" || context.mode === "rpc");
}

function publishRpcWidget(context: ExtensionContext, tracker: ActivityTracker): void {
	const text = activityLineText(tracker.snapshot());
	context.ui.setWidget(ACTIVITY_WIDGET_KEY, text === undefined ? [] : [text], {
		placement: ACTIVITY_WIDGET_PLACEMENT,
	});
}

/**
 * Wires the display modes, the activity line, and its lifecycle.
 *
 * The widget key is registered once per session and never re-set while the
 * session runs: `setWidget` re-inserts a key at the end of the above-editor
 * map, and keeping ours first is what holds it above the progress widget.
 */
export function registerEurekaUi(pi: ExtensionAPI, config: EurekaUiConfigV1): void {
	registerToolOverrides(pi, config);
	const tracker = new ActivityTracker();
	let widget: ActivityWidget | undefined;

	const render = (context: ExtensionContext): void => {
		if (!supportsWidget(context)) return;
		if (widget !== undefined) {
			widget.component.setState(tracker.snapshot());
			widget.tui.requestRender();
			return;
		}
		if (context.mode === "rpc") publishRpcWidget(context, tracker);
	};

	pi.on("session_start", (_event, context) => {
		tracker.reset();
		widget = undefined;
		if (!supportsWidget(context)) return;
		if (context.mode === "rpc") {
			publishRpcWidget(context, tracker);
			return;
		}
		context.ui.setWidget(
			ACTIVITY_WIDGET_KEY,
			(tui, theme) => {
				const component = new ActivityLineComponent(theme);
				component.setState(tracker.snapshot());
				widget = { component, tui };
				return component;
			},
			{ placement: ACTIVITY_WIDGET_PLACEMENT },
		);
	});

	pi.on("tool_execution_start", (event, context) => {
		tracker.start(event.toolCallId, event.toolName, event.args, Date.now());
		render(context);
	});

	pi.on("tool_execution_end", (event, context) => {
		tracker.end(event.toolCallId, event.isError, event.result, Date.now());
		render(context);
	});

	pi.on("agent_settled", (_event, context) => {
		tracker.settle();
		render(context);
	});

	pi.on("message_start", (event, context) => {
		if (event.message.role !== "user") return;
		tracker.clear();
		render(context);
	});

	pi.on("session_shutdown", (_event, context) => {
		widget = undefined;
		if (!supportsWidget(context)) return;
		context.ui.setWidget(ACTIVITY_WIDGET_KEY, undefined, { placement: ACTIVITY_WIDGET_PLACEMENT });
	});
}

function registerDisabledEurekaUi(pi: ExtensionAPI, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	let notified = false;
	pi.on("session_start", (_event, context) => {
		if (notified || !context.hasUI) return;
		notified = true;
		context.ui.notify(`eureka-ui is disabled: ${message}`, "warning");
	});
}

export interface LoadEurekaUiDependencies {
	readonly agentDir: string;
	readonly withFileMutationQueue: FileMutationQueue;
}

export async function loadEurekaUi(pi: ExtensionAPI, dependencies: LoadEurekaUiDependencies): Promise<void> {
	try {
		const initialized = await initializeEurekaUiConfig(dependencies);
		registerEurekaUi(pi, initialized.config);
	} catch (error) {
		registerDisabledEurekaUi(pi, error);
	}
}

export default async function eurekaUi(pi: ExtensionAPI): Promise<void> {
	await loadEurekaUi(pi, {
		agentDir: getAgentDir(),
		withFileMutationQueue,
	});
}
