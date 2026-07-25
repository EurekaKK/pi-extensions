import { describe, expect, it } from "vitest";
import {
	createErrorResult,
	createSuccessResult,
	ERROR_BEHAVIOR,
	ERROR_CODES_BY_OPERATION,
	INVALID_ROOT_SENTINEL_KEY,
	InputValidationError,
	isErrorCodeForOperation,
	MAX_CONTROL_MESSAGE_BYTES,
	MAX_TEXT_BYTES,
	type ManagementErrorCodeV1,
	prepareTransportArguments,
	SUBAGENT_TOOL_NAMES,
	TOOL_DESCRIPTIONS,
	TRANSPORT_PROPERTY_DESCRIPTIONS,
	TRANSPORT_ROOT_DESCRIPTION,
	TRANSPORT_SCHEMAS,
	validateCancelInput,
	validateKillInput,
	validateListInput,
	validateSendInput,
	validateSpawnInput,
	validateWaitInput,
} from "../src/contracts.js";

function expectInputError(action: () => unknown, code: InputValidationError["code"]): void {
	try {
		action();
		throw new Error("expected validation to fail");
	} catch (error) {
		expect(error).toBeInstanceOf(InputValidationError);
		expect((error as InputValidationError).code).toBe(code);
	}
}

describe("public tool prompt contract", () => {
	it("keeps all six descriptions byte-for-byte stable", () => {
		expect(SUBAGENT_TOOL_NAMES).toEqual([
			"subagent_spawn",
			"subagent_send",
			"subagent_wait",
			"subagent_list",
			"subagent_cancel",
			"subagent_kill",
		]);
		expect(TOOL_DESCRIPTIONS).toEqual({
			subagent_spawn:
				"Create a new sub-agent with a parent-defined task and start its first run. Use it for independent work that does not require an existing sub-agent's private context.",
			subagent_send:
				"Send one new task to an existing IDLE sub-agent while preserving its private context. This fails instead of queuing when the agent is busy.",
			subagent_wait:
				'Wait for terminal results from specific sub-agent runs. Results are delivered exactly once; use subagent_list with view "deliveries" to rediscover unread run IDs.',
			subagent_list:
				"Inspect sub-agent or pending-delivery metadata without reading report bodies. Use direct lookup for known agent IDs or paginated views for discovery.",
			subagent_cancel:
				"Request cooperative cancellation of the exact active run. This does not kill the sub-agent and must be followed by subagent_wait.",
			subagent_kill:
				"Remove an IDLE sub-agent after checking its last run ID. This never interrupts a running task and does not delete unread deliveries.",
		});
	});

	it("uses optional Unknown properties and the fixed root/property descriptions", () => {
		expect(TRANSPORT_ROOT_DESCRIPTION).toBe(
			"Transport envelope. The extension validates the effective input contract; do not send unknown fields.",
		);
		expect(TRANSPORT_PROPERTY_DESCRIPTIONS).toEqual({
			spawn: {
				task: "Required string: the child agent's role, task, and expected deliverable; non-blank, at most 64 KiB UTF-8.",
				label:
					"Optional single-line display label; non-blank after trimming, at most 80 Unicode code points, no C0/C1 controls.",
				projectContext: 'Optional string enum "inherit" or "none"; defaults to "inherit".',
				tools:
					"Optional array of unique non-empty tool-name strings. Omit for best-effort inheritance; an empty array means no tools.",
			},
			send: {
				agentId: "Required non-empty opaque agent ID returned by spawn or list.",
				message: "Required non-blank string appended to this child agent's private context; at most 64 KiB UTF-8.",
			},
			wait: {
				runIds: "Required array of 1 to 16 unique non-empty opaque run IDs.",
				mode: 'Required string enum "any" or "all".',
				timeoutMs:
					"Optional integer from 0 to 2147483647 milliseconds; omit to wait until completion, abort, or session shutdown.",
			},
			list: {
				view: 'Optional string enum "agents" or "deliveries"; defaults to "agents"; forbidden with agentIds.',
				states: "Optional non-empty unique state filter for the selected paginated view; forbidden with agentIds.",
				cursor: "Optional opaque pagination cursor; forbidden with agentIds.",
				limit: "Optional integer from 1 to 16; defaults to 8; forbidden with agentIds.",
				agentIds:
					"Direct-lookup branch only: array of 1 to 16 unique non-empty opaque agent IDs; mutually exclusive with view, states, cursor, and limit.",
			},
			cancel: {
				agentId: "Required non-empty opaque agent ID.",
				expectedRunId: "Required non-empty opaque ID of the exact active run to cancel.",
				reason: "Required string explaining the cancellation; at most 2 KiB UTF-8.",
			},
			kill: {
				agentId: "Required non-empty opaque ID of an IDLE agent.",
				expectedLastRunId: "Required non-empty opaque ID of that agent's last run.",
			},
		});

		for (const [operation, schema] of Object.entries(TRANSPORT_SCHEMAS)) {
			const expectedDescriptions = Object.entries(
				TRANSPORT_PROPERTY_DESCRIPTIONS[operation as keyof typeof TRANSPORT_PROPERTY_DESCRIPTIONS],
			);
			const jsonSchema = JSON.parse(JSON.stringify(schema)) as {
				additionalProperties?: boolean;
				description?: string;
				properties?: Record<string, { description?: string; type?: string }>;
				required?: string[];
				type?: string;
			};
			expect(jsonSchema.type).toBe("object");
			expect(jsonSchema.additionalProperties).toBe(true);
			expect(jsonSchema.description).toBe(TRANSPORT_ROOT_DESCRIPTION);
			expect(jsonSchema.required).toBeUndefined();
			for (const [propertyName, property] of Object.entries(jsonSchema.properties ?? {})) {
				expect(property.description).toBeTypeOf("string");
				expect(property.description).toBe(expectedDescriptions.find(([name]) => name === propertyName)?.[1]);
				expect(property.type).toBeUndefined();
			}
		}
	});

	it("preserves plain objects and maps every invalid root to the string sentinel", () => {
		const object = { task: 42, unknown: "kept for execute" };
		expect(prepareTransportArguments(object)).toBe(object);
		for (const value of [null, [], "x", 1, true]) {
			expect(prepareTransportArguments(value)).toEqual({ [INVALID_ROOT_SENTINEL_KEY]: true });
		}
		expect(prepareTransportArguments({ [INVALID_ROOT_SENTINEL_KEY]: true })).toEqual({
			[INVALID_ROOT_SENTINEL_KEY]: true,
		});
	});
});

