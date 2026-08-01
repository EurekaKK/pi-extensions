import { randomUUID } from "node:crypto";
import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { fauxToolCall, validateToolArguments } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
	createGoalEvaluatorTools,
	GoalEvaluationFormatGuard,
	GoalEvaluationReportSchema,
	validateGoalEvaluationReport,
} from "../src/evaluator-tools.js";
import {
	createGoalEvaluationSnapshot,
	type GoalEvaluationHistoryRecord,
	type GoalEvaluationSnapshotBundle,
} from "../src/snapshots.js";

const bundles: GoalEvaluationSnapshotBundle[] = [];

afterEach(async () => {
	await Promise.allSettled(bundles.splice(0).map(async (bundle) => await bundle.cleanup()));
});

function userMessage(
	content: string | Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>,
) {
	return { role: "user" as const, content, timestamp: Date.now() };
}

async function fixture(options?: {
	readonly text?: string;
	readonly history?: readonly GoalEvaluationHistoryRecord[];
}) {
	const manager = SessionManager.inMemory("/project");
	const anchor = manager.appendMessage(userMessage("creation Needle"));
	const imageData = Buffer.from("registered-image").toString("base64");
	const currentLeaf = manager.appendMessage(
		userMessage([
			{ type: "text", text: options?.text ?? "current nEeDlE evidence" },
			{ type: "image", data: imageData, mimeType: "image/png" },
		]),
	);
	const snapshot = await createGoalEvaluationSnapshot({
		ownerSessionId: `session-${randomUUID()}`,
		entries: manager.getEntries(),
		currentLeafId: currentLeaf,
		creationAnchorEntryId: anchor,
		evaluationHistory: options?.history ?? [],
		capabilities: {
			activeTools: [],
			mode: "tui",
			cwd: "/project",
			projectTrusted: true,
			model: { provider: "fake", id: "model" },
			thinkingLevel: "medium",
		},
	});
	bundles.push(snapshot);
	return snapshot;
}

function resultText(result: {
	readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
}): string {
	const first = result.content[0];
	if (first?.type !== "text" || typeof first.text !== "string") throw new Error("Expected text result.");
	return first.text;
}

