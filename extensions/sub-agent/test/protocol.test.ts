import { describe, expect, it } from "vitest";
import {
	type BootstrapFrame,
	isChildFrame,
	isParentFrame,
	type RunAcceptedFrame,
	SUBAGENT_PROTOCOL_VERSION,
} from "../sidecar/protocol.js";

const identity = {
	protocolVersion: SUBAGENT_PROTOCOL_VERSION,
	sessionNonce: "session",
	managerEpoch: "epoch",
	workerGeneration: 1,
} as const;

describe("strict IPC frame validation", () => {
	it("accepts an exact bootstrap and rejects missing, extra, and non-JSON fields", () => {
		const frame: BootstrapFrame = {
			type: "BOOTSTRAP",
			...identity,
			parentPid: 42,
			cwd: "/work",
			agentDir: "/agent",
			piPackageDir: "/pi",
			spoolDir: "/tmp/spool",
			selfExtensionPath: "/extension/index.ts",
			settingsSnapshot: { nested: { enabled: true } },
			projectTrusted: true,
		};
		expect(isParentFrame(frame)).toBe(true);
		expect(isParentFrame({ ...frame, parentPid: 0 })).toBe(false);
		expect(isParentFrame({ ...frame, extra: true })).toBe(false);
		expect(isParentFrame({ ...frame, settingsSnapshot: { bad: Number.NaN } })).toBe(false);
	});

	it("validates the complete spawn tool-source map", () => {
		const frame = {
			type: "SPAWN",
			...identity,
			opId: "op",
			agentId: "agent",
			runId: "run",
			deliveryId: "delivery",
			task: "task",
			model: { provider: "provider", id: "model" },
			thinkingLevel: "high",
			projectContext: [],
			candidateExtensionPaths: [],
			requiredExtensionPaths: [],
			parentToolNames: ["read"],
			parentToolSources: [{ name: "read", path: "/extension.ts" }],
			parentActiveToolNames: ["read"],
		};
		expect(isParentFrame(frame)).toBe(true);
		expect(isParentFrame({ ...frame, parentToolSources: [{ name: "read", path: "" }] })).toBe(false);
		expect(isParentFrame({ ...frame, explicitTools: [""] })).toBe(false);
	});

	it("accepts exact admitted and terminal child frames but rejects type-only impostors", () => {
		const accepted: RunAcceptedFrame = {
			type: "RUN_ACCEPTED",
			...identity,
			opId: "op",
			operation: "spawn",
			agentId: "agent",
			runId: "run",
			model: { provider: "provider", id: "model" },
			thinkingLevel: "high",
			activeToolCount: 1,
			capabilityToolCount: 2,
			degradedExtensions: [],
			unavailableTools: [],
		};
		expect(isChildFrame(accepted)).toBe(true);
		expect(isChildFrame({ type: "RUN_ACCEPTED", ...identity })).toBe(false);
		expect(isChildFrame({ ...accepted, operation: "kill" })).toBe(false);
		expect(
			isChildFrame({
				type: "RUN_TERMINAL",
				...identity,
				terminalOpId: "terminal",
				agentId: "agent",
				runId: "run",
				deliveryId: "delivery",
				completedAt: 1,
				outcome: "FAILED",
				failureCode: "SUBAGENT_MODEL_RUN_FAILED",
			}),
		).toBe(true);
	});
});
