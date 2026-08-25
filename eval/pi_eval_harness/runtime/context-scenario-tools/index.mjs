import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineTool, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const PARAMETERS = Type.Object(
	{
		bytes: Type.Integer({ minimum: 256, maximum: 250_000 }),
		label: Type.String({ minLength: 1, maxLength: 80, pattern: "^CTX_CANARY_[A-Z0-9_:-]+$" }),
	},
	{ additionalProperties: false },
);
const CHECKPOINT_SEED_PARAMETERS = Type.Object(
	{ cycle: Type.Optional(Type.Integer({ minimum: 1, maximum: 2 })) },
	{ additionalProperties: false },
);
const CHECKPOINT_SEED_CHUNKS = 9;
const CHECKPOINT_SEED_BYTES_PER_CHUNK = 100_000;
const CHECKPOINT_PERSIST_CANARY = "CTX_CANARY_CHECKPOINT_PERSIST_ALPHA_7Q2M";
const CHECKPOINT_TAIL_CANARY = "CTX_CANARY_CHECKPOINT_TAIL_OMEGA_9K4R";
const CHECKPOINT_SECOND_PERSIST_CANARY = "CTX_CANARY_CHECKPOINT_PERSIST_BETA_4N8V";
const CHECKPOINT_SECOND_TAIL_CANARY = "CTX_CANARY_CHECKPOINT_TAIL_SIGMA_6P3D";

export function burstText(bytes, label) {
	const head = `HEAD ${label}\n`;
	const tail = `\nTAIL ${label}`;
	const fillBytes = Math.max(0, bytes - Buffer.byteLength(head) - Buffer.byteLength(tail));
	const text = `${head}${"x".repeat(fillBytes)}${tail}`;
	if (Buffer.byteLength(text) !== bytes) throw new Error("context_burst failed to produce the requested byte count");
	return text;
}

export function checkpointHistoryChunks(chunks, bytesPerChunk, cycle = 1) {
	if (!Number.isInteger(chunks) || chunks < 2) throw new Error("checkpoint history requires at least two chunks");
	if (!Number.isInteger(bytesPerChunk) || bytesPerChunk < 256) {
		throw new Error("checkpoint history chunk size must be at least 256 bytes");
	}
	if (cycle !== 1 && cycle !== 2) throw new Error("checkpoint history cycle must be 1 or 2");
	return Array.from({ length: chunks }, (_, index) => {
		const position = index + 1;
		const persistentCanary = cycle === 1 ? CHECKPOINT_PERSIST_CANARY : CHECKPOINT_SECOND_PERSIST_CANARY;
		const tailCanary = cycle === 1 ? CHECKPOINT_TAIL_CANARY : CHECKPOINT_SECOND_TAIL_CANARY;
		const fillerPrefix = cycle === 1 ? "CTX_CANARY_CHECKPOINT_FILLER" : "CTX_CANARY_CHECKPOINT_SECOND_FILLER";
		const label =
			index === 0
				? persistentCanary
				: index === chunks - 1
					? tailCanary
					: `${fillerPrefix}_${String(position).padStart(2, "0")}`;
		const head = `CHECKPOINT HISTORY CHUNK ${position}/${chunks}\nPreserve this exact continuity token: ${label}\n`;
		const tail = `\nEND CHECKPOINT HISTORY CHUNK ${position}/${chunks}\nExact continuity token: ${label}`;
		const fillBytes = bytesPerChunk - Buffer.byteLength(head) - Buffer.byteLength(tail);
		if (fillBytes < 0) throw new Error("checkpoint history chunk budget is too small");
		const text = `${head}${"x".repeat(fillBytes)}${tail}`;
		if (Buffer.byteLength(text) !== bytesPerChunk) {
			throw new Error("checkpoint history failed to produce the requested byte count");
		}
		return { label, text };
	});
}

