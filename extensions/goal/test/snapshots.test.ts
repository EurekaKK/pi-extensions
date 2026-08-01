import { createHash, randomUUID } from "node:crypto";
import { access, lstat, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
	cleanupGoalSnapshot,
	cleanupStaleGoalSnapshots,
	createGoalEvaluationSnapshot,
	createGoalMainRunSnapshot,
	type GoalEvaluationSnapshotBundle,
	type GoalMainRunSnapshotBundle,
	resolveSnapshotEntry,
	validateSnapshotRelativePath,
} from "../src/snapshots.js";

const bundles: Array<GoalEvaluationSnapshotBundle | GoalMainRunSnapshotBundle> = [];
const extraPaths: string[] = [];

afterEach(async () => {
	await Promise.allSettled(bundles.splice(0).map(async (bundle) => await bundle.cleanup()));
	await Promise.allSettled(extraPaths.splice(0).map(async (path) => await rm(path, { recursive: true, force: true })));
});

function userMessage(
	content: string | Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>,
) {
	return { role: "user" as const, content, timestamp: Date.now() };
}

function capabilities() {
	return {
		activeTools: [
			{
				name: "read",
				description: "Read project files",
				parameters: { type: "object", properties: { path: { type: "string" } } },
				promptGuidelines: ["Read before editing."],
				sourceInfo: { source: "builtin" },
			},
		],
		mode: "tui",
		cwd: "/project",
		projectTrusted: "yes" as const,
		model: { provider: "fake", id: "fake-model" },
		thinkingLevel: "high",
	};
}

