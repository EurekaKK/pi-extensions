export const SUBAGENT_PROTOCOL_VERSION = 1;
export const MAX_CONTROL_MESSAGE_BYTES = 1024 * 1024;
const PARENT_FRAME_TYPES = new Set([
    "BOOTSTRAP",
    "SPAWN",
    "SEND",
    "CANCEL",
    "KILL",
    "MAILBOX_COMMIT_ACK",
    "SHUTDOWN",
]);
const CHILD_FRAME_TYPES = new Set([
    "GUARDIAN_READY",
    "WORKER_READY",
    "RUN_ACCEPTED",
    "OP_NACK",
    "CANCEL_ACCEPTED",
    "KILL_ACCEPTED",
    "KILL_SETTLED",
    "RUN_TERMINAL",
    "RUN_SETTLED",
    "AGENT_TOOL_STATE",
    "WORKER_WARNING",
    "WORKER_EXITED",
    "LOSS_CLEANED",
    "SHUTDOWN_COMPLETE",
    "PROTOCOL_ERROR",
]);
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const FAILURE_CODES = new Set([
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
const DEGRADED_CODES = new Set([
    "factory_failed",
    "loader_failed",
    "provider_registration_failed",
    "session_start_failed",
    "resources_discover_failed",
    "run_admission_gate_failed",
]);
const UNAVAILABLE_REASONS = new Set(["unlocatable", "extension_failed", "not_registered"]);
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
const ENVELOPE_KEYS = ["protocolVersion", "sessionNonce", "managerEpoch", "workerGeneration", "type"];
export function isPlainRecord(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
function isNonEmptyString(value) {
    return typeof value === "string" && value.length > 0;
}
function isSafeNonNegativeInteger(value) {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isPositiveInteger(value) {
    return isSafeNonNegativeInteger(value) && value > 0;
}
function hasExactKeys(value, required, optional = []) {
    const allowed = new Set([...ENVELOPE_KEYS, ...required, ...optional]);
    for (const key of [...ENVELOPE_KEYS, ...required]) {
        if (!Object.hasOwn(value, key))
            return false;
    }
    return Object.keys(value).every((key) => allowed.has(key));
}
function isStringArray(value, allowEmpty = true) {
    return Array.isArray(value) && (allowEmpty || value.length > 0) && value.every((entry) => isNonEmptyString(entry));
}
function isJsonValue(value) {
    if (value === null || typeof value === "string" || typeof value === "boolean")
        return true;
    if (typeof value === "number")
        return Number.isFinite(value);
    if (Array.isArray(value))
        return value.every(isJsonValue);
    if (!isPlainRecord(value))
        return false;
    return Object.values(value).every(isJsonValue);
}
function isModel(value) {
    return (isPlainRecord(value) &&
        hasOnlyObjectKeys(value, ["provider", "id"]) &&
        isNonEmptyString(value.provider) &&
        isNonEmptyString(value.id));
}
function hasOnlyObjectKeys(value, required, optional = []) {
    const allowed = new Set([...required, ...optional]);
    return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}
function isProjectContext(value) {
    return (Array.isArray(value) &&
        value.every((entry) => isPlainRecord(entry) &&
            hasOnlyObjectKeys(entry, ["path", "content"]) &&
            isNonEmptyString(entry.path) &&
            typeof entry.content === "string"));
}
function isParentToolSources(value) {
    return (Array.isArray(value) &&
        value.every((entry) => isPlainRecord(entry) &&
            hasOnlyObjectKeys(entry, ["name"], ["path"]) &&
            isNonEmptyString(entry.name) &&
            (!Object.hasOwn(entry, "path") || isNonEmptyString(entry.path))));
}
function isDegradedExtensions(value) {
    return (Array.isArray(value) &&
        value.every((entry) => isPlainRecord(entry) &&
            hasOnlyObjectKeys(entry, ["path", "code"]) &&
            isNonEmptyString(entry.path) &&
            typeof entry.code === "string" &&
            DEGRADED_CODES.has(entry.code)));
}
function isUnavailableTools(value) {
    return (Array.isArray(value) &&
        value.every((entry) => isPlainRecord(entry) &&
            hasOnlyObjectKeys(entry, ["name", "reason"]) &&
            isNonEmptyString(entry.name) &&
            typeof entry.reason === "string" &&
            UNAVAILABLE_REASONS.has(entry.reason)));
}
function isSpoolMetadata(value) {
    return (isPlainRecord(value) &&
        hasOnlyObjectKeys(value, ["basename", "byteSize", "digest"]) &&
        isNonEmptyString(value.basename) &&
        isSafeNonNegativeInteger(value.byteSize) &&
        typeof value.digest === "string" &&
        /^[a-f0-9]{64}$/u.test(value.digest));
}
export function isProtocolEnvelope(value) {
    return (isPlainRecord(value) &&
        value.protocolVersion === SUBAGENT_PROTOCOL_VERSION &&
        isNonEmptyString(value.sessionNonce) &&
        isNonEmptyString(value.managerEpoch) &&
        isSafeNonNegativeInteger(value.workerGeneration));
}
export function matchesProtocolIdentity(value, identity) {
    return (value.sessionNonce === identity.sessionNonce &&
        value.managerEpoch === identity.managerEpoch &&
        value.workerGeneration === identity.workerGeneration);
}
export function isParentFrame(value) {
    if (!isProtocolEnvelope(value) ||
        typeof value.type !== "string" ||
        !PARENT_FRAME_TYPES.has(value.type)) {
        return false;
    }
    switch (value.type) {
        case "BOOTSTRAP":
            return (hasExactKeys(value, [
                "parentPid",
                "cwd",
                "agentDir",
                "piPackageDir",
                "spoolDir",
                "selfExtensionPath",
                "settingsSnapshot",
                "projectTrusted",
            ]) &&
                isPositiveInteger(value.parentPid) &&
                isNonEmptyString(value.cwd) &&
                isNonEmptyString(value.agentDir) &&
                isNonEmptyString(value.piPackageDir) &&
                isNonEmptyString(value.spoolDir) &&
                isNonEmptyString(value.selfExtensionPath) &&
                isPlainRecord(value.settingsSnapshot) &&
                isJsonValue(value.settingsSnapshot) &&
                typeof value.projectTrusted === "boolean");
        case "SPAWN":
            return (hasExactKeys(value, [
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
                isNonEmptyString(value.opId) &&
                isNonEmptyString(value.agentId) &&
                isNonEmptyString(value.runId) &&
                isNonEmptyString(value.deliveryId) &&
                isNonEmptyString(value.task) &&
                isModel(value.model) &&
                typeof value.thinkingLevel === "string" &&
                THINKING_LEVELS.has(value.thinkingLevel) &&
                isProjectContext(value.projectContext) &&
                isStringArray(value.candidateExtensionPaths) &&
                isStringArray(value.requiredExtensionPaths) &&
                isStringArray(value.parentToolNames) &&
                isParentToolSources(value.parentToolSources) &&
                isStringArray(value.parentActiveToolNames) &&
                (!Object.hasOwn(value, "explicitTools") || isStringArray(value.explicitTools)));
        case "SEND":
            return (hasExactKeys(value, ["opId", "agentId", "runId", "deliveryId", "message"]) &&
                isNonEmptyString(value.opId) &&
                isNonEmptyString(value.agentId) &&
                isNonEmptyString(value.runId) &&
                isNonEmptyString(value.deliveryId) &&
                isNonEmptyString(value.message));
        case "CANCEL":
            return (hasExactKeys(value, ["opId", "agentId", "runId", "reason"]) &&
                isNonEmptyString(value.opId) &&
                isNonEmptyString(value.agentId) &&
                isNonEmptyString(value.runId) &&
                typeof value.reason === "string");
        case "KILL":
            return (hasExactKeys(value, ["opId", "agentId", "lastRunId"]) &&
                isNonEmptyString(value.opId) &&
                isNonEmptyString(value.agentId) &&
                isNonEmptyString(value.lastRunId));
        case "MAILBOX_COMMIT_ACK":
            return (hasExactKeys(value, ["terminalOpId", "agentId", "runId", "deliveryId"]) &&
                isNonEmptyString(value.terminalOpId) &&
                isNonEmptyString(value.agentId) &&
                isNonEmptyString(value.runId) &&
                isNonEmptyString(value.deliveryId));
        case "SHUTDOWN":
            return hasExactKeys(value, ["deadlineAt"]) && isSafeNonNegativeInteger(value.deadlineAt);
        default:
            return false;
    }
}
export function isChildFrame(value) {
    if (!isProtocolEnvelope(value) ||
        typeof value.type !== "string" ||
        !CHILD_FRAME_TYPES.has(value.type)) {
        return false;
    }
    switch (value.type) {
        case "GUARDIAN_READY":
            return (hasExactKeys(value, ["guardianPid", "workerPid", "workerPgid"]) &&
                isPositiveInteger(value.guardianPid) &&
                isPositiveInteger(value.workerPid) &&
                isPositiveInteger(value.workerPgid));
        case "WORKER_READY":
            return (hasExactKeys(value, ["workerPid", "workerPgid", "piVersion"]) &&
                isPositiveInteger(value.workerPid) &&
                isPositiveInteger(value.workerPgid) &&
                isNonEmptyString(value.piVersion));
        case "RUN_ACCEPTED":
            return (hasExactKeys(value, [
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
                isNonEmptyString(value.opId) &&
                (value.operation === "spawn" || value.operation === "send") &&
                isNonEmptyString(value.agentId) &&
                isNonEmptyString(value.runId) &&
                isModel(value.model) &&
                typeof value.thinkingLevel === "string" &&
                THINKING_LEVELS.has(value.thinkingLevel) &&
                isSafeNonNegativeInteger(value.activeToolCount) &&
                isSafeNonNegativeInteger(value.capabilityToolCount) &&
                isDegradedExtensions(value.degradedExtensions) &&
                isUnavailableTools(value.unavailableTools));
        case "OP_NACK":
            return (hasExactKeys(value, ["opId", "operation", "code", "message"], ["agentId", "runId", "currentRunId", "lastRunId"]) &&
                isNonEmptyString(value.opId) &&
                ["spawn", "send", "cancel", "kill"].includes(value.operation) &&
                typeof value.code === "string" &&
                OPERATION_ERROR_CODES.has(value.code) &&
                typeof value.message === "string" &&
                ["agentId", "runId", "currentRunId", "lastRunId"].every((key) => !Object.hasOwn(value, key) || isNonEmptyString(value[key])));
        case "CANCEL_ACCEPTED":
            return (hasExactKeys(value, ["opId", "agentId", "runId"]) &&
                isNonEmptyString(value.opId) &&
                isNonEmptyString(value.agentId) &&
                isNonEmptyString(value.runId));
        case "KILL_ACCEPTED":
        case "KILL_SETTLED":
            return (hasExactKeys(value, ["opId", "agentId", "lastRunId"]) &&
                isNonEmptyString(value.opId) &&
                isNonEmptyString(value.agentId) &&
                isNonEmptyString(value.lastRunId));
        case "RUN_TERMINAL": {
            const common = isNonEmptyString(value.terminalOpId) &&
                isNonEmptyString(value.agentId) &&
                isNonEmptyString(value.runId) &&
                isNonEmptyString(value.deliveryId) &&
                isSafeNonNegativeInteger(value.completedAt);
            if (!common)
                return false;
            if (value.outcome === "RESULT") {
                return (hasExactKeys(value, ["terminalOpId", "agentId", "runId", "deliveryId", "completedAt", "outcome", "spool"]) &&
                    isSpoolMetadata(value.spool));
            }
            if (value.outcome === "FAILED") {
                return (hasExactKeys(value, [
                    "terminalOpId",
                    "agentId",
                    "runId",
                    "deliveryId",
                    "completedAt",
                    "outcome",
                    "failureCode",
                ]) &&
                    typeof value.failureCode === "string" &&
                    FAILURE_CODES.has(value.failureCode));
            }
            return (value.outcome === "CANCELLED" &&
                hasExactKeys(value, [
                    "terminalOpId",
                    "agentId",
                    "runId",
                    "deliveryId",
                    "completedAt",
                    "outcome",
                    "cancelReason",
                ]) &&
                typeof value.cancelReason === "string");
        }
        case "RUN_SETTLED":
            return (hasExactKeys(value, ["terminalOpId", "agentId", "runId", "deliveryId"]) &&
                isNonEmptyString(value.terminalOpId) &&
                isNonEmptyString(value.agentId) &&
                isNonEmptyString(value.runId) &&
                isNonEmptyString(value.deliveryId));
        case "AGENT_TOOL_STATE":
            return (hasExactKeys(value, ["agentId", "activeToolCount", "capabilityToolCount"]) &&
                isNonEmptyString(value.agentId) &&
                isSafeNonNegativeInteger(value.activeToolCount) &&
                isSafeNonNegativeInteger(value.capabilityToolCount));
        case "WORKER_WARNING":
            return (hasExactKeys(value, ["code"], ["agentId", "runId"]) &&
                isNonEmptyString(value.code) &&
                (!Object.hasOwn(value, "agentId") || isNonEmptyString(value.agentId)) &&
                (!Object.hasOwn(value, "runId") || isNonEmptyString(value.runId)));
        case "WORKER_EXITED":
            return (hasExactKeys(value, ["exitCode", "signal"]) &&
                (value.exitCode === null || (typeof value.exitCode === "number" && Number.isInteger(value.exitCode))) &&
                (value.signal === null || isNonEmptyString(value.signal)));
        case "LOSS_CLEANED":
            return (hasExactKeys(value, ["workerPid", "workerPgid"]) &&
                isPositiveInteger(value.workerPid) &&
                isPositiveInteger(value.workerPgid));
        case "SHUTDOWN_COMPLETE":
            return hasExactKeys(value, []);
        case "PROTOCOL_ERROR":
            return (hasExactKeys(value, ["code"]) &&
                (value.code === "SUBAGENT_PROTOCOL_MISMATCH" || value.code === "SUBAGENT_PI_API_UNSUPPORTED"));
        default:
            return false;
    }
}
export function controlMessageByteLength(value) {
    try {
        return Buffer.byteLength(JSON.stringify(value), "utf8");
    }
    catch {
        return Number.POSITIVE_INFINITY;
    }
}
export function isControlMessageWithinLimit(value) {
    return controlMessageByteLength(value) <= MAX_CONTROL_MESSAGE_BYTES;
}
export function assertControlMessageWithinLimit(value) {
    if (!isControlMessageWithinLimit(value)) {
        throw new Error("SUBAGENT_CONTROL_MESSAGE_TOO_LARGE");
    }
}
