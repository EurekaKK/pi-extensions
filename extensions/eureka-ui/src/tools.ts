import type { ExtensionAPI, ExtensionContext, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import * as piTools from "@earendil-works/pi-coding-agent";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { EMPTY_COMPONENT, OneLineComponent } from "./components.js";
import { type BuiltInToolName, type DisplayMode, type EurekaUiConfigV1, managedToolNames } from "./domain.js";
import { formatCallLine, formatResultSummary, type ToolResultLike } from "./format.js";

/** Per-tool-row state shared between the call and result slots. */
export interface RowState {
	line?: OneLineComponent;
	startedAt?: number;
}

export interface RenderOptions {
	readonly expanded: boolean;
	readonly isPartial: boolean;
}

export interface RenderContext {
	readonly args: unknown;
	readonly cwd: string;
	readonly expanded: boolean;
	readonly isError: boolean;
	readonly executionStarted: boolean;
	readonly state: RowState;
}

type UpdateCallback = (update: ToolResultLike) => void;

/**
 * The subset of Pi's tool definition this extension reads directly.
 *
 * Pi's `ToolDefinition` is generic over the parameter schema, which the
 * built-ins instantiate with concrete TypeBox schemas, so the boundary narrows
 * once here instead of scattering casts. The override itself spreads the whole
 * built-in definition (see `createToolOverride`): Pi fields this module never
 * reads — `promptSnippet`, `prepareArguments`, `constrainedSampling`, and
 * anything Pi adds later — are inherited rather than copied field by field.
 */
export interface DelegatableTool {
	readonly name: string;
	readonly label: string;
	readonly description: string;
	readonly parameters: unknown;
	readonly promptSnippet?: string;
	readonly promptGuidelines?: readonly string[];
	readonly executionMode?: string;
	/** Argument shim Pi runs before schema validation (for example `edit`). */
	readonly prepareArguments?: (args: unknown) => unknown;
	readonly renderCall?: (args: unknown, theme: Theme, context: RenderContext) => Component;
	readonly renderResult?: (
		result: ToolResultLike,
		options: RenderOptions,
		theme: Theme,
		context: RenderContext,
	) => Component;
	readonly execute: (
		toolCallId: string,
		params: unknown,
		signal: AbortSignal | undefined,
		onUpdate: UpdateCallback | undefined,
		context: ExtensionContext,
	) => Promise<ToolResultLike>;
}

function asDelegatable(tool: unknown): DelegatableTool {
	return tool as DelegatableTool;
}

/**
 * Pi exports the PowerShell definition factory in newer copies of the package
 * only. Detect it at runtime so the extension still loads (and simply leaves
 * PowerShell native) against older type definitions.
 */
function powerShellDefinitionFactory(): ((cwd: string) => unknown) | undefined {
	const candidate = (piTools as unknown as Record<string, unknown>).createPowerShellToolDefinition;
	return typeof candidate === "function" ? (candidate as (cwd: string) => unknown) : undefined;
}

function createBase(name: BuiltInToolName, cwd: string): DelegatableTool | undefined {
	switch (name) {
		case "read":
			return asDelegatable(createReadToolDefinition(cwd));
		case "bash":
			return asDelegatable(createBashToolDefinition(cwd));
		case "powershell": {
			const factory = powerShellDefinitionFactory();
			return factory === undefined ? undefined : asDelegatable(factory(cwd));
		}
		case "edit":
			return asDelegatable(createEditToolDefinition(cwd));
		case "write":
			return asDelegatable(createWriteToolDefinition(cwd));
		case "grep":
			return asDelegatable(createGrepToolDefinition(cwd));
		case "find":
			return asDelegatable(createFindToolDefinition(cwd));
		case "ls":
			return asDelegatable(createLsToolDefinition(cwd));
	}
}

/** Lazily creates one built-in definition per (working directory, tool). */
export function createBaseLookup(): (name: BuiltInToolName, cwd: string) => DelegatableTool | undefined {
	const cache = new Map<string, DelegatableTool>();
	return (name, cwd) => {
		const key = `${cwd}\u0000${name}`;
		const cached = cache.get(key);
		if (cached !== undefined) return cached;
		const created = createBase(name, cwd);
		if (created === undefined) return undefined;
		cache.set(key, created);
		return created;
	};
}

interface OverrideSource {
	/** Definition used for metadata: description, schema, prompt text. */
	readonly metadata: DelegatableTool;
	/** Definition for one working directory, used for execution and expansion. */
	readonly forCwd: (cwd: string) => DelegatableTool;
}

function styledRow(theme: Theme, name: BuiltInToolName, args: unknown, summary: string, isError: boolean): string {
	const call = theme.fg("toolTitle", formatCallLine(name, args));
	const separator = theme.fg("muted", " · ");
	return `${call}${separator}${theme.fg(isError ? "error" : "success", summary)}`;
}

function renderCallSlot(
	name: BuiltInToolName,
	mode: Exclude<DisplayMode, "native">,
	source: OverrideSource,
	args: unknown,
	theme: Theme,
	context: RenderContext,
): Component {
	if (context.expanded) {
		const base = source.forCwd(context.cwd);
		if (base.renderCall !== undefined) return base.renderCall(args, theme, context);
		return EMPTY_COMPONENT;
	}
	if (mode === "hidden") return EMPTY_COMPONENT;
	const state = context.state;
	if (state.startedAt === undefined && context.executionStarted) state.startedAt = Date.now();
	const component = state.line ?? new OneLineComponent();
	state.line = component;
	component.setLine(theme.fg("toolTitle", formatCallLine(name, args)));
	return component;
}

function renderResultSlot(
	name: BuiltInToolName,
	mode: Exclude<DisplayMode, "native">,
	source: OverrideSource,
	result: ToolResultLike,
	options: RenderOptions,
	theme: Theme,
	context: RenderContext,
): Component {
	if (options.expanded) {
		const base = source.forCwd(context.cwd);
		if (base.renderResult !== undefined) return base.renderResult(result, options, theme, context);
		return EMPTY_COMPONENT;
	}
	const state = context.state;
	const durationMs =
		state.startedAt === undefined || options.isPartial ? undefined : Math.max(0, Date.now() - state.startedAt);
	if (context.isError) {
		const row = styledRow(
			theme,
			name,
			context.args,
			formatResultSummary(name, context.args, result, true, undefined),
			true,
		);
		// A `line` row already owns its transcript slot; rewrite it instead of
		// appending a second row, so a failing tool stays one line.
		if (state.line !== undefined) {
			state.line.setLine(row);
			return EMPTY_COMPONENT;
		}
		return lineComponent(row);
	}
	if (mode === "hidden") return EMPTY_COMPONENT;
	const summary = formatResultSummary(name, context.args, result, false, durationMs);
	const row = styledRow(theme, name, context.args, summary, false);
	if (state.line !== undefined) {
		state.line.setLine(row);
		return EMPTY_COMPONENT;
	}
	return lineComponent(row);
}

function lineComponent(text: string): Component {
	const component = new OneLineComponent();
	component.setLine(text);
	return component;
}

export function createToolOverride(
	name: BuiltInToolName,
	mode: Exclude<DisplayMode, "native">,
	source: OverrideSource,
): ToolDefinition {
	const definition = {
		// Spread first: `prepareArguments`, `constrainedSampling` and every future
		// Pi field must stay exactly as the built-in definition carries them.
		...source.metadata,
		// Forced, not inherited: the self shell is what lets an empty compressed
		// row render zero lines. The expanded-row trade-off is in README 限制.
		renderShell: "self",
		renderCall: (args: unknown, theme: Theme, context: RenderContext) =>
			renderCallSlot(name, mode, source, args, theme, context),
		renderResult: (result: ToolResultLike, options: RenderOptions, theme: Theme, context: RenderContext) =>
			renderResultSlot(name, mode, source, result, options, theme, context),
		execute: (
			toolCallId: string,
			params: unknown,
			signal: AbortSignal | undefined,
			onUpdate: UpdateCallback | undefined,
			context: ExtensionContext,
		) => source.forCwd(context.cwd).execute(toolCallId, params, signal, onUpdate, context),
	};
	return definition as unknown as ToolDefinition;
}

/** Registers overrides for every non-`native` tool in the config. */
export function registerToolOverrides(
	pi: ExtensionAPI,
	config: EurekaUiConfigV1,
	options: { readonly cwd?: string } = {},
): readonly BuiltInToolName[] {
	const lookup = createBaseLookup();
	const metadataCwd = options.cwd ?? process.cwd();
	const registered: BuiltInToolName[] = [];
	for (const name of managedToolNames(config)) {
		const mode = config.tools[name].mode;
		if (mode === "native") continue;
		const metadata = lookup(name, metadataCwd);
		if (metadata === undefined) continue;
		const source: OverrideSource = {
			metadata,
			forCwd: (cwd) => lookup(name, cwd) ?? metadata,
		};
		pi.registerTool(createToolOverride(name, mode, source));
		registered.push(name);
	}
	return registered;
}
