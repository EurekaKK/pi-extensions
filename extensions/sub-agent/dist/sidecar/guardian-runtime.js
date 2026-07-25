import { spawn } from "node:child_process";
import { lstat, realpath, rm, stat } from "node:fs/promises";
import { Socket } from "node:net";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isControlMessageWithinLimit, isPlainRecord, matchesProtocolIdentity, SUBAGENT_PROTOCOL_VERSION, } from "./protocol.js";
const LEASE_FD = 4;
const SESSION_SHUTDOWN_BUDGET_MS = 4_000;
const COOPERATIVE_PHASE_MS = 2_000;
const TERM_PHASE_MS = 1_000;
const KILL_PHASE_MS = 1_000;
const LOSS_TERM_GRACE_MS = 1_000;
const LOSS_KILL_GRACE_MS = 1_000;
const WORKER_EXIT_OBSERVATION_MS = 100;
const GROUP_POLL_INTERVAL_MS = 20;
const TEST_MODE_ENV = "PI_SUBAGENT_GUARDIAN_TEST_MODE";
const TEST_ROOT_ENV = "PI_SUBAGENT_GUARDIAN_TEST_ROOT";
const TEST_WORKER_ENV = "PI_SUBAGENT_GUARDIAN_TEST_WORKER_PATH";
const TEST_TOKEN_ENV = "PI_SUBAGENT_GUARDIAN_TEST_TOKEN";
const TEST_TOKEN_SETTING = "__guardianFixtureToken";
const TEST_WORKER_BASENAME = "guardian-worker.mjs";
function hasExactKeys(value, required, optional = []) {
    const allowed = new Set([...required, ...optional]);
    if (Object.keys(value).some((key) => !allowed.has(key)))
        return false;
    return required.every((key) => Object.hasOwn(value, key));
}
function isNonEmptyString(value) {
    return typeof value === "string" && value.length > 0;
}
function isString(value) {
    return typeof value === "string";
}
function isSafeNonNegativeInteger(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isSafePositiveInteger(value) {
    return isSafeNonNegativeInteger(value) && value > 0;
}
function isStringArray(value) {
    return Array.isArray(value) && value.every(isNonEmptyString);
}
function isJsonValue(value) {
    if (value === null || typeof value === "boolean" || typeof value === "string")
        return true;
    if (typeof value === "number")
        return Number.isFinite(value);
    if (Array.isArray(value))
        return value.every(isJsonValue);
    if (!isPlainRecord(value))
        return false;
    return Object.values(value).every(isJsonValue);
}
function hasEnvelope(value) {
    return (value.protocolVersion === SUBAGENT_PROTOCOL_VERSION &&
        isNonEmptyString(value.sessionNonce) &&
        isNonEmptyString(value.managerEpoch) &&
        isSafeNonNegativeInteger(value.workerGeneration));
}
function isModelSelection(value) {
    return (isPlainRecord(value) &&
        hasExactKeys(value, ["provider", "id"]) &&
        isNonEmptyString(value.provider) &&
        isNonEmptyString(value.id));
}
function isProjectContext(value) {
    return (Array.isArray(value) &&
        value.every((entry) => isPlainRecord(entry) &&
            hasExactKeys(entry, ["path", "content"]) &&
            isNonEmptyString(entry.path) &&
            isString(entry.content)));
}
function isParentToolSources(value) {
    return (Array.isArray(value) &&
        value.every((entry) => isPlainRecord(entry) &&
            hasExactKeys(entry, ["name"], ["path"]) &&
            isNonEmptyString(entry.name) &&
            (!Object.hasOwn(entry, "path") || isNonEmptyString(entry.path))));
}
function isBootstrapFrameStrict(value) {
    return (isPlainRecord(value) &&
        hasExactKeys(value, [
            "protocolVersion",
            "sessionNonce",
            "managerEpoch",
            "workerGeneration",
            "type",
            "parentPid",
            "cwd",
            "agentDir",
            "piPackageDir",
            "spoolDir",
            "selfExtensionPath",
            "settingsSnapshot",
            "projectTrusted",
        ]) &&
        hasEnvelope(value) &&
        value.type === "BOOTSTRAP" &&
        isSafePositiveInteger(value.parentPid) &&
        isNonEmptyString(value.cwd) &&
        isNonEmptyString(value.agentDir) &&
        isNonEmptyString(value.piPackageDir) &&
        isNonEmptyString(value.spoolDir) &&
        isNonEmptyString(value.selfExtensionPath) &&
        isPlainRecord(value.settingsSnapshot) &&
        isJsonValue(value.settingsSnapshot) &&
        typeof value.projectTrusted === "boolean");
}
function isSpawnFrameStrict(value) {
    return (hasExactKeys(value, [
        "protocolVersion",
        "sessionNonce",
        "managerEpoch",
        "workerGeneration",
        "type",
        "opId",
        "agentId",
        "runId",
        "deliveryId",
        "task",
        "model",
        "thinkingLevel",
        "projectContext",
        "candidateExtensionPaths",
        "requiredExtensionPaths",
        "parentToolNames",
        "parentToolSources",
        "parentActiveToolNames",
    ], ["explicitTools"]) &&
        value.type === "SPAWN" &&
        isNonEmptyString(value.opId) &&
        isNonEmptyString(value.agentId) &&
        isNonEmptyString(value.runId) &&
        isNonEmptyString(value.deliveryId) &&
        isString(value.task) &&
        isModelSelection(value.model) &&
        isThinkingLevel(value.thinkingLevel) &&
        isProjectContext(value.projectContext) &&
        isStringArray(value.candidateExtensionPaths) &&
        isStringArray(value.requiredExtensionPaths) &&
        isStringArray(value.parentToolNames) &&
        isParentToolSources(value.parentToolSources) &&
        isStringArray(value.parentActiveToolNames) &&
        (!Object.hasOwn(value, "explicitTools") || isStringArray(value.explicitTools)));
}
function isSendFrameStrict(value) {
    return (hasExactKeys(value, [
        "protocolVersion",
        "sessionNonce",
        "managerEpoch",
        "workerGeneration",
        "type",
        "opId",
        "agentId",
        "runId",
        "deliveryId",
        "message",
    ]) &&
        value.type === "SEND" &&
        isNonEmptyString(value.opId) &&
        isNonEmptyString(value.agentId) &&
        isNonEmptyString(value.runId) &&
        isNonEmptyString(value.deliveryId) &&
        isString(value.message));
}
function isCancelFrameStrict(value) {
    return (hasExactKeys(value, [
        "protocolVersion",
        "sessionNonce",
        "managerEpoch",
        "workerGeneration",
        "type",
        "opId",
        "agentId",
        "runId",
        "reason",
    ]) &&
        value.type === "CANCEL" &&
        isNonEmptyString(value.opId) &&
        isNonEmptyString(value.agentId) &&
        isNonEmptyString(value.runId) &&
        isString(value.reason));
}
function isKillFrameStrict(value) {
    return (hasExactKeys(value, [
        "protocolVersion",
        "sessionNonce",
        "managerEpoch",
        "workerGeneration",
        "type",
        "opId",
        "agentId",
        "lastRunId",
    ]) &&
        value.type === "KILL" &&
        isNonEmptyString(value.opId) &&
        isNonEmptyString(value.agentId) &&
        isNonEmptyString(value.lastRunId));
}
function isMailboxCommitAckFrameStrict(value) {
    return (hasExactKeys(value, [
        "protocolVersion",
        "sessionNonce",
        "managerEpoch",
        "workerGeneration",
        "type",
        "terminalOpId",
        "agentId",
        "runId",
        "deliveryId",
    ]) &&
        value.type === "MAILBOX_COMMIT_ACK" &&
        isNonEmptyString(value.terminalOpId) &&
        isNonEmptyString(value.agentId) &&
        isNonEmptyString(value.runId) &&
        isNonEmptyString(value.deliveryId));
}
function isShutdownFrameStrict(value) {
    return (hasExactKeys(value, [
        "protocolVersion",
        "sessionNonce",
        "managerEpoch",
        "workerGeneration",
        "type",
        "deadlineAt",
    ]) &&
        value.type === "SHUTDOWN" &&
        isSafeNonNegativeInteger(value.deadlineAt));
}
export function isStrictParentFrame(value) {
    if (!isPlainRecord(value) || !hasEnvelope(value) || !isControlMessageWithinLimit(value))
        return false;
    switch (value.type) {
        case "BOOTSTRAP":
            return isBootstrapFrameStrict(value);
        case "SPAWN":
            return isSpawnFrameStrict(value);
        case "SEND":
            return isSendFrameStrict(value);
        case "CANCEL":
            return isCancelFrameStrict(value);
        case "KILL":
            return isKillFrameStrict(value);
        case "MAILBOX_COMMIT_ACK":
            return isMailboxCommitAckFrameStrict(value);
        case "SHUTDOWN":
            return isShutdownFrameStrict(value);
        default:
            return false;
    }
}
function isThinkingLevel(value) {
    return (value === "off" ||
        value === "minimal" ||
        value === "low" ||
        value === "medium" ||
        value === "high" ||
        value === "xhigh" ||
        value === "max");
}
function isDegradedExtension(value) {
    return (isPlainRecord(value) &&
        hasExactKeys(value, ["path", "code"]) &&
        isNonEmptyString(value.path) &&
        (value.code === "factory_failed" ||
            value.code === "loader_failed" ||
            value.code === "provider_registration_failed" ||
            value.code === "session_start_failed" ||
            value.code === "resources_discover_failed" ||
            value.code === "run_admission_gate_failed"));
}
function isUnavailableTool(value) {
    return (isPlainRecord(value) &&
        hasExactKeys(value, ["name", "reason"]) &&
        isNonEmptyString(value.name) &&
        (value.reason === "unlocatable" || value.reason === "extension_failed" || value.reason === "not_registered"));
}
function isWorkerReadyFrame(value) {
    return (hasExactKeys(value, [
        "protocolVersion",
        "sessionNonce",
        "managerEpoch",
        "workerGeneration",
        "type",
        "workerPid",
        "workerPgid",
        "piVersion",
    ]) &&
        value.type === "WORKER_READY" &&
        isSafePositiveInteger(value.workerPid) &&
        isSafePositiveInteger(value.workerPgid) &&
        isNonEmptyString(value.piVersion));
}
function isRunAcceptedFrame(value) {
    return (hasExactKeys(value, [
        "protocolVersion",
        "sessionNonce",
        "managerEpoch",
        "workerGeneration",
        "type",
        "opId",
        "operation",
        "agentId",
        "runId",
        "model",
        "thinkingLevel",
        "activeToolCount",
        "capabilityToolCount",
        "degradedExtensions",
        "unavailableTools",
    ]) &&
        value.type === "RUN_ACCEPTED" &&
        isNonEmptyString(value.opId) &&
        (value.operation === "spawn" || value.operation === "send") &&
        isNonEmptyString(value.agentId) &&
        isNonEmptyString(value.runId) &&
        isModelSelection(value.model) &&
        isThinkingLevel(value.thinkingLevel) &&
        isSafeNonNegativeInteger(value.activeToolCount) &&
        isSafeNonNegativeInteger(value.capabilityToolCount) &&
        Array.isArray(value.degradedExtensions) &&
        value.degradedExtensions.every(isDegradedExtension) &&
        Array.isArray(value.unavailableTools) &&
        value.unavailableTools.every(isUnavailableTool));
}
const OPERATION_ERROR_CODES = new Set([
    "SUBAGENT_INPUT_HANDLED",
    "SUBAGENT_RUN_START_FAILED",
    "SUBAGENT_REQUIRED_EXTENSION_FAILED",
    "SUBAGENT_EXPLICIT_TOOL_MISSING",
    "SUBAGENT_TOOL_FORBIDDEN",
    "SUBAGENT_EXTENSION_REHYDRATION_UNSTABLE",
    "SUBAGENT_MODEL_NOT_FOUND",
    "SUBAGENT_MODEL_AUTH_REQUIRED",
    "SUBAGENT_THINKING_UNSUPPORTED",
    "SUBAGENT_PI_API_UNSUPPORTED",
    "SUBAGENT_PROTOCOL_MISMATCH",
    "SUBAGENT_AGENT_NOT_FOUND",
    "SUBAGENT_AGENT_TERMINATING",
    "SUBAGENT_AGENT_LOST",
    "SUBAGENT_BUSY",
    "SUBAGENT_RUN_ALREADY_TERMINAL",
    "SUBAGENT_CANCEL_STALE",
    "SUBAGENT_CANCEL_ALREADY_REQUESTED",
    "SUBAGENT_KILL_BLOCKED",
    "SUBAGENT_KILL_STALE",
    "SUBAGENT_IPC_LOST",
]);
function isOperationNackFrame(value) {
    return (hasExactKeys(value, [
        "protocolVersion",
        "sessionNonce",
        "managerEpoch",
        "workerGeneration",
        "type",
        "opId",
        "operation",
        "code",
        "message",
    ], ["agentId", "runId", "currentRunId", "lastRunId"]) &&
        value.type === "OP_NACK" &&
        isNonEmptyString(value.opId) &&
        (value.operation === "spawn" ||
            value.operation === "send" ||
            value.operation === "cancel" ||
            value.operation === "kill") &&
        isNonEmptyString(value.code) &&
        OPERATION_ERROR_CODES.has(value.code) &&
        isString(value.message) &&
        (!Object.hasOwn(value, "agentId") || isNonEmptyString(value.agentId)) &&
        (!Object.hasOwn(value, "runId") || isNonEmptyString(value.runId)) &&
        (!Object.hasOwn(value, "currentRunId") || isNonEmptyString(value.currentRunId)) &&
        (!Object.hasOwn(value, "lastRunId") || isNonEmptyString(value.lastRunId)));
}
function isCancelAcceptedFrame(value) {
    return (hasExactKeys(value, [
        "protocolVersion",
        "sessionNonce",
        "managerEpoch",
        "workerGeneration",
        "type",
        "opId",
        "agentId",
        "runId",
    ]) &&
        value.type === "CANCEL_ACCEPTED" &&
        isNonEmptyString(value.opId) &&
        isNonEmptyString(value.agentId) &&
        isNonEmptyString(value.runId));
}
function isKillAcceptedFrame(value) {
    return (hasExactKeys(value, [
        "protocolVersion",
        "sessionNonce",
        "managerEpoch",
        "workerGeneration",
        "type",
        "opId",
        "agentId",
        "lastRunId",
    ]) &&
        value.type === "KILL_ACCEPTED" &&
        isNonEmptyString(value.opId) &&
        isNonEmptyString(value.agentId) &&
        isNonEmptyString(value.lastRunId));
}
function isKillSettledFrame(value) {
    return isKillAcceptedFrame({ ...value, type: "KILL_ACCEPTED" }) && value.type === "KILL_SETTLED";
}
function isResultSpoolMetadata(value) {
    return (isPlainRecord(value) &&
        hasExactKeys(value, ["basename", "byteSize", "digest"]) &&
        isNonEmptyString(value.basename) &&
        basename(value.basename) === value.basename &&
        isSafeNonNegativeInteger(value.byteSize) &&
        isNonEmptyString(value.digest));
}
const RUN_FAILURE_CODES = new Set([
    "SUBAGENT_MODEL_RUN_FAILED",
    "SUBAGENT_RUN_ABORTED",
    "SUBAGENT_OUTPUT_TRUNCATED",
    "SUBAGENT_INCOMPLETE_TOOL_TURN",
    "SUBAGENT_EMPTY_RESULT",
    "SUBAGENT_OUTPUT_TOO_LARGE",
    "SUBAGENT_DELIVERY_STORAGE_FAILED",
    "SUBAGENT_DELIVERY_INTEGRITY_FAILED",
    "SUBAGENT_COMPACTION_FAILED",
]);
function hasRunTerminalBase(value) {
    return (value.type === "RUN_TERMINAL" &&
        isNonEmptyString(value.terminalOpId) &&
        isNonEmptyString(value.agentId) &&
        isNonEmptyString(value.runId) &&
        isNonEmptyString(value.deliveryId) &&
        isSafeNonNegativeInteger(value.completedAt));
}
function isRunTerminalFrame(value) {
    const baseKeys = [
        "protocolVersion",
        "sessionNonce",
        "managerEpoch",
        "workerGeneration",
        "type",
        "terminalOpId",
        "agentId",
        "runId",
        "deliveryId",
        "completedAt",
        "outcome",
    ];
    if (!hasRunTerminalBase(value))
        return false;
    if (value.outcome === "RESULT") {
        return hasExactKeys(value, [...baseKeys, "spool"]) && isResultSpoolMetadata(value.spool);
    }
    if (value.outcome === "FAILED") {
        return (hasExactKeys(value, [...baseKeys, "failureCode"]) &&
            isNonEmptyString(value.failureCode) &&
            RUN_FAILURE_CODES.has(value.failureCode));
    }
    return (value.outcome === "CANCELLED" && hasExactKeys(value, [...baseKeys, "cancelReason"]) && isString(value.cancelReason));
}
function isRunSettledFrame(value) {
    return (hasExactKeys(value, [
        "protocolVersion",
        "sessionNonce",
        "managerEpoch",
        "workerGeneration",
        "type",
        "terminalOpId",
        "agentId",
        "runId",
        "deliveryId",
    ]) &&
        value.type === "RUN_SETTLED" &&
        isNonEmptyString(value.terminalOpId) &&
        isNonEmptyString(value.agentId) &&
        isNonEmptyString(value.runId) &&
        isNonEmptyString(value.deliveryId));
}
function isAgentToolStateFrame(value) {
    return (hasExactKeys(value, [
        "protocolVersion",
        "sessionNonce",
        "managerEpoch",
        "workerGeneration",
        "type",
        "agentId",
        "activeToolCount",
        "capabilityToolCount",
    ]) &&
        value.type === "AGENT_TOOL_STATE" &&
        isNonEmptyString(value.agentId) &&
        isSafeNonNegativeInteger(value.activeToolCount) &&
        isSafeNonNegativeInteger(value.capabilityToolCount));
}
function isWorkerWarningFrame(value) {
    return (hasExactKeys(value, ["protocolVersion", "sessionNonce", "managerEpoch", "workerGeneration", "type", "code"], ["agentId", "runId"]) &&
        value.type === "WORKER_WARNING" &&
        isNonEmptyString(value.code) &&
        (!Object.hasOwn(value, "agentId") || isNonEmptyString(value.agentId)) &&
        (!Object.hasOwn(value, "runId") || isNonEmptyString(value.runId)));
}
function isWorkerProtocolErrorFrame(value) {
    return (hasExactKeys(value, ["protocolVersion", "sessionNonce", "managerEpoch", "workerGeneration", "type", "code"]) &&
        value.type === "PROTOCOL_ERROR" &&
        (value.code === "SUBAGENT_PROTOCOL_MISMATCH" || value.code === "SUBAGENT_PI_API_UNSUPPORTED"));
}
export function isStrictWorkerFrame(value) {
    if (!isPlainRecord(value) || !hasEnvelope(value) || !isControlMessageWithinLimit(value))
        return false;
    switch (value.type) {
        case "WORKER_READY":
            return isWorkerReadyFrame(value);
        case "RUN_ACCEPTED":
            return isRunAcceptedFrame(value);
        case "OP_NACK":
            return isOperationNackFrame(value);
        case "CANCEL_ACCEPTED":
            return isCancelAcceptedFrame(value);
        case "KILL_ACCEPTED":
            return isKillAcceptedFrame(value);
        case "KILL_SETTLED":
            return isKillSettledFrame(value);
        case "RUN_TERMINAL":
            return isRunTerminalFrame(value);
        case "RUN_SETTLED":
            return isRunSettledFrame(value);
        case "AGENT_TOOL_STATE":
            return isAgentToolStateFrame(value);
        case "WORKER_WARNING":
            return isWorkerWarningFrame(value);
        case "PROTOCOL_ERROR":
            return isWorkerProtocolErrorFrame(value);
        default:
            return false;
    }
}
function isNoSuchProcess(error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
}
function isPermissionDenied(error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
}
function isMissingPath(error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
function processGroupExists(pgid) {
    try {
        process.kill(-pgid, 0);
        return true;
    }
    catch (error) {
        if (isNoSuchProcess(error))
            return false;
        if (isPermissionDenied(error))
            return true;
        throw error;
    }
}
function signalProcessGroup(pgid, signal) {
    try {
        process.kill(-pgid, signal);
    }
    catch (error) {
        if (!isNoSuchProcess(error))
            throw error;
    }
}
async function delay(milliseconds) {
    await new Promise((resolveDelay) => {
        setTimeout(resolveDelay, milliseconds);
    });
}
async function waitForProcessGroupExit(pgid, deadlineAt) {
    while (processGroupExists(pgid)) {
        const remaining = deadlineAt - Date.now();
        if (remaining <= 0)
            return false;
        await delay(Math.min(GROUP_POLL_INTERVAL_MS, remaining));
    }
    return true;
}
function frameIdentity(frame) {
    return {
        sessionNonce: frame.sessionNonce,
        managerEpoch: frame.managerEpoch,
        workerGeneration: frame.workerGeneration,
    };
}
function envelope(identity) {
    return {
        protocolVersion: SUBAGENT_PROTOCOL_VERSION,
        ...identity,
    };
}
async function sendOverParentIpc(frame) {
    if (!process.send || !process.connected)
        throw new Error("Parent IPC is unavailable.");
    if (!isControlMessageWithinLimit(frame))
        throw new Error("Guardian frame exceeds the control-message limit.");
    await new Promise((resolveSend, rejectSend) => {
        process.send?.(frame, (error) => {
            if (error)
                rejectSend(error);
            else
                resolveSend();
        });
    });
}
async function sendOverWorkerIpc(worker, frame) {
    if (!worker.send || !worker.connected)
        throw new Error("Worker IPC is unavailable.");
    if (!isControlMessageWithinLimit(frame))
        throw new Error("Worker frame exceeds the control-message limit.");
    await new Promise((resolveSend, rejectSend) => {
        worker.send?.(frame, (error) => {
            if (error)
                rejectSend(error);
            else
                resolveSend();
        });
    });
}
async function requireDirectory(path) {
    if (!isAbsolute(path))
        throw new Error("Expected an absolute directory path.");
    const metadata = await stat(path);
    if (!metadata.isDirectory())
        throw new Error("Expected a directory.");
}
async function requireRegularFile(path) {
    if (!isAbsolute(path))
        throw new Error("Expected an absolute file path.");
    const metadata = await stat(path);
    if (!metadata.isFile())
        throw new Error("Expected a regular file.");
}
async function captureSpoolIdentity(path) {
    if (!isAbsolute(path))
        throw new Error("Spool path must be absolute.");
    const canonical = await realpath(path);
    if (canonical !== resolve(path))
        throw new Error("Spool path must not contain symlinks.");
    const metadata = await lstat(canonical);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
        throw new Error("Spool path must be a real directory.");
    if ((metadata.mode & 0o777) !== 0o700)
        throw new Error("Spool directory mode must be 0700.");
    if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
        throw new Error("Spool directory owner does not match the Guardian user.");
    }
    return { path: canonical, device: metadata.dev, inode: metadata.ino };
}
async function removeCapturedSpool(identity) {
    let metadata;
    try {
        metadata = await lstat(identity.path);
    }
    catch (error) {
        if (isMissingPath(error))
            return;
        throw error;
    }
    if (!metadata.isDirectory() ||
        metadata.isSymbolicLink() ||
        metadata.dev !== identity.device ||
        metadata.ino !== identity.inode) {
        throw new Error("Refusing to remove a replaced spool directory.");
    }
    await rm(identity.path, { recursive: true, force: true });
}
async function resolveWorkerPath(bootstrap) {
    const defaultPath = fileURLToPath(new URL("./worker.js", import.meta.url));
    if (process.env[TEST_MODE_ENV] !== "1") {
        await requireRegularFile(defaultPath);
        return await realpath(defaultPath);
    }
    const configuredRoot = process.env[TEST_ROOT_ENV];
    const configuredPath = process.env[TEST_WORKER_ENV];
    const configuredToken = process.env[TEST_TOKEN_ENV];
    const snapshotToken = bootstrap.settingsSnapshot[TEST_TOKEN_SETTING];
    if (!isNonEmptyString(configuredRoot) ||
        !isNonEmptyString(configuredPath) ||
        !isNonEmptyString(configuredToken) ||
        configuredToken.length < 32 ||
        snapshotToken !== configuredToken) {
        throw new Error("Invalid Guardian test-worker authorization.");
    }
    if (!isAbsolute(configuredRoot) || !isAbsolute(configuredPath)) {
        throw new Error("Guardian test-worker paths must be absolute.");
    }
    const canonicalRoot = await realpath(configuredRoot);
    const rootMetadata = await lstat(canonicalRoot);
    if (!rootMetadata.isDirectory() ||
        rootMetadata.isSymbolicLink() ||
        (rootMetadata.mode & 0o777) !== 0o700 ||
        (typeof process.getuid === "function" && rootMetadata.uid !== process.getuid())) {
        throw new Error("Guardian test-worker root failed validation.");
    }
    const canonicalPath = await realpath(configuredPath);
    const relativePath = relative(canonicalRoot, canonicalPath);
    if (relativePath.length === 0 ||
        relativePath.startsWith(`..${sep}`) ||
        relativePath === ".." ||
        isAbsolute(relativePath) ||
        basename(canonicalPath) !== TEST_WORKER_BASENAME) {
        throw new Error("Guardian test-worker path escapes its authorized root.");
    }
    const fileMetadata = await lstat(canonicalPath);
    if (!fileMetadata.isFile() ||
        fileMetadata.isSymbolicLink() ||
        (fileMetadata.mode & 0o777) !== 0o600 ||
        (typeof process.getuid === "function" && fileMetadata.uid !== process.getuid())) {
        throw new Error("Guardian test-worker file failed validation.");
    }
    return canonicalPath;
}
async function validateBootstrapPaths(bootstrap) {
    await Promise.all([
        requireDirectory(bootstrap.cwd),
        requireDirectory(bootstrap.agentDir),
        requireDirectory(bootstrap.piPackageDir),
        requireRegularFile(bootstrap.selfExtensionPath),
    ]);
    return await captureSpoolIdentity(bootstrap.spoolDir);
}
export class GuardianRuntime {
    phase = "BOOTSTRAP";
    identity;
    bootstrap;
    spoolIdentity;
    worker;
    workerIdentity;
    workerExitPromise;
    resolveWorkerExit;
    workerReady = false;
    workerExitSent = false;
    parentConnected = true;
    lease;
    parentInbound = Promise.resolve();
    workerInbound = Promise.resolve();
    parentOutbound = Promise.resolve();
    workerOutbound = Promise.resolve();
    cleanup;
    donePromise;
    resolveDone;
    constructor() {
        this.donePromise = new Promise((resolveDone) => {
            this.resolveDone = resolveDone;
        });
    }
    async run() {
        if (!process.send)
            throw new Error("Guardian requires an inherited Parent IPC channel.");
        this.attachLease();
        process.on("message", this.onParentMessage);
        process.once("disconnect", this.onParentDisconnect);
        return await this.donePromise;
    }
    attachLease() {
        this.lease = new Socket({ fd: LEASE_FD, readable: true, writable: false });
        this.lease.on("error", this.onLeaseClosed);
        this.lease.on("end", this.onLeaseClosed);
        this.lease.on("close", this.onLeaseClosed);
        this.lease.resume();
    }
    onLeaseClosed = () => {
        if (this.phase === "DONE")
            return;
        void this.startShutdown(Date.now() + SESSION_SHUTDOWN_BUDGET_MS);
    };
    onParentDisconnect = () => {
        this.parentConnected = false;
        if (this.phase === "DONE")
            return;
        void this.startShutdown(Date.now() + SESSION_SHUTDOWN_BUDGET_MS);
    };
    onParentMessage = (value) => {
        this.parentInbound = this.parentInbound
            .then(async () => {
            await this.handleParentMessage(value);
        })
            .catch(async () => {
            await this.handleParentProtocolFailure();
        });
    };
    async handleParentMessage(value) {
        if (this.phase === "DONE" || this.phase === "LOSS_CLEANUP" || this.phase === "SHUTDOWN")
            return;
        if (!isStrictParentFrame(value)) {
            throw new Error("Invalid Parent control frame.");
        }
        if (this.phase === "BOOTSTRAP" && !this.bootstrap) {
            if (value.type !== "BOOTSTRAP" || value.parentPid !== process.ppid) {
                throw new Error("The first Parent frame must be a valid BOOTSTRAP from the direct parent.");
            }
            await this.bootstrapWorker(value);
            return;
        }
        if (!this.identity || !matchesProtocolIdentity(value, this.identity) || value.type === "BOOTSTRAP") {
            throw new Error("Parent control identity mismatch.");
        }
        if (!this.workerReady || this.phase !== "RUNNING") {
            throw new Error("Parent mutation arrived before Worker readiness.");
        }
        if (value.type === "SHUTDOWN") {
            void this.startShutdown(value.deadlineAt);
            return;
        }
        await this.queueWorkerFrame(value);
    }
    async bootstrapWorker(frame) {
        this.identity = frameIdentity(frame);
        this.bootstrap = frame;
        this.spoolIdentity = await validateBootstrapPaths(frame);
        const workerPath = await resolveWorkerPath(frame);
        if (this.phase !== "BOOTSTRAP")
            return;
        const workerEnvironment = {
            ...process.env,
            PI_SUBAGENT_WORKER: "1",
            PI_SUBAGENT_DEPTH: "1",
        };
        delete workerEnvironment[TEST_ROOT_ENV];
        delete workerEnvironment[TEST_WORKER_ENV];
        delete workerEnvironment[TEST_TOKEN_ENV];
        delete workerEnvironment[TEST_MODE_ENV];
        const worker = spawn(process.execPath, [workerPath], {
            cwd: frame.cwd,
            detached: true,
            env: workerEnvironment,
            serialization: "advanced",
            stdio: ["ignore", "pipe", "pipe", "ipc"],
        });
        if (!isSafePositiveInteger(worker.pid)) {
            worker.kill("SIGKILL");
            throw new Error("Worker did not expose a valid PID.");
        }
        this.worker = worker;
        this.workerIdentity = { pid: worker.pid, pgid: worker.pid };
        this.workerExitPromise = new Promise((resolveWorkerExit) => {
            this.resolveWorkerExit = resolveWorkerExit;
        });
        worker.stdout?.resume();
        worker.stderr?.resume();
        worker.on("message", this.onWorkerMessage);
        worker.once("error", this.onWorkerError);
        worker.once("disconnect", this.onWorkerDisconnect);
        worker.once("exit", this.onWorkerExit);
        const ready = {
            type: "GUARDIAN_READY",
            ...envelope(this.identity),
            guardianPid: process.pid,
            workerPid: worker.pid,
            workerPgid: worker.pid,
        };
        await this.queueParentFrame(ready);
        await this.queueWorkerFrame(frame);
    }
    onWorkerMessage = (value) => {
        this.workerInbound = this.workerInbound
            .then(async () => {
            await this.handleWorkerMessage(value);
        })
            .catch(async () => {
            await this.startLossCleanup(true);
        });
    };
    async handleWorkerMessage(value) {
        if (this.phase === "DONE" || this.phase === "LOSS_CLEANUP" || this.phase === "SHUTDOWN")
            return;
        if (!this.identity || !this.workerIdentity || !isStrictWorkerFrame(value)) {
            throw new Error("Invalid Worker control frame.");
        }
        if (!matchesProtocolIdentity(value, this.identity)) {
            throw new Error("Worker control identity mismatch.");
        }
        if (!this.workerReady) {
            if (value.type !== "WORKER_READY" ||
                value.workerPid !== this.workerIdentity.pid ||
                value.workerPgid !== this.workerIdentity.pgid) {
                throw new Error("Invalid Worker handshake.");
            }
            this.workerReady = true;
            this.phase = "RUNNING";
            await this.queueParentFrame(value);
            return;
        }
        if (value.type === "WORKER_READY")
            throw new Error("Duplicate Worker handshake.");
        if (value.type === "PROTOCOL_ERROR")
            throw new Error("Worker rejected the control protocol.");
        await this.queueParentFrame(value);
    }
    onWorkerError = () => {
        void this.startLossCleanup(false);
    };
    onWorkerDisconnect = () => {
        if (this.phase === "DONE" || this.phase === "SHUTDOWN")
            return;
        void this.startLossCleanup(false);
    };
    onWorkerExit = (code, signal) => {
        this.resolveWorkerExit?.({ code, signal });
        this.resolveWorkerExit = undefined;
        if (this.phase === "DONE" || this.phase === "SHUTDOWN")
            return;
        void this.startLossCleanup(false, { code, signal });
    };
    queueParentFrame(frame) {
        const operation = this.parentOutbound.then(async () => {
            if (!this.parentConnected || !process.connected)
                return;
            try {
                await sendOverParentIpc(frame);
            }
            catch {
                this.parentConnected = false;
                void this.startShutdown(Date.now() + SESSION_SHUTDOWN_BUDGET_MS);
            }
        });
        this.parentOutbound = operation;
        return operation;
    }
    queueWorkerFrame(frame) {
        const operation = this.workerOutbound.then(async () => {
            const worker = this.worker;
            if (!worker)
                throw new Error("Worker is unavailable.");
            await sendOverWorkerIpc(worker, frame);
        });
        this.workerOutbound = operation.catch(() => undefined);
        return operation;
    }
    async sendWorkerExit(exit) {
        if (this.workerExitSent || !this.identity)
            return;
        this.workerExitSent = true;
        const worker = this.worker;
        await this.queueParentFrame({
            type: "WORKER_EXITED",
            ...envelope(this.identity),
            exitCode: exit?.code ?? worker?.exitCode ?? null,
            signal: exit?.signal ?? worker?.signalCode ?? null,
        });
    }
    async observeWorkerExit() {
        const worker = this.worker;
        if (worker && (worker.exitCode !== null || worker.signalCode !== null)) {
            return { code: worker.exitCode, signal: worker.signalCode };
        }
        if (!this.workerExitPromise)
            return undefined;
        return await Promise.race([this.workerExitPromise, delay(WORKER_EXIT_OBSERVATION_MS).then(() => undefined)]);
    }
    async startLossCleanup(protocolFailure, exit) {
        if (this.phase === "DONE" || this.phase === "SHUTDOWN")
            return;
        if (this.cleanup)
            return await this.cleanup;
        this.phase = "LOSS_CLEANUP";
        this.cleanup = (async () => {
            try {
                await this.sendWorkerExit(exit ?? (await this.observeWorkerExit()));
                const workerIdentity = this.workerIdentity;
                if (workerIdentity) {
                    await this.terminateWorkerGroupForLoss(workerIdentity.pgid);
                    if (!processGroupExists(workerIdentity.pgid) && this.identity) {
                        await this.queueParentFrame({
                            type: "LOSS_CLEANED",
                            ...envelope(this.identity),
                            workerPid: workerIdentity.pid,
                            workerPgid: workerIdentity.pgid,
                        });
                    }
                }
                if (protocolFailure && this.identity) {
                    await this.queueParentFrame({
                        type: "PROTOCOL_ERROR",
                        ...envelope(this.identity),
                        code: "SUBAGENT_PROTOCOL_MISMATCH",
                    });
                }
                await this.finish(0);
            }
            catch {
                await this.finish(1);
            }
        })();
        return await this.cleanup;
    }
    async terminateWorkerGroupForLoss(pgid) {
        if (!processGroupExists(pgid))
            return;
        signalProcessGroup(pgid, "SIGTERM");
        if (await waitForProcessGroupExit(pgid, Date.now() + LOSS_TERM_GRACE_MS))
            return;
        signalProcessGroup(pgid, "SIGKILL");
        if (!(await waitForProcessGroupExit(pgid, Date.now() + LOSS_KILL_GRACE_MS))) {
            throw new Error("Worker process group did not exit after SIGKILL.");
        }
    }
    async startShutdown(requestedDeadlineAt) {
        if (this.phase === "DONE" || this.phase === "LOSS_CLEANUP")
            return;
        if (this.cleanup)
            return await this.cleanup;
        this.phase = "SHUTDOWN";
        const now = Date.now();
        const deadlineAt = Number.isSafeInteger(requestedDeadlineAt)
            ? Math.min(Math.max(requestedDeadlineAt, now), now + SESSION_SHUTDOWN_BUDGET_MS)
            : now + SESSION_SHUTDOWN_BUDGET_MS;
        this.cleanup = (async () => {
            try {
                if (this.worker && this.identity) {
                    const shutdownFrame = {
                        type: "SHUTDOWN",
                        ...envelope(this.identity),
                        deadlineAt,
                    };
                    try {
                        await this.queueWorkerFrame(shutdownFrame);
                    }
                    catch {
                        // The fixed process-group escalation below remains authoritative.
                    }
                }
                const workerIdentity = this.workerIdentity;
                if (workerIdentity) {
                    await this.terminateWorkerGroupForShutdown(workerIdentity.pgid, deadlineAt);
                }
                if (this.spoolIdentity)
                    await removeCapturedSpool(this.spoolIdentity);
                if (this.identity) {
                    await this.queueParentFrame({
                        type: "SHUTDOWN_COMPLETE",
                        ...envelope(this.identity),
                    });
                }
                await this.finish(0);
            }
            catch {
                await this.finish(1);
            }
        })();
        return await this.cleanup;
    }
    async terminateWorkerGroupForShutdown(pgid, deadlineAt) {
        if (!processGroupExists(pgid))
            return;
        const cooperativeDeadline = Math.max(Date.now(), Math.min(Date.now() + COOPERATIVE_PHASE_MS, deadlineAt - (TERM_PHASE_MS + KILL_PHASE_MS)));
        if (await waitForProcessGroupExit(pgid, cooperativeDeadline))
            return;
        signalProcessGroup(pgid, "SIGTERM");
        const termDeadline = Math.max(Date.now(), deadlineAt - KILL_PHASE_MS);
        if (await waitForProcessGroupExit(pgid, termDeadline))
            return;
        signalProcessGroup(pgid, "SIGKILL");
        if (await waitForProcessGroupExit(pgid, deadlineAt))
            return;
        throw new Error("Worker process group did not become empty after shutdown SIGKILL.");
    }
    async handleParentProtocolFailure() {
        if (this.phase === "DONE")
            return;
        if (this.workerIdentity) {
            await this.startLossCleanup(true);
            return;
        }
        if (this.identity) {
            await this.queueParentFrame({
                type: "PROTOCOL_ERROR",
                ...envelope(this.identity),
                code: "SUBAGENT_PROTOCOL_MISMATCH",
            });
        }
        await this.startShutdown(Date.now() + SESSION_SHUTDOWN_BUDGET_MS);
    }
    async finish(exitCode) {
        if (this.phase === "DONE")
            return;
        this.phase = "DONE";
        process.off("message", this.onParentMessage);
        this.lease?.off("error", this.onLeaseClosed);
        this.lease?.off("end", this.onLeaseClosed);
        this.lease?.off("close", this.onLeaseClosed);
        this.lease?.destroy();
        this.worker?.off("message", this.onWorkerMessage);
        this.worker?.stdout?.destroy();
        this.worker?.stderr?.destroy();
        await this.parentOutbound.catch(() => undefined);
        if (process.connected)
            process.disconnect();
        this.resolveDone(exitCode);
    }
}
export async function runGuardianProcess() {
    return await new GuardianRuntime().run();
}
