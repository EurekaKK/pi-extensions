import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResultSpoolMetadata } from "../sidecar/protocol.js";
import {
	cleanupOrphanSpools,
	createSessionSpoolDirectory,
	readVerifiedResultSpool,
	removeSessionSpoolDirectory,
	SpoolIntegrityError,
	spoolBasenameForDelivery,
} from "../src/spool.js";

interface SpoolFixture {
	root: string;
	deliveryId: string;
	filePath: string;
	metadata: ResultSpoolMetadata;
	bytes: Buffer;
}

let roots: string[] = [];

beforeEach(() => {
	roots = [];
});

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(roots.map(async (root) => rm(root, { recursive: true, force: true })));
});

async function createFixture(deliveryId = "delivery-1", text = "verified report"): Promise<SpoolFixture> {
	const root = await createSessionSpoolDirectory();
	roots.push(root);
	const bytes = Buffer.from(text, "utf8");
	const basename = spoolBasenameForDelivery(deliveryId);
	const filePath = join(root, basename);
	await writeFile(filePath, bytes, { mode: 0o600 });
	await chmod(filePath, 0o600);
	return {
		root,
		deliveryId,
		filePath,
		bytes,
		metadata: {
			basename,
			byteSize: bytes.byteLength,
			digest: createHash("sha256").update(bytes).digest("hex"),
		},
	};
}

async function expectIntegrityFailure(
	fixture: SpoolFixture,
	metadata: ResultSpoolMetadata = fixture.metadata,
): Promise<void> {
	await expect(readVerifiedResultSpool(fixture.root, fixture.deliveryId, metadata)).rejects.toBeInstanceOf(
		SpoolIntegrityError,
	);
}

describe("private spool verification", () => {
	it("creates a 0700 root and accepts only a matching 0600 report", async () => {
		const fixture = await createFixture();
		expect((await lstat(fixture.root)).mode & 0o777).toBe(0o700);
		expect((await lstat(fixture.filePath)).mode & 0o777).toBe(0o600);

		const verified = await readVerifiedResultSpool(fixture.root, fixture.deliveryId, fixture.metadata);
		expect(verified.path).toBe(fixture.filePath);
		expect(verified.bytes).toEqual(fixture.bytes);
		expect(verified.digest).toBe(fixture.metadata.digest);
	});

	it("uses no-follow file opens and rejects a report symlink without reading its target", async () => {
		const fixture = await createFixture("delivery-link", "target bytes");
		const target = join(fixture.root, "target.txt");
		await rm(fixture.filePath);
		await writeFile(target, fixture.bytes, { mode: 0o600 });
		await chmod(target, 0o600);
		await symlink(target, fixture.filePath);

		await expect(readVerifiedResultSpool(fixture.root, fixture.deliveryId, fixture.metadata)).rejects.toMatchObject({
			code: "ELOOP",
		});
		expect(await readFile(target, "utf8")).toBe("target bytes");
	});

	it("rejects untrusted owner, root/file modes, size, and digest", async () => {
		const ownerFixture = await createFixture("delivery-owner");
		if (typeof process.getuid === "function") {
			const actualUid = process.getuid();
			const getuid = vi.spyOn(process, "getuid").mockReturnValue(actualUid + 1);
			await expectIntegrityFailure(ownerFixture);
			getuid.mockReturnValueOnce(actualUid).mockReturnValue(actualUid + 1);
			await expectIntegrityFailure(ownerFixture);
			getuid.mockRestore();
		}

		const rootModeFixture = await createFixture("delivery-root-mode");
		await chmod(rootModeFixture.root, 0o755);
		await expectIntegrityFailure(rootModeFixture);

		const fileModeFixture = await createFixture("delivery-file-mode");
		await chmod(fileModeFixture.filePath, 0o644);
		await expectIntegrityFailure(fileModeFixture);

		const sizeFixture = await createFixture("delivery-size");
		await expectIntegrityFailure(sizeFixture, {
			...sizeFixture.metadata,
			byteSize: sizeFixture.metadata.byteSize + 1,
		});

		const digestFixture = await createFixture("delivery-digest");
		await expectIntegrityFailure(digestFixture, {
			...digestFixture.metadata,
			digest: "0".repeat(64),
		});
	});

	it("accepts a macOS /var path whose trusted temporary ancestor canonicalizes through /private/var", async () => {
		const fixture = await createFixture("delivery-var-alias");
		const lexicalRoot = resolve(fixture.root);
		const canonicalRoot = await realpath(fixture.root);
		if (process.platform === "darwin" && lexicalRoot.startsWith("/var/")) {
			expect(canonicalRoot).toBe(`/private${lexicalRoot}`);
		}

		await expect(readVerifiedResultSpool(fixture.root, fixture.deliveryId, fixture.metadata)).resolves.toMatchObject({
			path: fixture.filePath,
			bytes: fixture.bytes,
		});
	});
});

describe("bounded cleanup", () => {
	it("removes only direct orphan files/symlinks and preserves retained files and nested directories", async () => {
		const root = await createSessionSpoolDirectory();
		roots.push(root);
		const retained = join(root, "retained.report");
		const orphan = join(root, "orphan.report");
		const link = join(root, "orphan-link.report");
		const nested = join(root, "nested");
		const nestedFile = join(nested, "do-not-descend.report");
		await writeFile(retained, "retained", { mode: 0o600 });
		await writeFile(orphan, "orphan", { mode: 0o600 });
		await symlink(retained, link);
		await mkdir(nested);
		await writeFile(nestedFile, "nested", { mode: 0o600 });

		await cleanupOrphanSpools(root, new Set(["retained.report"]));

		await expect(lstat(retained)).resolves.toBeDefined();
		await expect(lstat(orphan)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(lstat(link)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(lstat(nested)).resolves.toMatchObject({});
		expect(await readFile(nestedFile, "utf8")).toBe("nested");
	});

	it("removes an owned session subtree but refuses the temporary root itself", async () => {
		const root = await createSessionSpoolDirectory();
		roots.push(root);
		await writeFile(join(root, "orphan.report"), "orphan", { mode: 0o600 });

		await expect(removeSessionSpoolDirectory(resolve(tmpdir()))).rejects.toThrow(
			"Refusing to remove a spool directory outside the OS temporary directory.",
		);
		await removeSessionSpoolDirectory(root);
		await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("refuses a symlinked session root without deleting its target", async () => {
		const target = await createSessionSpoolDirectory();
		roots.push(target);
		const link = `${target}-link`;
		roots.push(link);
		await writeFile(join(target, "retained.report"), "retained", { mode: 0o600 });
		await symlink(target, link);

		await expect(removeSessionSpoolDirectory(link)).rejects.toThrow("Refusing to remove an untrusted spool directory.");
		expect(await readFile(join(target, "retained.report"), "utf8")).toBe("retained");
	});
});