describe("effective validators", () => {
	it("normalizes spawn defaults without coercing values", () => {
		expect(validateSpawnInput({ task: "investigate" })).toEqual({
			task: "investigate",
			projectContext: "inherit",
		});
		expect(validateSpawnInput({ task: "x", projectContext: "none", tools: [], label: "review" })).toEqual({
			task: "x",
			projectContext: "none",
			tools: [],
			label: "review",
		});
		expectInputError(() => validateSpawnInput({ task: 1 }), "SUBAGENT_INPUT_INVALID");
		expectInputError(() => validateSpawnInput({ task: "x", unknown: "secret-value" }), "SUBAGENT_INPUT_INVALID");
		expectInputError(
			() => validateSpawnInput({ task: "x", [INVALID_ROOT_SENTINEL_KEY]: true }),
			"SUBAGENT_INPUT_INVALID",
		);
	});

	it("enforces UTF-8, Unicode-code-point, control, duplicate, and IPC boundaries", () => {
		expect(validateSpawnInput({ task: "a".repeat(MAX_TEXT_BYTES), label: "😀".repeat(80) }).task).toHaveLength(
			MAX_TEXT_BYTES,
		);
		expectInputError(() => validateSpawnInput({ task: "a".repeat(MAX_TEXT_BYTES + 1) }), "SUBAGENT_INPUT_TOO_LARGE");
		expectInputError(() => validateSpawnInput({ task: "x", label: "😀".repeat(81) }), "SUBAGENT_INPUT_INVALID");
		expectInputError(() => validateSpawnInput({ task: "x", label: "line\nbreak" }), "SUBAGENT_INPUT_INVALID");
		expectInputError(() => validateSpawnInput({ task: "x", label: "line\u2028break" }), "SUBAGENT_INPUT_INVALID");
		expectInputError(() => validateSpawnInput({ task: "x", tools: ["read", "read"] }), "SUBAGENT_INPUT_INVALID");
		expectInputError(
			() => validateSpawnInput({ task: "x", tools: ["z".repeat(MAX_CONTROL_MESSAGE_BYTES)] }),
			"SUBAGENT_INPUT_TOO_LARGE",
		);
	});

	it("validates send, wait, cancel, and kill without string/number coercion", () => {
		expect(validateSendInput({ agentId: "agent-1", message: "continue" })).toEqual({
			agentId: "agent-1",
			message: "continue",
		});
		expect(validateWaitInput({ runIds: ["r1", "r2"], mode: "all", timeoutMs: 0 })).toEqual({
			runIds: ["r1", "r2"],
			mode: "all",
			timeoutMs: 0,
		});
		expect(validateCancelInput({ agentId: "a", expectedRunId: "r", reason: "" })).toEqual({
			agentId: "a",
			expectedRunId: "r",
			reason: "",
		});
		expect(validateKillInput({ agentId: "a", expectedLastRunId: "r" })).toEqual({
			agentId: "a",
			expectedLastRunId: "r",
		});
		expectInputError(() => validateWaitInput({ runIds: ["r", "r"], mode: "any" }), "SUBAGENT_INPUT_INVALID");
		expectInputError(() => validateWaitInput({ runIds: ["r"], mode: "any", timeoutMs: "0" }), "SUBAGENT_INPUT_INVALID");
		expectInputError(
			() => validateCancelInput({ agentId: "a", expectedRunId: "r", reason: "😀".repeat(513) }),
			"SUBAGENT_INPUT_TOO_LARGE",
		);
	});

	it("discriminates all three list branches and rejects cross-branch fields", () => {
		expect(validateListInput({})).toEqual({ view: "agents", limit: 8 });
		expect(validateListInput({ view: "agents", states: ["LOST", "IDLE"], limit: 16 })).toEqual({
			view: "agents",
			states: ["IDLE", "LOST"],
			limit: 16,
		});
		expect(
			validateListInput({
				view: "deliveries",
				states: ["AWAITING_PERSISTENCE", "READY"],
				cursor: "cursor",
			}),
		).toEqual({
			view: "deliveries",
			states: ["READY", "AWAITING_PERSISTENCE"],
			cursor: "cursor",
			limit: 8,
		});
		expect(validateListInput({ agentIds: ["a2", "a1"] })).toEqual({ agentIds: ["a2", "a1"] });
		expectInputError(() => validateListInput({ agentIds: ["a"], limit: 8 }), "SUBAGENT_INPUT_INVALID");
		expectInputError(() => validateListInput({ view: "agents", states: ["READY"] }), "SUBAGENT_INPUT_INVALID");
		expectInputError(
			() => validateListInput({ view: "deliveries", states: ["READY", "READY"] }),
			"SUBAGENT_INPUT_INVALID",
		);
	});
});

