import { createHash, createHmac, randomUUID } from "node:crypto";
import { constants as fsConstants, lstatSync, readdirSync } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

export const TRACE_SCHEMA = "pi-context-trace.v1";

const CANARY_PATTERN = /CTX_CANARY_[A-Z0-9_:-]{1,80}/g;
const MAX_DEPTH = 48;
const TRACE_ROOT = "/logs/agent/pi/context-probe";
const CONTEXT_MANAGEMENT_COMMAND = "context-management-status";
const CANDIDATE_OBSERVER_SYMBOL = Symbol.for("pi.context-management.candidate-lifecycle.v1");
const CANDIDATE_PHASES = new Set(["started", "ready", "installed", "discarded", "failed"]);

function hashText(text) {
	return createHash("sha256").update(text).digest("hex");
}

function hmacText(key, text) {
	return createHmac("sha256", key).update(text).digest("hex");
}

function hashOptional(value, key) {
	return typeof value === "string" && value.length > 0 ? hmacText(key, value) : null;
}

function increment(record, key) {
	record[key] = (record[key] ?? 0) + 1;
}

function scanValue(value, state, depth, seen) {
	if (depth > MAX_DEPTH) {
		state.truncated_nodes += 1;
		state.hash.update("depth-limit");
		return;
	}
	if (value === null) {
		state.hash.update("null");
		return;
	}
	if (typeof value === "string") {
		const bytes = Buffer.byteLength(value, "utf8");
		state.string_count += 1;
		state.string_bytes += bytes;
		state.max_string_bytes = Math.max(state.max_string_bytes, bytes);
		state.hash.update("string:");
		state.hash.update(value);
		for (const canary of value.match(CANARY_PATTERN) ?? []) state.canaries.add(canary);
		return;
	}
	if (typeof value === "number" || typeof value === "boolean") {
		state.hash.update(`${typeof value}:${String(value)}`);
		return;
	}
	if (typeof value !== "object") {
		state.hash.update(typeof value);
		return;
	}
	if (ArrayBuffer.isView(value)) {
		const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
		state.binary_count += 1;
		state.binary_bytes += bytes.byteLength;
		state.hash.update("binary:");
		state.hash.update(bytes);
		return;
	}
	if (seen.has(value)) {
		state.circular_nodes += 1;
		state.hash.update("circular");
		return;
	}
	seen.add(value);
	if (Array.isArray(value)) {
		state.array_count += 1;
		state.hash.update(`array:${value.length}`);
		for (const item of value) scanValue(item, state, depth + 1, seen);
		seen.delete(value);
		return;
	}
	state.object_count += 1;
	if (typeof value.role === "string") increment(state.role_counts, value.role);
	if (typeof value.type === "string") increment(state.type_counts, value.type);
	const keys = Object.keys(value).sort();
	state.hash.update(`object:${keys.length}`);
	for (const key of keys) {
		state.hash.update(`key:${key}`);
		scanValue(value[key], state, depth + 1, seen);
	}
	seen.delete(value);
}

export function summarizeValue(value, hmacKey) {
	const state = {
		array_count: 0,
		binary_bytes: 0,
		binary_count: 0,
		canaries: new Set(),
		circular_nodes: 0,
		hash: hmacKey === undefined ? createHash("sha256") : createHmac("sha256", hmacKey),
		max_string_bytes: 0,
		object_count: 0,
		role_counts: {},
		string_bytes: 0,
		string_count: 0,
		truncated_nodes: 0,
		type_counts: {},
	};
	scanValue(value, state, 0, new WeakSet());
	return {
		array_count: state.array_count,
		binary_bytes: state.binary_bytes,
		binary_count: state.binary_count,
		canaries: [...state.canaries].sort().slice(0, 128),
		circular_nodes: state.circular_nodes,
		fingerprint: `sha256:${state.hash.digest("hex")}`,
		max_string_bytes: state.max_string_bytes,
		object_count: state.object_count,
		role_counts: state.role_counts,
		string_bytes: state.string_bytes,
		string_count: state.string_count,
		truncated_nodes: state.truncated_nodes,
		type_counts: state.type_counts,
	};
}

function modelSnapshot(context) {
	const model = context.model;
	return model === undefined
		? null
		: {
			api: model.api,
			context_window: model.contextWindow,
			id: model.id,
			max_tokens: model.maxTokens,
			provider: model.provider,
		};
}

function usageSnapshot(usage) {
	if (typeof usage !== "object" || usage === null || Array.isArray(usage)) return null;
	return {
		cache_read: Number.isFinite(usage.cacheRead) ? usage.cacheRead : 0,
		cache_write: Number.isFinite(usage.cacheWrite) ? usage.cacheWrite : 0,
		input: Number.isFinite(usage.input) ? usage.input : 0,
		output: Number.isFinite(usage.output) ? usage.output : 0,
		total_tokens: Number.isFinite(usage.totalTokens) ? usage.totalTokens : 0,
	};
}