describe("goal evaluator snapshot tools", () => {
	it("exposes exactly the four evaluator tools", async () => {
		const snapshot = await fixture();
		const evaluatorTools = createGoalEvaluatorTools({ snapshot, supportsImages: true });
		expect(evaluatorTools.tools.map((tool) => tool.name)).toEqual([
			"goal_snapshot_read",
			"goal_snapshot_search",
			"goal_snapshot_image",
			"goal_submit_evaluation",
		]);
	});

	it("reads bounded numbered lines and reports more content", async () => {
		const snapshot = await fixture({ text: "x".repeat(90 * 1024) });
		const { readTool } = createGoalEvaluatorTools({ snapshot, supportsImages: true });
		const result = await readTool.execute(
			"read-1",
			{ path: "current-context.jsonl", startLine: 1, lineCount: 200 },
			undefined,
			undefined,
			undefined as never,
		);
		const text = resultText(result);
		expect(text).toContain("Path: current-context.jsonl");
		expect(text).toContain("1:");
		expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(64 * 1024);
		expect(result.details.hasMore).toBe(true);
	});

	it("returns no more than 200 lines per read", async () => {
		const history: GoalEvaluationHistoryRecord[] = Array.from({ length: 205 }, (_, index) => ({
			evaluationNumber: index + 1,
			decision: "continue",
			progress: `progress ${index + 1}`,
			reason: "path remains",
			next_action: "continue",
			evidence: ["evidence"],
			activeElapsedMs: index,
			mainRunId: `run-${index + 1}`,
			timestamp: "2026-08-01T00:00:00.000Z",
		}));
		const snapshot = await fixture({ history });
		const { readTool } = createGoalEvaluatorTools({ snapshot, supportsImages: true });
		const result = await readTool.execute(
			"read-lines",
			{ path: "evaluation-history.jsonl" },
			undefined,
			undefined,
			undefined as never,
		);
		const text = resultText(result);
		expect(text).toContain("200:");
		expect(text).not.toContain("\n201:");
		expect(result.details.hasMore).toBe(true);
	});

	it("rejects absolute paths, parent traversal, and symlink escape", async () => {
		const snapshot = await fixture();
		const { readTool, searchTool } = createGoalEvaluatorTools({ snapshot, supportsImages: true });
		await expect(
			readTool.execute("read-absolute", { path: "/etc/hosts" }, undefined, undefined, undefined as never),
		).rejects.toThrow("relative");
		await expect(
			readTool.execute("read-parent", { path: "../outside" }, undefined, undefined, undefined as never),
		).rejects.toThrow("traversal");

		await symlink("/etc/hosts", join(snapshot.root, "escape.txt"));
		await expect(
			readTool.execute("read-link", { path: "escape.txt" }, undefined, undefined, undefined as never),
		).rejects.toThrow("symbolic link");
		await expect(
			searchTool.execute(
				"search-link",
				{ query: "localhost", path: "escape.txt" },
				undefined,
				undefined,
				undefined as never,
			),
		).rejects.toThrow("symbolic link");
	});

	it("searches literal text case-insensitively and respects the result limit", async () => {
		const history: GoalEvaluationHistoryRecord[] = Array.from({ length: 8 }, (_, index) => ({
			evaluationNumber: index + 1,
			decision: "continue",
			progress: `Needle progress ${index}`,
			reason: "path remains",
			next_action: "continue",
			evidence: ["evidence"],
			activeElapsedMs: index,
			mainRunId: `run-${index}`,
			timestamp: `2026-08-01T00:00:0${index}.000Z`,
		}));
		const snapshot = await fixture({ history });
		const { searchTool } = createGoalEvaluatorTools({ snapshot, supportsImages: true });
		const result = await searchTool.execute(
			"search-1",
			{ query: "needle", path: "evaluation-history.jsonl", maxResults: 3 },
			undefined,
			undefined,
			undefined as never,
		);
		expect(result.details.resultCount).toBe(3);
		expect(resultText(result)).toContain("evaluation-history.jsonl");

		const literal = await searchTool.execute(
			"search-literal",
			{ query: "Needle progress 7", path: "evaluation-history.jsonl" },
			undefined,
			undefined,
			undefined as never,
		);
		expect(literal.details.resultCount).toBe(1);
		await expect(
			searchTool.execute("search-blank", { query: "   " }, undefined, undefined, undefined as never),
		).rejects.toThrow("blank");
	});

	it("returns only registered images and reports model image unavailability", async () => {
		const snapshot = await fixture();
		const image = snapshot.images[0];
		if (image === undefined) throw new Error("Expected image fixture.");
		const supported = createGoalEvaluatorTools({ snapshot, supportsImages: true });
		const result = await supported.imageTool.execute(
			"image-1",
			{ id: image.id },
			undefined,
			undefined,
			undefined as never,
		);
		expect(result.content.some((content) => content.type === "image")).toBe(true);
		expect(result.details.imageAvailable).toBe(true);

		const unsupported = createGoalEvaluatorTools({ snapshot, supportsImages: false });
		const unavailable = await unsupported.imageTool.execute(
			"image-2",
			{ id: image.id },
			undefined,
			undefined,
			undefined as never,
		);
		expect(resultText(unavailable)).toContain("cannot inspect images");
		expect(unavailable.details.imageAvailable).toBe(false);
		await expect(
			unsupported.imageTool.execute(
				"image-unknown",
				{ id: "img-not-registered" },
				undefined,
				undefined,
				undefined as never,
			),
		).rejects.toThrow("Unknown snapshot image id");
	});

	it("propagates an already-aborted signal", async () => {
		const snapshot = await fixture();
		const { readTool } = createGoalEvaluatorTools({ snapshot, supportsImages: true });
		const controller = new AbortController();
		controller.abort(new Error("test abort"));
		await expect(
			readTool.execute("read-aborted", { path: "README.md" }, controller.signal, undefined, undefined as never),
		).rejects.toThrow("test abort");
	});
});

