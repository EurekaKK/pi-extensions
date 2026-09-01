import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	PROGRESS_WIDGET_ATTACH_EVENT,
	PROGRESS_WIDGET_KEY,
	PROGRESS_WIDGET_RELEASE_EVENT,
	PROGRESS_WIDGET_SHORTCUT,
	PROGRESS_WIDGET_STATE_EVENT,
	type ProgressWidgetView,
	parseProgressWidgetSnapshot,
} from "progress-widget-protocol";
import {
	applySnapshot,
	buildProgressWidgetLines,
	ProgressWidgetComponent,
	type ProgressWidgetState,
} from "./widget.js";

const EMPTY_STATE: ProgressWidgetState = Object.freeze({
	agents: Object.freeze([]),
	plan: null,
	todos: Object.freeze([]),
	goal: null,
});
const USAGE = "Usage: /progress-widget [compact|full|switch]";

function supportsWidget(context: ExtensionContext): boolean {
	return context.hasUI && (context.mode === "tui" || context.mode === "rpc");
}

function notify(context: ExtensionContext, message: string, level: "info" | "warning" = "info"): void {
	if (!context.hasUI) return;
	try {
		context.ui.notify(message, level);
	} catch {
		// Advisory UI only.
	}
}

export default function progressWidget(pi: ExtensionAPI): void {
	let context: ExtensionContext | undefined;
	let sessionId: string | undefined;
	let view: ProgressWidgetView = "compact";
	let state: ProgressWidgetState = EMPTY_STATE;
	let ownsProjection = false;

	function releaseProjection(): void {
		const currentSessionId = sessionId;
		ownsProjection = false;
		if (context !== undefined && supportsWidget(context)) {
			try {
				context.ui.setWidget(PROGRESS_WIDGET_KEY, undefined, { placement: "aboveEditor" });
			} catch {
				// The release event still lets producers restore their fallbacks.
			}
		}
		if (currentSessionId !== undefined) {
			pi.events.emit(PROGRESS_WIDGET_RELEASE_EVENT, { version: 1, sessionId: currentSessionId });
		}
	}

	function project(): boolean {
		if (context === undefined || sessionId === undefined || !ownsProjection || !supportsWidget(context)) return false;
		const lines = buildProgressWidgetLines(state, view);
		try {
			if (lines.length === 0) {
				context.ui.setWidget(PROGRESS_WIDGET_KEY, undefined, { placement: "aboveEditor" });
			} else if (context.mode === "tui") {
				const snapshot = state;
				const density = view;
				context.ui.setWidget(
					PROGRESS_WIDGET_KEY,
					(_tui, theme) => new ProgressWidgetComponent(snapshot, density, theme),
					{ placement: "aboveEditor" },
				);
			} else {
				context.ui.setWidget(PROGRESS_WIDGET_KEY, lines, { placement: "aboveEditor" });
			}
			return true;
		} catch {
			releaseProjection();
			return false;
		}
	}

	function claimProjection(nextContext: ExtensionContext): boolean {
		context = nextContext;
		sessionId = nextContext.sessionManager.getSessionId();
		if (!supportsWidget(nextContext)) return false;
		try {
			nextContext.ui.setWidget(PROGRESS_WIDGET_KEY, undefined, { placement: "aboveEditor" });
		} catch {
			return false;
		}
		ownsProjection = true;
		pi.events.emit(PROGRESS_WIDGET_ATTACH_EVENT, { version: 1, sessionId });
		return project();
	}

	function setView(next: ProgressWidgetView, commandContext: ExtensionContext): void {
		view = next;
		if (!ownsProjection) {
			claimProjection(commandContext);
			return;
		}
		context = commandContext;
		sessionId = commandContext.sessionManager.getSessionId();
		project();
	}

	function switchView(commandContext: ExtensionContext): void {
		setView(view === "compact" ? "full" : "compact", commandContext);
	}

	pi.events.on(PROGRESS_WIDGET_STATE_EVENT, (value) => {
		const snapshot = parseProgressWidgetSnapshot(value);
		if (snapshot === null || snapshot.sessionId !== sessionId || !ownsProjection) return;
		state = applySnapshot(state, snapshot);
		project();
	});

	pi.registerCommand("progress-widget", {
		description: "Show or switch the progress widget view",
		async handler(argumentsText, commandContext) {
			const action = argumentsText.trim().toLowerCase();
			if (action.length === 0) {
				notify(commandContext, `Progress widget view: ${view}. ${USAGE}`);
				return;
			}
			if (action === "compact" || action === "full") {
				setView(action, commandContext);
				return;
			}
			if (action === "switch") {
				switchView(commandContext);
				return;
			}
			notify(commandContext, USAGE, "warning");
		},
	});

	pi.registerShortcut(PROGRESS_WIDGET_SHORTCUT, {
		description: "Switch progress widget view",
		handler(shortcutContext) {
			switchView(shortcutContext);
		},
	});

	pi.on("session_start", (_event, nextContext) => {
		context = nextContext;
		sessionId = nextContext.sessionManager.getSessionId();
		view = "compact";
		state = EMPTY_STATE;
		ownsProjection = false;
		claimProjection(nextContext);
	});

	pi.on("session_shutdown", (_event, shutdownContext) => {
		if (supportsWidget(shutdownContext)) {
			try {
				shutdownContext.ui.setWidget(PROGRESS_WIDGET_KEY, undefined, { placement: "aboveEditor" });
			} catch {
				// Advisory UI only.
			}
		}
		context = undefined;
		sessionId = undefined;
		state = EMPTY_STATE;
		view = "compact";
		ownsProjection = false;
	});
}

export { applySnapshot, buildProgressWidgetLines, ProgressWidgetComponent } from "./widget.js";
