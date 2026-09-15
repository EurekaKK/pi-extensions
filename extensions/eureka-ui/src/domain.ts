/**
 * Domain vocabulary for eureka-ui.
 *
 * The extension owns exactly two concepts: a per-tool display mode, and the
 * activity line that reports what the session is doing right now.
 */

/** Transcript policy for one built-in tool. */
export type DisplayMode = "hidden" | "line" | "native";

/** Built-in tools eureka-ui knows how to render. */
export type BuiltInToolName = "read" | "bash" | "powershell" | "edit" | "write" | "grep" | "find" | "ls";

export const BUILT_IN_TOOL_NAMES: readonly BuiltInToolName[] = Object.freeze([
	"read",
	"bash",
	"powershell",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
]);

export const DISPLAY_MODES: readonly DisplayMode[] = Object.freeze(["hidden", "line", "native"]);

export interface ToolDisplayConfig {
	readonly mode: DisplayMode;
}

export interface EurekaUiConfigV1 {
	readonly version: 1;
	readonly tools: Readonly<Record<BuiltInToolName, ToolDisplayConfig>>;
}

export function isBuiltInToolName(value: string): value is BuiltInToolName {
	return (BUILT_IN_TOOL_NAMES as readonly string[]).includes(value);
}

export function isDisplayMode(value: string): value is DisplayMode {
	return (DISPLAY_MODES as readonly string[]).includes(value);
}

/** Tools that get an override registration, in stable presentation order. */
export function managedToolNames(config: EurekaUiConfigV1): readonly BuiltInToolName[] {
	return BUILT_IN_TOOL_NAMES.filter((name) => config.tools[name].mode !== "native");
}