function assistantUsage(messages) {
	const totals = { cache_read: 0, cache_write: 0, input: 0, output: 0, total_tokens: 0 };
	let count = 0;
	for (const message of Array.isArray(messages) ? messages : []) {
		if (message?.role !== "assistant") continue;
		const usage = usageSnapshot(message.usage);
		if (usage === null) continue;
		count += 1;
		for (const key of Object.keys(totals)) totals[key] += usage[key];
	}
	return { assistant_messages: count, ...totals };
}

function safeSessionHash(context, key) {
	try {
		return hmacText(key, context.sessionManager.getSessionId());
	} catch {
		return null;
	}
}

function safeLeafHash(context, key) {
	try {
		return hashOptional(context.sessionManager.getLeafId(), key);
	} catch {
		return null;
	}
}

function safeSessionContext(context) {
	try {
		return context.sessionManager.buildContextEntries();
	} catch {
		return [];
	}
}

function scanSpillTree(spillRoot) {
	let files = 0;
	let bytes = 0;
	let unsafeEntries = 0;
	const pending = [{ depth: 0, path: spillRoot }];
	while (pending.length > 0) {
		const current = pending.pop();
		if (current === undefined) break;
		let entries;
		try {
			const rootStat = lstatSync(current.path);
			if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
				unsafeEntries += 1;
				continue;
			}
			entries = readdirSync(current.path, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const child = join(current.path, entry.name);
			if (entry.isSymbolicLink()) {
				unsafeEntries += 1;
				continue;
			}
			if (entry.isDirectory()) {
				if (current.depth >= 2) unsafeEntries += 1;
				else pending.push({ depth: current.depth + 1, path: child });
				continue;
			}
			if (!entry.isFile()) {
				unsafeEntries += 1;
				continue;
			}
			try {
				const fileStat = lstatSync(child);
				if (fileStat.isSymbolicLink() || !fileStat.isFile()) unsafeEntries += 1;
				else {
					files += 1;
					bytes += fileStat.size;
				}
			} catch {
				unsafeEntries += 1;
			}
		}
	}
	return {
		spill_bytes: bytes,
		spill_files: files,
		unsafe_entries: unsafeEntries,
	};
}

export function inspectContextManagementState(agentDir, commandRegistered = false) {
	const empty = {
		command_registered: commandRegistered === true,
		config_present: false,
		spill_bytes: 0,
		spill_files: 0,
		unsafe_entries: 0,
	};
	if (typeof agentDir !== "string" || !isAbsolute(agentDir)) return empty;
	const stateRoot = join(agentDir, "context-management");
	let configPresent = false;
	try {
		const configStat = lstatSync(join(stateRoot, "config.json"));
		configPresent = configStat.isFile() && !configStat.isSymbolicLink();
	} catch {
		// A missing config is represented by config_present=false.
	}
	return {
		...empty,
		config_present: configPresent,
		...scanSpillTree(join(stateRoot, "spill")),
	};
}

function contextManagementState(pi) {
	let commandRegistered = false;
	try {
		commandRegistered = pi
			.getCommands()
			.some((command) => command.name === CONTEXT_MANAGEMENT_COMMAND);
	} catch {
		// Missing runtime introspection is represented by command_registered=false.
	}
	return inspectContextManagementState(
		process.env.PI_CODING_AGENT_DIR,
		commandRegistered,
	);
}