describe("stable management errors and result helpers", () => {
	it("covers every operation code with exactly one fixed behavior", () => {
		const codes = new Set<ManagementErrorCodeV1>();
		for (const [operation, operationCodes] of Object.entries(ERROR_CODES_BY_OPERATION)) {
			for (const code of operationCodes) {
				codes.add(code);
				expect(isErrorCodeForOperation(operation as keyof typeof ERROR_CODES_BY_OPERATION, code)).toBe(true);
				expect(ERROR_BEHAVIOR[code]).toBeDefined();
			}
		}
		expect([...codes].sort()).toEqual(Object.keys(ERROR_BEHAVIOR).sort());
		expect(ERROR_BEHAVIOR.SUBAGENT_WORKER_START_FAILED).toEqual({ sideEffects: "none", retry: "safe" });
		expect(ERROR_BEHAVIOR.SUBAGENT_START_UNCERTAIN).toEqual({ sideEffects: "possible", retry: "never" });
		expect(ERROR_BEHAVIOR.SUBAGENT_REQUIRED_EXTENSION_FAILED).toEqual({
			sideEffects: "possible",
			retry: "after_state_change",
		});
	});

	it("produces operation-discriminated, non-reflective error results", () => {
		const result = createErrorResult("send", "SUBAGENT_BUSY", {
			agentId: "agent-1",
			currentRunId: "run-1",
		});
		expect(result).toEqual({
			content: [
				{
					type: "text",
					text: "SUBAGENT_ERROR code=SUBAGENT_BUSY operation=send sideEffects=none retry=after_state_change\nAgent agent-1 is already running run-1.\nNo message was delivered or queued, and the current run was not affected.\nIf you need this agent's existing context, wait for that run to finish and then send again.\nIf the new task does not need that context, spawn a new agent.",
				},
			],
			details: {
				schemaVersion: 1,
				operation: "send",
				code: "SUBAGENT_BUSY",
				sideEffects: "none",
				retry: "after_state_change",
				agentId: "agent-1",
				currentRunId: "run-1",
				message:
					"Agent agent-1 is already running run-1.\nNo message was delivered or queued, and the current run was not affected.",
				guidance:
					"If you need this agent's existing context, wait for that run to finish and then send again.\nIf the new task does not need that context, spawn a new agent.",
			},
			isError: true,
		});

		const sensitiveMetadata = {
			agentId: "safe-agent-id",
			task: "secret task",
			message: "secret message",
			reason: "secret cancel reason",
			config: "secret config",
		};
		const sensitiveResult = createErrorResult("spawn", "SUBAGENT_INPUT_INVALID", sensitiveMetadata);
		for (const secret of [
			sensitiveMetadata.task,
			sensitiveMetadata.message,
			sensitiveMetadata.reason,
			sensitiveMetadata.config,
		]) {
			expect(sensitiveResult.content[0].text).not.toContain(secret);
		}
	});

	it("renders enum-controlled headers for every operation and error code", () => {
		for (const operation of Object.keys(ERROR_CODES_BY_OPERATION) as Array<keyof typeof ERROR_CODES_BY_OPERATION>) {
			for (const code of ERROR_CODES_BY_OPERATION[operation]) {
				const result = createErrorResult(operation, code);
				const expectedHeader =
					`SUBAGENT_ERROR code=${result.details.code} operation=${result.details.operation} ` +
					`sideEffects=${result.details.sideEffects} retry=${result.details.retry}`;
				const expectedPublicText =
					result.details.guidance === undefined
						? result.details.message
						: `${result.details.message}\n${result.details.guidance}`;
				const [header, ...publicTextLines] = result.content[0].text.split("\n");

				expect(header).toBe(expectedHeader);
				expect(publicTextLines.join("\n")).toBe(expectedPublicText);
			}
		}
	});

	it("sets wait isError from delivered outcomes and treats timeout as success", () => {
		const failedWait = createSuccessResult(
			{
				schemaVersion: 1,
				operation: "wait",
				status: "DELIVERED",
				mode: "any",
				deliveries: [
					{
						deliveryId: "d",
						agentId: "a",
						runId: "r",
						sequence: 1,
						completedAt: 2,
						outcome: "FAILED",
						failureCode: "SUBAGENT_EMPTY_RESULT",
					},
				],
				remainingRunIds: [],
			},
			"delivered",
		);
		expect(failedWait.isError).toBe(true);
		expect(failedWait.content[0].text).toContain(
			"The deliveries listed above have been delivered exactly once. Do not wait for those run IDs again.",
		);
		expect(
			createSuccessResult(
				{
					schemaVersion: 1,
					operation: "wait",
					status: "TIMEOUT",
					mode: "all",
					timeoutMs: 0,
					pending: [{ runId: "r", state: "RUNNING" }],
				},
				"timeout",
			).isError,
		).toBe(false);
	});
});
