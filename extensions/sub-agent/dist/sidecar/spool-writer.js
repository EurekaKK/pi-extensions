import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
export const MAX_CHILD_REPORT_BYTES = 256 * 1024;
function isMissingFile(error) {
    return (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT");
}
function spoolBasename(deliveryId) {
    const candidate = `${deliveryId}.report`;
    if (deliveryId.length === 0 ||
        basename(candidate) !== candidate ||
        candidate.includes(sep) ||
        deliveryId === "." ||
        deliveryId === "..") {
        throw new Error("Invalid delivery id for result spool.");
    }
    return candidate;
}
async function trustedSpoolRoot(spoolDir) {
    const resolved = resolve(spoolDir);
    await realpath(resolved);
    const info = await lstat(resolved);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700) {
        throw new Error("Result spool directory failed its type or mode check.");
    }
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
        throw new Error("Result spool directory owner does not match the Worker user.");
    }
    return resolved;
}
async function syncDirectory(path) {
    const handle = await open(path, fsConstants.O_RDONLY);
    try {
        await handle.sync();
    }
    finally {
        await handle.close();
    }
}
export async function writeResultSpool(spoolDir, deliveryId, report) {
    const bytes = Buffer.from(report, "utf8");
    if (bytes.byteLength > MAX_CHILD_REPORT_BYTES) {
        throw new Error("Result report exceeds the Worker spool limit.");
    }
    const root = await trustedSpoolRoot(spoolDir);
    const finalBasename = spoolBasename(deliveryId);
    const finalPath = resolve(root, finalBasename);
    if (dirname(finalPath) !== root)
        throw new Error("Result spool path escapes its root.");
    const temporaryPath = resolve(root, `.${finalBasename}.${process.pid}.${randomUUID()}.tmp`);
    if (dirname(temporaryPath) !== root)
        throw new Error("Temporary result spool path escapes its root.");
    let handle;
    try {
        handle = await open(temporaryPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
        await handle.writeFile(bytes);
        await handle.sync();
        await handle.close();
        handle = undefined;
        await rename(temporaryPath, finalPath);
        await syncDirectory(root);
    }
    catch (error) {
        await handle?.close().catch(() => undefined);
        await unlink(temporaryPath).catch((unlinkError) => {
            if (!isMissingFile(unlinkError))
                throw unlinkError;
        });
        throw error;
    }
    return {
        basename: finalBasename,
        byteSize: bytes.byteLength,
        digest: createHash("sha256").update(bytes).digest("hex"),
    };
}
export async function removeResultSpoolFile(spoolDir, deliveryId) {
    const root = await trustedSpoolRoot(spoolDir);
    const candidate = resolve(root, spoolBasename(deliveryId));
    if (dirname(candidate) !== root)
        return;
    try {
        await unlink(candidate);
        await syncDirectory(root);
    }
    catch (error) {
        if (!isMissingFile(error))
            throw error;
    }
}