export default function contextProbe(pi) {
	const configuredPath = process.env.PI_EVAL_CONTEXT_TRACE;
	if (typeof configuredPath !== "string" || configuredPath.length === 0) return;
	if (!isAbsolute(configuredPath)) throw new Error("PI_EVAL_CONTEXT_TRACE must be an absolute path");
	const tracePath = resolve(configuredPath);
	if (!tracePath.startsWith(`${TRACE_ROOT}/`)) {
		throw new Error(`PI_EVAL_CONTEXT_TRACE must stay under ${TRACE_ROOT}`);
	}
	const runId = randomUUID();
	const hmacKey = process.env.PI_EVAL_CONTEXT_TRACE_KEY ?? randomUUID();
	let seq = 0;
	let warned = false;

	async function record(event, context, data) {
		const envelope = {
			data,
			event,
			leaf_hash: safeLeafHash(context, hmacKey),
			run_id: runId,
			schema: TRACE_SCHEMA,
			seq: ++seq,
			session_hash: safeSessionHash(context, hmacKey),
			timestamp: new Date().toISOString(),
		};
		try {
			await withFileMutationQueue(tracePath, async () => {
				const traceDir = dirname(tracePath);
				await mkdir(traceDir, { recursive: true, mode: 0o700 });
				const directoryStat = await lstat(traceDir);
				if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
					throw new Error("context probe trace directory must be a real directory");
				}
				await chmod(traceDir, 0o700);
				const flags =
					fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW;
				const handle = await open(tracePath, flags, 0o600);
				try {
					await handle.writeFile(`${JSON.stringify(envelope)}\n`, "utf8");
					await handle.chmod(0o600);
				} finally {
					await handle.close();
				}
			});
		} catch (error) {
			if (warned) return;
			warned = true;
			console.error(`context probe disabled after trace write failure: ${String(error)}`);
		}
	}

	let observerContext = null;
	const previousCandidateObserver = Reflect.get(globalThis, CANDIDATE_OBSERVER_SYMBOL);
	Reflect.set(globalThis, CANDIDATE_OBSERVER_SYMBOL, (event) => {
		if (
			observerContext === null ||
			typeof event !== "object" ||
			event === null ||
			!CANDIDATE_PHASES.has(event.phase)
		) {
			return;
		}
		void record("candidate_lifecycle", observerContext, {
			detail: typeof event.detail === "string" ? event.detail.slice(0, 160) : null,
			phase: event.phase,
		});
	});

	pi.on("session_start", (_event, context) => {
		observerContext = context;
	});

	pi.on("before_agent_start", (event, context) =>
		record("before_agent_start", context, {
			context_management: contextManagementState(pi),
			images: Array.isArray(event.images) ? event.images.length : 0,
			model: modelSnapshot(context),
			prompt: summarizeValue(event.prompt, hmacKey),
			session_context: summarizeValue(safeSessionContext(context), hmacKey),
			system_prompt: summarizeValue(event.systemPrompt, hmacKey),
		}),
	);
	pi.on("context", (event, context) =>
		record("context", context, {
			context_usage: context.getContextUsage?.() ?? null,
			message_count: event.messages.length,
			messages: summarizeValue(event.messages, hmacKey),
			model: modelSnapshot(context),
		}),
	);
	pi.on("before_provider_request", (event, context) =>
		record("before_provider_request", context, {
			model: modelSnapshot(context),
			payload: summarizeValue(event.payload, hmacKey),
		}),
	);
	pi.on("after_provider_response", (event, context) =>
		record("after_provider_response", context, { status: event.status }),
	);
	pi.on("tool_result", (event, context) =>
		record("tool_result", context, {
			content: summarizeValue(event.content, hmacKey),
			input: summarizeValue(event.input, hmacKey),
			is_error: event.isError,
			tool_call_hash: hashOptional(event.toolCallId, hmacKey),
			tool_name: event.toolName,
		}),
	);
	pi.on("tool_call", (event, context) =>
		record("tool_call", context, {
			input: summarizeValue(event.input, hmacKey),
			tool_call_hash: hashOptional(event.toolCallId, hmacKey),
			tool_name: event.toolName,
		}),
	);
	pi.on("session_before_compact", (event, context) =>
		record("session_before_compact", context, {
			custom_instructions: typeof event.customInstructions === "string",
			first_kept_hash: hashOptional(event.preparation.firstKeptEntryId, hmacKey),
			messages_to_summarize: summarizeValue(event.preparation.messagesToSummarize, hmacKey),
			reason: event.reason,
			tokens_before: event.preparation.tokensBefore,
			turn_prefix: summarizeValue(event.preparation.turnPrefixMessages, hmacKey),
			will_retry: event.willRetry,
		}),
	);
	pi.on("session_compact", (event, context) =>
		record("session_compact", context, {
			first_kept_hash: hashOptional(event.compactionEntry.firstKeptEntryId, hmacKey),
			from_extension: event.fromExtension,
			reason: event.reason,
			summary: summarizeValue(event.compactionEntry.summary, hmacKey),
			tokens_before: event.compactionEntry.tokensBefore,
			usage: usageSnapshot(event.compactionEntry.usage),
			will_retry: event.willRetry,
		}),
	);
	pi.on("agent_end", (event, context) =>
		record("agent_end", context, {
			messages: summarizeValue(event.messages, hmacKey),
			usage: assistantUsage(event.messages),
		}),
	);
	pi.on("message_end", (event, context) =>
		record("message_end", context, {
			message: summarizeValue(event.message, hmacKey),
			role: event.message.role,
			stop_reason: event.message.role === "assistant" ? event.message.stopReason : null,
			usage: event.message.role === "assistant" ? usageSnapshot(event.message.usage) : null,
		}),
	);
	pi.on("agent_settled", (_event, context) =>
		record("agent_settled", context, {
			context_management: contextManagementState(pi),
		}),
	);
	pi.on("session_shutdown", async (event, context) => {
		await record("session_shutdown", context, { reason: event.reason });
		observerContext = null;
		if (previousCandidateObserver === undefined) {
			Reflect.deleteProperty(globalThis, CANDIDATE_OBSERVER_SYMBOL);
		} else {
			Reflect.set(globalThis, CANDIDATE_OBSERVER_SYMBOL, previousCandidateObserver);
		}
	});
	pi.on("session_tree", (event, context) =>
		record("session_tree", context, {
			new_leaf_hash: hashOptional(event.newLeafId, hmacKey),
			old_leaf_hash: hashOptional(event.oldLeafId, hmacKey),
		}),
	);
	pi.on("model_select", (event, context) =>
		record("model_select", context, {
			model: modelSnapshot(context),
			previous_model:
				event.previousModel === undefined
					? null
					: { id: event.previousModel.id, provider: event.previousModel.provider },
			source: event.source,
		}),
	);
}
