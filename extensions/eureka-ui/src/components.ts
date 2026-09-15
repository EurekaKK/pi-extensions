import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { type ActivityState, activityLineText } from "./activity.js";

/** A component that renders nothing; used to empty a render slot. */
export const EMPTY_COMPONENT: Component = Object.freeze({
	render: () => [],
	invalidate: () => {},
});

/** Content padding, matching Pi's transcript text padding. */
export const CONTENT_PADDING_X = 1;

/** A single content line that truncates instead of wrapping. */
export class OneLineComponent implements Component {
	#line = "";
	readonly #paddingX: number;

	constructor(paddingX: number = CONTENT_PADDING_X) {
		this.#paddingX = paddingX;
	}

	setLine(line: string): void {
		this.#line = line;
	}

	render(width: number): string[] {
		if (this.#line.length === 0) return [];
		return [truncateToWidth(`${" ".repeat(this.#paddingX)}${this.#line}`, width, "…")];
	}

	invalidate(): void {}
}

/**
 * The pinned activity line. It reads as one line of ordinary output followed by
 * a blank separator, so it stays visually detached from the progress widget
 * below it. Idle state renders no lines at all.
 */
export class ActivityLineComponent implements Component {
	#state: ActivityState = { kind: "idle" };
	readonly #theme: Theme;
	readonly #paddingX: number;

	constructor(theme: Theme, paddingX: number = CONTENT_PADDING_X) {
		this.#theme = theme;
		this.#paddingX = paddingX;
	}

	setState(state: ActivityState): void {
		this.#state = state;
	}

	render(width: number): string[] {
		const text = activityLineText(this.#state);
		if (text === undefined) return [];
		const color = this.#state.kind === "failed" ? "error" : this.#state.kind === "ran" ? "muted" : "text";
		const line = truncateToWidth(`${" ".repeat(this.#paddingX)}${this.#theme.fg(color, text)}`, width, "…");
		return [line, ""];
	}

	invalidate(): void {}
}