describe("goal evaluation report submission", () => {
	const validContinue = {
		decision: "continue" as const,
		progress: "A concrete part is done.",
		reason: "A verifiable path remains.",
		next_action: "Run the focused verification.",
		evidence: ["current-context.jsonl:1"],
	};
	const validComplete = {
		decision: "complete" as const,
		progress: "Every required outcome is verified.",
		reason: "The completion criteria have concrete evidence.",
		next_action: null,
		evidence: ["current-context.jsonl:2"],
	};

	it("uses a provider-friendly single-object schema for every canonical decision", async () => {
		const serializedSchema = JSON.stringify(GoalEvaluationReportSchema);
		expect(GoalEvaluationReportSchema).toMatchObject({
			type: "object",
			required: ["decision", "progress", "reason", "next_action", "evidence"],
			additionalProperties: false,
			properties: {
				decision: { type: "string", enum: ["continue", "complete", "fail"] },
				next_action: { type: ["string", "null"] },
			},
		});
		expect(serializedSchema).not.toContain('"anyOf"');
		expect(serializedSchema).not.toContain('"oneOf"');
		expect(serializedSchema).not.toContain('"const"');

		for (const report of [validContinue, validComplete, { ...validComplete, decision: "fail" as const }]) {
			const snapshot = await fixture();
			const { submitTool } = createGoalEvaluatorTools({ snapshot, supportsImages: true });
			expect(validateToolArguments(submitTool, fauxToolCall(submitTool.name, report))).toEqual(report);
		}
	});

	it("strictly validates exact fields and semantic string constraints", () => {
		expect(validateGoalEvaluationReport(validContinue)).toMatchObject({ ok: true });
		expect(validateGoalEvaluationReport({ ...validContinue, progress: "   " })).toMatchObject({ ok: false });
		expect(validateGoalEvaluationReport({ ...validContinue, next_action: null })).toMatchObject({ ok: false });
		expect(
			validateGoalEvaluationReport({
				...validContinue,
				decision: "complete",
				next_action: "must be null",
			}),
		).toMatchObject({ ok: false });
		expect(validateGoalEvaluationReport({ ...validContinue, evidence: [] })).toMatchObject({ ok: false });
		expect(validateGoalEvaluationReport({ ...validContinue, extra: true })).toMatchObject({ ok: false });
	});

	it("accepts and terminates on only the first valid report", async () => {
		const snapshot = await fixture();
		const evaluatorTools = createGoalEvaluatorTools({ snapshot, supportsImages: true });
		const accepted = await evaluatorTools.submitTool.execute(
			"submit-1",
			validContinue,
			undefined,
			undefined,
			undefined as never,
		);
		expect(accepted.terminate).toBe(true);
		expect(evaluatorTools.acceptedReport).toEqual(validContinue);
		await expect(
			evaluatorTools.submitTool.execute("submit-2", validContinue, undefined, undefined, undefined as never),
		).rejects.toThrow("already been accepted");
	});

	it("counts semantic submit errors against the single correction opportunity", async () => {
		const snapshot = await fixture();
		const evaluatorTools = createGoalEvaluatorTools({ snapshot, supportsImages: true });
		await expect(
			evaluatorTools.submitTool.execute(
				"submit-invalid-1",
				{ ...validContinue, progress: "   " },
				undefined,
				undefined,
				undefined as never,
			),
		).rejects.toMatchObject({ name: "GoalEvaluationFormatError", disposition: "correction" });
		await expect(
			evaluatorTools.submitTool.execute(
				"submit-invalid-2",
				{ ...validContinue, progress: "   " },
				undefined,
				undefined,
				undefined as never,
			),
		).rejects.toMatchObject({ name: "GoalEvaluationFormatError", disposition: "exhausted" });
		expect(evaluatorTools.formatGuard.formatFailures).toBe(2);
		expect(evaluatorTools.acceptedReport).toBeUndefined();
	});

	it("validates raw arguments before Pi schema validation and returns a precise correction error", async () => {
		const snapshot = await fixture();
		const evaluatorTools = createGoalEvaluatorTools({ snapshot, supportsImages: true });
		expect(() => evaluatorTools.submitTool.prepareArguments?.({ ...validContinue, progress: "   " })).toThrow(
			"progress must be non-blank and at most 4000 characters.",
		);
		expect(evaluatorTools.formatGuard.formatFailures).toBe(1);
		expect(evaluatorTools.acceptedReport).toBeUndefined();
	});

	it("allows exactly one format-correction opportunity", () => {
		const guard = new GoalEvaluationFormatGuard();
		expect(guard.recordFormatFailure()).toBe("correction");
		expect(guard.accept(validContinue)).toMatchObject({ ok: true });
		expect(guard.recordFormatFailure()).toBe("accepted");

		const exhaustedGuard = new GoalEvaluationFormatGuard();
		expect(exhaustedGuard.recordFormatFailure()).toBe("correction");
		expect(exhaustedGuard.recordFormatFailure()).toBe("exhausted");
		expect(exhaustedGuard.recordFormatFailure()).toBe("exhausted");
		expect(exhaustedGuard.formatFailures).toBe(2);
		expect(exhaustedGuard.accept(validContinue)).toMatchObject({ ok: false });
	});
});