describe("goal snapshot bundles", () => {
	it("writes compaction-aware contexts, complete sorted history, capabilities, and extracted images", async () => {
		const manager = SessionManager.inMemory("/project");
		manager.appendMessage(userMessage("raw pre-compaction secret"));
		manager.appendMessage(userMessage("goal creation context"));
		const creationAnchor = manager.appendCustomMessageEntry("fixture.private", "visible custom content", false, {
			privateMetadata: "custom details must not leak",
		});
		manager.appendCompaction("Earlier work was summarized.", creationAnchor, 12_000);
		const imageBytes = Buffer.from("fake-png-bytes");
		const currentLeaf = manager.appendMessage(
			userMessage([
				{ type: "text", text: "CURRENT Needle evidence" },
				{ type: "image", data: imageBytes.toString("base64"), mimeType: "image/png" },
			]),
		);

		const bundle = await createGoalEvaluationSnapshot({
			ownerSessionId: `session-${randomUUID()}`,
			entries: manager.getEntries(),
			currentLeafId: currentLeaf,
			creationAnchorEntryId: creationAnchor,
			evaluationHistory: [
				{
					evaluationNumber: 2,
					decision: "continue",
					progress: "second",
					reason: "more remains",
					next_action: "verify",
					evidence: ["current-context.jsonl"],
					activeElapsedMs: 2000,
					mainRunId: "run-2",
					timestamp: "2026-08-01T00:00:02.000Z",
				},
				{
					evaluationNumber: 1,
					decision: "continue",
					progress: "first",
					reason: "work started",
					next_action: "continue",
					evidence: ["creation-context.jsonl"],
					activeElapsedMs: 1000,
					mainRunId: "run-1",
					timestamp: "2026-08-01T00:00:01.000Z",
				},
			],
			capabilities: capabilities(),
		});
		bundles.push(bundle);

		const current = await readFile(bundle.files.currentContext, "utf8");
		const creation = await readFile(bundle.files.creationContext, "utf8");
		expect(current).toContain("Earlier work was summarized.");
		expect(current).toContain("CURRENT Needle evidence");
		expect(current).not.toContain("raw pre-compaction secret");
		expect(creation).toContain("raw pre-compaction secret");
		expect(creation).toContain("goal creation context");
		expect(creation).toContain("visible custom content");
		expect(creation).not.toContain("custom details must not leak");
		expect(creation).not.toContain("fixture.private");
		expect(current).not.toContain(imageBytes.toString("base64"));
		expect(current).toContain('"type":"image_reference"');

		const history = (await readFile(bundle.files.evaluationHistory, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { evaluationNumber: number; next_action: string | null });
		expect(history.map((record) => record.evaluationNumber)).toEqual([1, 2]);
		expect(history[1]?.next_action).toBe("verify");

		const projectedCapabilities = JSON.parse(await readFile(bundle.files.capabilities, "utf8")) as {
			activeTools: Array<{ name: string; parameters: unknown }>;
			model: { provider: string; id: string };
		};
		expect(projectedCapabilities.activeTools).toHaveLength(1);
		expect(projectedCapabilities.activeTools[0]?.name).toBe("read");
		expect(projectedCapabilities.model).toEqual({ provider: "fake", id: "fake-model" });

		expect(bundle.images).toHaveLength(1);
		const image = bundle.images[0];
		expect(image).toBeDefined();
		if (image === undefined) throw new Error("Expected extracted image.");
		expect(await readFile(image.absolutePath)).toEqual(imageBytes);
		const manifest = await readFile(bundle.files.imageManifest, "utf8");
		expect(manifest).toContain(image.id);
		expect(manifest).not.toContain(image.absolutePath);
	});

	it("creates roots and files with restrictive permissions and an irreversible owner prefix", async () => {
		const manager = SessionManager.inMemory("/project");
		const anchor = manager.appendMessage(userMessage("context"));
		const ownerSessionId = `private-owner-${randomUUID()}`;
		const bundle = await createGoalMainRunSnapshot({
			ownerSessionId,
			entries: manager.getEntries(),
			creationAnchorEntryId: anchor,
		});
		bundles.push(bundle);

		expect(await realpath(dirname(bundle.root))).toBe(await realpath(tmpdir()));
		expect(basename(bundle.root)).toMatch(/^pi-goal-[a-f0-9]{16}-[A-Za-z0-9]{6,}$/u);
		expect(basename(bundle.root)).not.toContain(ownerSessionId);
		expect((await lstat(bundle.root)).mode & 0o777).toBe(0o700);
		expect((await lstat(join(bundle.root, "images"))).mode & 0o777).toBe(0o700);
		for (const file of [bundle.files.readme, bundle.files.creationContext, bundle.files.imageManifest]) {
			expect((await lstat(file)).mode & 0o777).toBe(0o600);
		}
	});

	it("rejects missing anchors instead of falling back to the latest raw entry", async () => {
		const manager = SessionManager.inMemory("/project");
		manager.appendMessage(userMessage("must not be selected by fallback"));
		await expect(
			createGoalEvaluationSnapshot({
				ownerSessionId: `session-${randomUUID()}`,
				entries: manager.getEntries(),
				currentLeafId: "missing-leaf",
				creationAnchorEntryId: null,
				evaluationHistory: [],
				capabilities: capabilities(),
			}),
		).rejects.toThrow("Current leaf entry does not exist");
	});

	it("validates relative paths and refuses symlink escapes", async () => {
		const manager = SessionManager.inMemory("/project");
		const anchor = manager.appendMessage(userMessage("context"));
		const bundle = await createGoalEvaluationSnapshot({
			ownerSessionId: `session-${randomUUID()}`,
			entries: manager.getEntries(),
			currentLeafId: anchor,
			creationAnchorEntryId: anchor,
			evaluationHistory: [],
			capabilities: capabilities(),
		});
		bundles.push(bundle);

		expect(() => validateSnapshotRelativePath("../outside")).toThrow("traversal");
		expect(() => validateSnapshotRelativePath("/absolute")).toThrow("relative");
		expect(() => validateSnapshotRelativePath("C:\\outside")).toThrow("relative");
		const symlinkPath = join(bundle.root, "escape.txt");
		await symlink("/etc/hosts", symlinkPath);
		await expect(resolveSnapshotEntry(bundle.root, "escape.txt", "file")).rejects.toThrow("symbolic link");
	});

	it("cleans only a matching direct temporary directory and is idempotent", async () => {
		const manager = SessionManager.inMemory("/project");
		const anchor = manager.appendMessage(userMessage("context"));
		const ownerSessionId = `session-${randomUUID()}`;
		const bundle = await createGoalMainRunSnapshot({
			ownerSessionId,
			entries: manager.getEntries(),
			creationAnchorEntryId: anchor,
		});

		expect(await cleanupGoalSnapshot(bundle.root, "wrong-owner")).toBe(false);
		await expect(access(bundle.root)).resolves.toBeUndefined();
		expect(await cleanupGoalSnapshot(bundle.root, ownerSessionId)).toBe(true);
		expect(await cleanupGoalSnapshot(bundle.root, ownerSessionId)).toBe(false);
	});

	it("best-effort stale cleanup removes only snapshots for the requested session", async () => {
		const manager = SessionManager.inMemory("/project");
		const anchor = manager.appendMessage(userMessage("context"));
		const ownerSessionId = `session-${randomUUID()}`;
		const first = await createGoalMainRunSnapshot({
			ownerSessionId,
			entries: manager.getEntries(),
			creationAnchorEntryId: anchor,
		});
		const second = await createGoalMainRunSnapshot({
			ownerSessionId,
			entries: manager.getEntries(),
			creationAnchorEntryId: anchor,
		});

		expect(await cleanupStaleGoalSnapshots(ownerSessionId)).toBe(2);
		await expect(access(first.root)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(access(second.root)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("will not remove a matching symlink or its target", async () => {
		const ownerSessionId = `session-${randomUUID()}`;
		const hash = createHash("sha256").update(ownerSessionId).digest("hex").slice(0, 16);
		const target = join(tmpdir(), `goal-cleanup-target-${randomUUID()}`);
		const link = join(tmpdir(), `pi-goal-${hash}-ABC123`);
		extraPaths.push(link, target);
		await rm(target, { recursive: true, force: true });
		await rm(link, { recursive: true, force: true });
		const manager = SessionManager.inMemory(target);
		const anchor = manager.appendMessage(userMessage("target remains"));
		const targetBundle = await createGoalMainRunSnapshot({
			ownerSessionId: `different-${randomUUID()}`,
			entries: manager.getEntries(),
			creationAnchorEntryId: anchor,
		});
		bundles.push(targetBundle);
		await symlink(targetBundle.root, link);

		expect(await cleanupGoalSnapshot(link, ownerSessionId)).toBe(false);
		await expect(access(targetBundle.root)).resolves.toBeUndefined();
	});
});