export default function contextScenarioTools(pi) {
	let pendingCheckpointHistory = null;
	let checkpointHistoryScheduling = false;

	pi.registerTool(
		defineTool({
			name: "context_burst",
			label: "Context burst",
			description:
				"Evaluation-only tool. Return deterministic plain text of exactly `bytes` UTF-8 bytes with the supplied CTX_CANARY label at both ends.",
			parameters: PARAMETERS,
			async execute(_toolCallId, parameters, signal, _onUpdate, context) {
				if (signal?.aborted) throw new Error("Operation aborted");
				const text = burstText(parameters.bytes, parameters.label);
				const markerDir = join(context.cwd, ".context-lab");
				const markerPath = join(markerDir, `${parameters.label}.json`);
				await withFileMutationQueue(markerPath, async () => {
					await mkdir(markerDir, { recursive: true });
					await writeFile(
						markerPath,
						`${JSON.stringify({
							bytes: parameters.bytes,
							label: parameters.label,
							sha256: createHash("sha256").update(text).digest("hex"),
						})}\n`,
						"utf8",
					);
				});
				return {
					content: [{ type: "text", text }],
					details: { bytes: parameters.bytes, label: parameters.label },
				};
			},
		}),
	);

	pi.registerTool(
		defineTool({
			name: "context_seed_history",
			label: "Context history seed",
			description:
				"Evaluation-only tool. Schedule a fixed 9 × 100,000-byte model-visible history seed after the current agent run settles. Call at most once.",
			parameters: CHECKPOINT_SEED_PARAMETERS,
			async execute(_toolCallId, parameters, signal, _onUpdate, context) {
				if (signal?.aborted) throw new Error("Operation aborted");
				if (checkpointHistoryScheduling || pendingCheckpointHistory !== null) {
					throw new Error("Checkpoint history is already scheduled");
				}
				checkpointHistoryScheduling = true;
				const cycle = parameters.cycle ?? 1;
				const chunks = checkpointHistoryChunks(
					CHECKPOINT_SEED_CHUNKS,
					CHECKPOINT_SEED_BYTES_PER_CHUNK,
					cycle,
				);
				const hash = createHash("sha256");
				for (const chunk of chunks) hash.update(chunk.text);
				const markerDir = join(context.cwd, ".context-lab");
				const markerPath = join(markerDir, cycle === 1 ? "checkpoint-history.json" : "checkpoint-history-2.json");
				try {
					await withFileMutationQueue(markerPath, async () => {
						await mkdir(markerDir, { recursive: true });
						await writeFile(
							markerPath,
							`${JSON.stringify({
								bytes_per_chunk: CHECKPOINT_SEED_BYTES_PER_CHUNK,
								chunks: CHECKPOINT_SEED_CHUNKS,
								cycle,
								sha256: hash.digest("hex"),
								total_bytes: CHECKPOINT_SEED_CHUNKS * CHECKPOINT_SEED_BYTES_PER_CHUNK,
							})}\n`,
							"utf8",
						);
					});
					pendingCheckpointHistory = chunks;
				} finally {
					checkpointHistoryScheduling = false;
				}
				return {
					content: [
						{
							type: "text",
							text: "Scheduled nine checkpoint-history chunks after this run settles.",
						},
					],
					details: {
						bytes_per_chunk: CHECKPOINT_SEED_BYTES_PER_CHUNK,
						chunks: CHECKPOINT_SEED_CHUNKS,
						cycle,
					},
				};
			},
		}),
	);

	pi.on("agent_settled", () => {
		const chunks = pendingCheckpointHistory;
		pendingCheckpointHistory = null;
		if (chunks === null) return;
		for (const [index, chunk] of chunks.entries()) {
			pi.sendMessage(
				{
					customType: "context-scenario-history",
					content: chunk.text,
					display: false,
					details: {
						bytes: Buffer.byteLength(chunk.text),
						index: index + 1,
						total: chunks.length,
					},
				},
				{ triggerTurn: false },
			);
		}
	});
}
