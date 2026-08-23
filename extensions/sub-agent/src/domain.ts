export type SubagentProviderName = "spawn" | "fork";
export type ChildMode = "one-shot" | "continuable";
export type ChildStatus = "running" | "idle" | "ready";
export type SubagentRunStatus = "running" | "interrupting" | "completed" | "interrupted" | "failed";
export type SubagentRunOutcome = "completed" | "interrupted" | "failed";

export type SubagentToolMode = "one-shot" | "continuable";

export interface SubagentDelegationToolConfigV2 {
	readonly toolName: string;
	readonly provider: SubagentProviderName;
	readonly backgroundMode: SubagentToolMode;
	readonly maxDepth: number;
	readonly agentOptions: {
		readonly model: "inherit" | { readonly provider: string; readonly id: string };
		readonly thinkingLevel: "inherit" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	};
	readonly toolFilter: { readonly allow?: readonly string[]; readonly deny?: readonly string[] } | null;
	readonly persona: string | null;
}

export interface SubAgentConfigV2 {
	readonly version: 2;
	readonly delegationTools: readonly SubagentDelegationToolConfigV2[];
	readonly reportDelivery: "wakeup" | "quiet";
}

export interface SubAgentDescriptorV1 {
	readonly version: 1;
	readonly childId: string;
	readonly parentSessionId: string;
	readonly provider: SubagentProviderName;
	readonly mode: ChildMode;
	readonly depth: number;
	readonly model: { readonly provider: string; readonly id: string };
	readonly thinkingLevel: string;
	readonly toolFilter?: { readonly allow?: readonly string[]; readonly deny?: readonly string[] } | undefined;
	readonly persona?: string | undefined;
	readonly createdAt: number;
}

export interface ChildMessage {
	readonly role: "user" | "assistant" | "toolResult";
	readonly text: string;
	readonly toolName?: string;
	readonly isError?: boolean;
}

export interface ChildSessionHandle {
	readonly childId: string;
	readonly sessionFile?: string | undefined;
	prompt(text: string): Promise<void>;
	abort(): Promise<void>;
	dispose(): Promise<void>;
	messages(): readonly ChildMessage[];
}

export interface ChildSessionRequest {
	readonly childId: string;
	readonly provider: SubagentProviderName;
	readonly mode: ChildMode;
	readonly parentSessionId: string;
	readonly parentSessionFile?: string | undefined;
	readonly forkBeforeEntryId?: string | undefined;
	readonly cwd: string;
	readonly sessionDir?: string | undefined;
	readonly depth: number;
	readonly model: { readonly provider: string; readonly id: string };
	readonly thinkingLevel: string;
	readonly toolNames: readonly string[];
	readonly toolFilter?: { readonly allow?: readonly string[]; readonly deny?: readonly string[] } | undefined;
	readonly persona?: string | undefined;
	readonly prompt: string;
	readonly signal?: AbortSignal | undefined;
	readonly onReport: (output: string) => Promise<string>;
}

export interface ChildSessionFactory {
	create(request: ChildSessionRequest): Promise<ChildSessionHandle>;
}

export interface SubagentStartResult {
	readonly childId: string;
	readonly foreground: boolean;
	readonly output?: string;
}

export interface PendingChildMessage {
	readonly messageId: string;
	readonly text: string;
}

export interface ChildRecord {
	readonly childId: string;
	readonly parentSessionId: string;
	readonly provider: SubagentProviderName;
	readonly mode: ChildMode;
	readonly depth: number;
	readonly label: string;
	sessionFile?: string | undefined;
	live?: ChildSessionHandle | undefined;
	active: boolean;
	interruptRequested: boolean;
	runId: string;
	runStatus: SubagentRunStatus;
	readonly pending: PendingChildMessage[];
	status: ChildStatus;
	readonly descriptor: SubAgentDescriptorV1;
}

export class SubagentError extends Error {
	constructor(
		message: string,
		readonly code: string = "SUBAGENT_ERROR",
	) {
		super(message);
		this.name = "SubagentError";
	}
}
