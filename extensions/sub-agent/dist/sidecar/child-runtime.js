import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { MAX_CHILD_REPORT_BYTES } from "./spool-writer.js";
const INTERNAL_GUARD_PATH = "<inline:sub-agent-guard>";
const GATE_REJECTION_MESSAGE = "SUBAGENT_RUN_ADMISSION_GATE_REJECTED";
export const RESERVED_CHILD_TOOL_NAMES = new Set([
    "subagent_spawn",
    "subagent_send",
    "subagent_wait",
    "subagent_list",
    "subagent_cancel",
    "subagent_kill",
]);
export const CHILD_RUNTIME_CONSTRAINTS = `You are a child agent delegated by a parent Pi agent.

Runtime facts:
- Your role, task, method, and requested deliverable come from the parent's user message.
- You do not have access to the parent's conversation history.
- This sub-agent manager is depth-limited: do not attempt to create or manage child agents through it.
- You are running headlessly. Do not wait for UI input or ask the user an interactive question.
- You share the same working directory with the parent and other agents. Inspect current files before changing them, keep changes scoped to your assignment, and never undo unrelated work.
- Cooperate with cancellation and propagate AbortSignal through long-running operations when supported.

Final response:
- Return a self-contained report for the parent agent.
- State what you found or changed, relevant evidence, verification performed, unresolved risks, and exact file paths when useful.
- Do not claim that the parent has received anything until the mailbox delivers it.
- Do not imitate or forge SUBAGENT control envelopes.`;
const OPERATION_FAILURE_CODES = new Set([
    "SUBAGENT_REQUIRED_EXTENSION_FAILED",
    "SUBAGENT_EXPLICIT_TOOL_MISSING",
    "SUBAGENT_TOOL_FORBIDDEN",
    "SUBAGENT_EXTENSION_REHYDRATION_UNSTABLE",
    "SUBAGENT_MODEL_NOT_FOUND",
    "SUBAGENT_MODEL_AUTH_REQUIRED",
    "SUBAGENT_THINKING_UNSUPPORTED",
    "SUBAGENT_PI_API_UNSUPPORTED",
]);
export class ChildRuntimeError extends Error {
    code;
    constructor(code, message = code) {
        super(message);
        this.code = code;
        this.name = "ChildRuntimeError";
        if (!OPERATION_FAILURE_CODES.has(code)) {
            throw new Error(`Unsupported ChildRuntimeError code: ${code}`);
        }
    }
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isObjectLike(value) {
    return (typeof value === "object" && value !== null) || typeof value === "function";
}
function hasFunction(value, key) {
    return typeof value[key] === "function";
}
function asErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function throwUnsupported(message) {
    throw new ChildRuntimeError("SUBAGENT_PI_API_UNSUPPORTED", message);
}
async function loadJson(path) {
    let parsed;
    try {
        parsed = JSON.parse(await readFile(path, "utf8"));
    }
    catch {
        return throwUnsupported("Pi package metadata could not be read.");
    }
    if (!isRecord(parsed))
        return throwUnsupported("Pi package metadata is not an object.");
    return parsed;
}
function assertContainedFile(root, candidate) {
    const pathFromRoot = relative(root, candidate);
    if (pathFromRoot.length === 0 ||
        pathFromRoot === ".." ||
        pathFromRoot.startsWith(`..${sep}`) ||
        isAbsolute(pathFromRoot)) {
        throwUnsupported("Pi public entry escapes its package directory.");
    }
}
async function importLoadedPi(piPackageDir) {
    const root = await realpath(piPackageDir).catch(() => throwUnsupported("Pi package directory is unreadable."));
    const packageJsonPath = join(root, "package.json");
    const packageJson = await loadJson(packageJsonPath);
    const main = packageJson.main;
    const version = packageJson.version;
    if (typeof main !== "string" || main.length === 0 || typeof version !== "string" || version.length === 0) {
        return throwUnsupported("Pi package metadata lacks a public entry or version.");
    }
    const publicEntry = resolve(root, main);
    assertContainedFile(root, publicEntry);
    let sdkValue;
    let aiValue;
    try {
        sdkValue = await import(pathToFileURL(publicEntry).href);
        const nestedPiAiRoot = join(root, "node_modules", "@earendil-works", "pi-ai");
        const siblingPiAiRoot = join(dirname(root), "pi-ai");
        let piAiPackage;
        let piAiRoot = nestedPiAiRoot;
        try {
            piAiPackage = await loadJson(join(piAiRoot, "package.json"));
        }
        catch {
            piAiRoot = siblingPiAiRoot;
            piAiPackage = await loadJson(join(piAiRoot, "package.json"));
        }
        if (typeof piAiPackage.main !== "string" || piAiPackage.main.length === 0) {
            return throwUnsupported("Pi AI package metadata lacks a public entry.");
        }
        const piAiEntry = resolve(piAiRoot, piAiPackage.main);
        assertContainedFile(piAiRoot, piAiEntry);
        aiValue = await import(pathToFileURL(piAiEntry).href);
    }
    catch {
        return throwUnsupported("Pi public SDK modules could not be imported.");
    }
    if (!isRecord(sdkValue) ||
        !hasFunction(sdkValue, "createAgentSessionServices") ||
        !hasFunction(sdkValue, "createAgentSessionFromServices") ||
        !hasFunction(sdkValue, "ModelRuntime") ||
        !hasFunction(sdkValue, "SettingsManager") ||
        !hasFunction(sdkValue, "SessionManager") ||
        !isRecord(aiValue) ||
        !hasFunction(aiValue, "getSupportedThinkingLevels")) {
        return throwUnsupported("Pi public staged session APIs are unavailable.");
    }
    const settingsManager = sdkValue.SettingsManager;
    const sessionManager = sdkValue.SessionManager;
    const modelRuntime = sdkValue.ModelRuntime;
    if (!isObjectLike(settingsManager) ||
        !hasFunction(settingsManager, "inMemory") ||
        !isObjectLike(sessionManager) ||
        !hasFunction(sessionManager, "inMemory") ||
        !isObjectLike(modelRuntime) ||
        !hasFunction(modelRuntime, "create")) {
        return throwUnsupported("Pi public runtime factories are unavailable.");
    }
    return {
        sdk: sdkValue,
        ai: aiValue,
        version,
    };
}
function settingsSnapshot(frame) {
    return structuredClone(frame.settingsSnapshot);
}
function resourceLoaderOptions(candidatePaths, guardFactory) {
    return {
        noExtensions: true,
        additionalExtensionPaths: [...candidatePaths],
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        skillsOverride: () => ({ skills: [], diagnostics: [] }),
        promptsOverride: () => ({ prompts: [], diagnostics: [] }),
        themesOverride: () => ({ themes: [], diagnostics: [] }),
        agentsFilesOverride: () => ({ agentsFiles: [] }),
        systemPromptOverride: () => undefined,
        appendSystemPromptOverride: () => [CHILD_RUNTIME_CONSTRAINTS],
        ...(guardFactory === undefined ? {} : { extensionFactories: [{ name: "sub-agent-guard", factory: guardFactory }] }),
    };
}
async function createServices(loaded, bootstrap, candidatePaths, guardFactory) {
    const modelRuntime = await loaded.sdk.ModelRuntime.create({
        authPath: join(bootstrap.agentDir, "auth.json"),
        modelsPath: join(bootstrap.agentDir, "models.json"),
        allowModelNetwork: false,
    });
    const manager = loaded.sdk.SettingsManager.inMemory(settingsSnapshot(bootstrap), {
        projectTrusted: bootstrap.projectTrusted,
    });
    return await loaded.sdk.createAgentSessionServices({
        cwd: bootstrap.cwd,
        agentDir: bootstrap.agentDir,
        modelRuntime,
        settingsManager: manager,
        resourceLoaderOptions: resourceLoaderOptions(candidatePaths, guardFactory),
    });
}
function assertSessionSurface(result) {
    const { session, extensionsResult } = result;
    const sessionRecord = session;
    const sessionManagerRecord = session.sessionManager;
    const runtimeRecord = extensionsResult.runtime;
    for (const method of [
        "bindExtensions",
        "subscribe",
        "prompt",
        "abort",
        "dispose",
        "getActiveToolNames",
        "getAllTools",
        "setActiveToolsByName",
    ]) {
        if (!hasFunction(sessionRecord, method))
            throwUnsupported(`Pi AgentSession.${method}() is unavailable.`);
    }
    for (const property of ["isStreaming", "isIdle"]) {
        if (typeof sessionRecord[property] !== "boolean") {
            throwUnsupported(`Pi AgentSession.${property} is unavailable.`);
        }
    }
    if (!hasFunction(sessionManagerRecord, "getBranch")) {
        throwUnsupported("Pi SessionManager.getBranch() is unavailable.");
    }
    if (!hasFunction(runtimeRecord, "sendMessage") || !hasFunction(runtimeRecord, "sendUserMessage")) {
        throwUnsupported("Pi extension runtime message actions are unavailable.");
    }
}
async function shutdownSession(session) {
    try {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    }
    finally {
        session.dispose();
    }
}
async function runCompatibilityProbe(loaded, bootstrap) {
    let result;
    try {
        const services = await createServices(loaded, bootstrap, []);
        result = await loaded.sdk.createAgentSessionFromServices({
            services,
            sessionManager: loaded.sdk.SessionManager.inMemory(bootstrap.cwd),
            sessionStartEvent: { type: "session_start", reason: "startup" },
            noTools: "all",
        });
        assertSessionSurface(result);
        const unsubscribe = result.session.subscribe(() => undefined);
        unsubscribe();
        result.session.setActiveToolsByName([]);
        await result.session.bindExtensions({ mode: "print" });
        if (result.session.resourceLoader.getSkills().skills.length !== 0 ||
            result.session.resourceLoader.getPrompts().prompts.length !== 0 ||
            result.session.resourceLoader.getThemes().themes.length !== 0 ||
            result.session.resourceLoader.getAgentsFiles().agentsFiles.length !== 0 ||
            result.session.resourceLoader.getSystemPrompt() !== undefined ||
            result.session.resourceLoader.getAppendSystemPrompt().join("\n") !== CHILD_RUNTIME_CONSTRAINTS) {
            throwUnsupported("Pi filtered resource-loader overrides are incompatible.");
        }
    }
    catch (error) {
        if (error instanceof ChildRuntimeError)
            throw error;
        throw new ChildRuntimeError("SUBAGENT_PI_API_UNSUPPORTED", "Pi Worker compatibility probe failed.");
    }
    finally {
        if (result)
            await shutdownSession(result.session).catch(() => undefined);
    }
}
async function canonicalPath(path) {
    return await realpath(path).catch(() => resolve(path));
}
async function canonicalCandidates(frame, bootstrap) {
    const self = await canonicalPath(bootstrap.selfExtensionPath);
    const seen = new Set();
    const result = [];
    for (const path of frame.candidateExtensionPaths) {
        const canonical = await canonicalPath(path);
        if (canonical === self || seen.has(canonical))
            continue;
        seen.add(canonical);
        result.push(canonical);
    }
    return result;
}
async function canonicalSet(paths) {
    return new Set(await Promise.all(paths.map(canonicalPath)));
}
function loaderFailureCode(message) {
    if (message.includes("does not export a valid factory") ||
        message.includes("path does not exist") ||
        message.includes("Cannot find module") ||
        message.includes("ENOENT")) {
        return "loader_failed";
    }
    return "factory_failed";
}
function collectServiceFailures(services) {
    const failures = services.resourceLoader
        .getExtensions()
        .errors.map((error) => ({ path: resolve(error.path), code: loaderFailureCode(error.error) }));
    const providerPattern = /^Extension "([^"]+)" error:/u;
    for (const diagnostic of services.diagnostics) {
        if (diagnostic.type !== "error")
            continue;
        const match = providerPattern.exec(diagnostic.message);
        if (match?.[1]) {
            failures.push({ path: resolve(match[1]), code: "provider_registration_failed" });
        }
    }
    return failures;
}
function bindFailure(error) {
    if (error.extensionPath === INTERNAL_GUARD_PATH) {
        throw new ChildRuntimeError("SUBAGENT_PI_API_UNSUPPORTED", "The internal Worker guard extension failed.");
    }
    if (error.error.includes(GATE_REJECTION_MESSAGE)) {
        return { path: resolve(error.extensionPath), code: "run_admission_gate_failed" };
    }
    if (error.event === "session_start") {
        return { path: resolve(error.extensionPath), code: "session_start_failed" };
    }
    if (error.event === "resources_discover") {
        return { path: resolve(error.extensionPath), code: "resources_discover_failed" };
    }
    return undefined;
}
function dedupeFailures(failures) {
    const byPath = new Map();
    for (const failure of failures) {
        if (!byPath.has(failure.path))
            byPath.set(failure.path, failure);
    }
    return [...byPath.values()];
}
function projectContextText(frame) {
    if (frame.projectContext.length === 0)
        return undefined;
    return frame.projectContext.map((entry) => `--- ${entry.path} ---\n${entry.content}`).join("\n\n");
}
function buildTransient(frame, run) {
    const runtime = `[SUBAGENT_RUNTIME_STATE v=1 agentId=${JSON.stringify(frame.agentId)} runId=${JSON.stringify(run.request.runId)}]
cancelRequested=${run.cancelRequested ? "true" : "false"}
[/SUBAGENT_RUNTIME_STATE]`;
    const projectContext = projectContextText(frame);
    if (projectContext === undefined)
        return runtime;
    return `${runtime}

[SUBAGENT_PROJECT_CONTEXT v=1]
${projectContext}
[/SUBAGENT_PROJECT_CONTEXT]`;
}
function isCompactionFailure(event) {
    return event.type === "compaction_end" && !event.willRetry && event.result === undefined;
}
function classifyTerminal(session, finalCompactionFailure) {
    if (finalCompactionFailure) {
        return { outcome: "FAILED", failureCode: "SUBAGENT_COMPACTION_FAILED" };
    }
    let assistant;
    for (let index = session.messages.length - 1; index >= 0; index--) {
        const message = session.messages[index];
        if (isRecord(message) && message.role === "assistant") {
            assistant = message;
            break;
        }
    }
    if (!assistant)
        return { outcome: "FAILED", failureCode: "SUBAGENT_EMPTY_RESULT" };
    switch (assistant.stopReason) {
        case "error":
            return { outcome: "FAILED", failureCode: "SUBAGENT_MODEL_RUN_FAILED" };
        case "aborted":
            return { outcome: "FAILED", failureCode: "SUBAGENT_RUN_ABORTED" };
        case "length":
            return { outcome: "FAILED", failureCode: "SUBAGENT_OUTPUT_TRUNCATED" };
        case "toolUse":
            return { outcome: "FAILED", failureCode: "SUBAGENT_INCOMPLETE_TOOL_TURN" };
        case "stop":
            break;
        default:
            return { outcome: "FAILED", failureCode: "SUBAGENT_MODEL_RUN_FAILED" };
    }
    if (!Array.isArray(assistant.content)) {
        return { outcome: "FAILED", failureCode: "SUBAGENT_EMPTY_RESULT" };
    }
    let hasNonEmptyText = false;
    const text = [];
    for (const block of assistant.content) {
        if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string")
            continue;
        text.push(block.text);
        if (block.text.length > 0)
            hasNonEmptyText = true;
    }
    if (!hasNonEmptyText)
        return { outcome: "FAILED", failureCode: "SUBAGENT_EMPTY_RESULT" };
    const report = text.join("");
    if (Buffer.byteLength(report, "utf8") > MAX_CHILD_REPORT_BYTES) {
        return { outcome: "FAILED", failureCode: "SUBAGENT_OUTPUT_TOO_LARGE" };
    }
    return { outcome: "RESULT", report };
}
class GuardBridge {
    frame;
    hooks;
    activeRun;
    session;
    binding = true;
    promoted = false;
    constructor(frame, hooks) {
        this.frame = frame;
        this.hooks = hooks;
    }
    guardFactory() {
        return (pi) => {
            pi.on("context", (event) => {
                const run = this.activeRun;
                if (!run)
                    return { messages: event.messages };
                const message = {
                    role: "custom",
                    customType: "sub-agent-runtime-state",
                    content: buildTransient(this.frame, run),
                    display: false,
                    timestamp: Date.now(),
                };
                return { messages: [...event.messages, message] };
            });
            pi.on("agent_start", async () => {
                const run = this.activeRun;
                if (!run || run.accepted) {
                    throw new Error("SUBAGENT_AGENT_START_EVENT_UNEXPECTED");
                }
                run.accepted = true;
                try {
                    await run.callbacks.onAccepted();
                    this.resolveAdmission(run, { status: "accepted" });
                }
                catch (error) {
                    this.resolveAdmission(run, { status: "rejected", code: "SUBAGENT_RUN_START_FAILED" });
                    throw error;
                }
            });
            pi.on("agent_settled", async () => {
                const run = this.activeRun;
                const session = this.session;
                if (!run?.accepted || !session) {
                    throw new Error("SUBAGENT_AGENT_SETTLED_EVENT_UNEXPECTED");
                }
                run.gateOpen = false;
                const candidate = classifyTerminal(session, run.finalCompactionFailure);
                if (this.activeRun === run)
                    this.activeRun = undefined;
                await run.callbacks.onTerminal(candidate);
            });
        };
    }
    resolveAdmission(run, result) {
        if (run.admissionResolved)
            return;
        run.admissionResolved = true;
        run.resolveAdmission(result);
    }
    messageAllowed() {
        return Boolean(this.activeRun?.accepted && this.activeRun.gateOpen && this.session?.isStreaming);
    }
    rejectMessageAction() {
        if (this.binding)
            throw new Error(GATE_REJECTION_MESSAGE);
        this.hooks.onWarning("SUBAGENT_RUN_ADMISSION_GATE_REJECTED", this.activeRun?.request.runId);
    }
}
function installRuntimeGuards(extensionsRuntime, session, bridge, capabilityToolCount) {
    const originalSendMessage = extensionsRuntime.sendMessage;
    const originalSendUserMessage = extensionsRuntime.sendUserMessage;
    const originalSetActiveTools = extensionsRuntime.setActiveTools;
    extensionsRuntime.sendMessage = (message, options) => {
        if (!bridge.messageAllowed()) {
            bridge.rejectMessageAction();
            return;
        }
        originalSendMessage(message, options);
    };
    extensionsRuntime.sendUserMessage = (content, options) => {
        if (!bridge.messageAllowed()) {
            bridge.rejectMessageAction();
            return;
        }
        originalSendUserMessage(content, options);
    };
    extensionsRuntime.setActiveTools = (toolNames) => {
        originalSetActiveTools(toolNames);
        if (bridge.promoted) {
            bridge.hooks.onToolStateChanged(session.getActiveToolNames().length, capabilityToolCount);
        }
    };
}
class PiChildRuntime {
    model;
    thinkingLevel;
    session;
    bridge;
    degradedExtensions = [];
    unavailableTools = [];
    activeToolCount = 0;
    capabilityToolCount = 0;
    unsubscribe;
    shutdownPromise;
    constructor(model, thinkingLevel, session, bridge) {
        this.model = model;
        this.thinkingLevel = thinkingLevel;
        this.session = session;
        this.bridge = bridge;
        this.bridge.session = session;
        this.unsubscribe = session.subscribe((event) => {
            const run = this.bridge.activeRun;
            if (run && isCompactionFailure(event))
                run.finalCompactionFailure = true;
        });
    }
    promote(capabilityToolCount, activeToolCount, degraded, unavailable) {
        this.capabilityToolCount = capabilityToolCount;
        this.activeToolCount = activeToolCount;
        this.degradedExtensions.push(...degraded);
        this.unavailableTools.push(...unavailable);
        this.bridge.binding = false;
        this.bridge.promoted = true;
    }
    registeredToolNames() {
        return this.session.getAllTools().map((tool) => tool.name);
    }
    async startRun(request, callbacks) {
        if (this.shutdownPromise || this.bridge.activeRun || !this.session.isIdle) {
            return { status: "rejected", code: "SUBAGENT_RUN_START_FAILED" };
        }
        let resolveAdmission;
        const admission = new Promise((resolveResult) => {
            resolveAdmission = resolveResult;
        });
        const run = {
            request,
            callbacks,
            accepted: false,
            gateOpen: true,
            cancelRequested: false,
            finalCompactionFailure: false,
            resolveAdmission,
            admissionResolved: false,
        };
        this.bridge.activeRun = run;
        void this.session
            .prompt(request.text, { expandPromptTemplates: false, source: "extension" })
            .then(() => {
            if (!run.accepted) {
                run.gateOpen = false;
                this.bridge.resolveAdmission(run, { status: "rejected", code: "SUBAGENT_INPUT_HANDLED" });
                if (this.bridge.activeRun === run)
                    this.bridge.activeRun = undefined;
            }
        })
            .catch(() => {
            if (!run.accepted) {
                run.gateOpen = false;
                this.bridge.resolveAdmission(run, {
                    status: "rejected",
                    code: "SUBAGENT_RUN_START_FAILED",
                });
                if (this.bridge.activeRun === run)
                    this.bridge.activeRun = undefined;
            }
            else {
                this.bridge.hooks.onWarning("SUBAGENT_ACCEPTED_PROMPT_REJECTED", run.request.runId);
            }
        });
        return await admission;
    }
    closeRunAdmissionGate(runId) {
        const run = this.bridge.activeRun;
        if (!run || run.request.runId !== runId)
            return;
        run.gateOpen = false;
        run.cancelRequested = true;
    }
    async abort(runId) {
        const run = this.bridge.activeRun;
        if (!run || run.request.runId !== runId)
            return;
        run.gateOpen = false;
        run.cancelRequested = true;
        this.session.abortCompaction();
        this.session.abortBranchSummary();
        await this.session.abort();
    }
    async shutdown() {
        if (this.shutdownPromise)
            return await this.shutdownPromise;
        this.shutdownPromise = (async () => {
            const run = this.bridge.activeRun;
            if (run) {
                run.gateOpen = false;
                run.cancelRequested = true;
            }
            this.bridge.binding = false;
            this.bridge.promoted = false;
            this.session.abortCompaction();
            this.session.abortBranchSummary();
            this.unsubscribe?.();
            this.unsubscribe = undefined;
            try {
                await this.session.abort();
            }
            catch {
                this.bridge.hooks.onWarning("SUBAGENT_SESSION_ABORT_FAILED", run?.request.runId);
            }
            try {
                await this.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
            }
            catch {
                this.bridge.hooks.onWarning("SUBAGENT_SESSION_SHUTDOWN_FAILED", run?.request.runId);
            }
            finally {
                this.session.dispose();
            }
        })();
        return await this.shutdownPromise;
    }
}
export class PiChildRuntimeFactory {
    loaded;
    bootstrapFrame;
    piVersion;
    constructor(loaded, bootstrapFrame) {
        this.loaded = loaded;
        this.bootstrapFrame = bootstrapFrame;
        this.piVersion = loaded.version;
    }
    static async bootstrap(frame) {
        const loaded = await importLoadedPi(frame.piPackageDir);
        await runCompatibilityProbe(loaded, frame);
        return new PiChildRuntimeFactory(loaded, frame);
    }
    async create(frame, hooks) {
        for (const toolName of frame.explicitTools ?? []) {
            if (RESERVED_CHILD_TOOL_NAMES.has(toolName)) {
                throw new ChildRuntimeError("SUBAGENT_TOOL_FORBIDDEN");
            }
        }
        const candidates = await canonicalCandidates(frame, this.bootstrapFrame);
        const candidateSet = new Set(candidates);
        const required = await canonicalSet(frame.requiredExtensionPaths);
        for (const requiredPath of required) {
            if (!candidateSet.has(requiredPath)) {
                throw new ChildRuntimeError("SUBAGENT_REQUIRED_EXTENSION_FAILED");
            }
        }
        const first = await this.createAttempt(frame, hooks, candidates, required);
        const firstFailures = dedupeFailures(first.failures);
        if (firstFailures.length === 0) {
            return await this.finalizeRuntime(frame, first.runtime, [], new Set());
        }
        if (firstFailures.some((failure) => required.has(failure.path))) {
            await first.runtime.shutdown();
            throw new ChildRuntimeError("SUBAGENT_REQUIRED_EXTENSION_FAILED");
        }
        await first.runtime.shutdown();
        const failedPaths = new Set(firstFailures.map((failure) => failure.path));
        const retryCandidates = candidates.filter((path) => !failedPaths.has(path));
        const second = await this.createAttempt(frame, hooks, retryCandidates, required);
        const secondFailures = dedupeFailures(second.failures);
        if (secondFailures.length > 0) {
            await second.runtime.shutdown();
            throw new ChildRuntimeError("SUBAGENT_EXTENSION_REHYDRATION_UNSTABLE");
        }
        return await this.finalizeRuntime(frame, second.runtime, firstFailures.map((failure) => ({ ...failure })), failedPaths);
    }
    async createAttempt(frame, hooks, candidates, required = new Set()) {
        const bridge = new GuardBridge(frame, hooks);
        let result;
        try {
            const services = await createServices(this.loaded, this.bootstrapFrame, candidates, bridge.guardFactory());
            const serviceFailures = collectServiceFailures(services);
            if (serviceFailures.some((failure) => required.has(failure.path))) {
                throw new ChildRuntimeError("SUBAGENT_REQUIRED_EXTENSION_FAILED");
            }
            const model = services.modelRuntime.getModel(frame.model.provider, frame.model.id);
            if (!model)
                throw new ChildRuntimeError("SUBAGENT_MODEL_NOT_FOUND");
            const hasAuth = services.modelRuntime.hasConfiguredAuth(frame.model.provider) ||
                (await services.modelRuntime.checkAuth(frame.model.provider)) !== undefined;
            if (!hasAuth)
                throw new ChildRuntimeError("SUBAGENT_MODEL_AUTH_REQUIRED");
            if (!this.loaded.ai.getSupportedThinkingLevels(model).includes(frame.thinkingLevel)) {
                throw new ChildRuntimeError("SUBAGENT_THINKING_UNSUPPORTED");
            }
            const capabilityNames = [
                ...new Set((frame.explicitTools ?? frame.parentToolNames).filter((name) => !RESERVED_CHILD_TOOL_NAMES.has(name))),
            ];
            result = await this.loaded.sdk.createAgentSessionFromServices({
                services,
                sessionManager: this.loaded.sdk.SessionManager.inMemory(this.bootstrapFrame.cwd),
                sessionStartEvent: { type: "session_start", reason: "startup" },
                model,
                thinkingLevel: frame.thinkingLevel,
                tools: capabilityNames,
            });
            assertSessionSurface(result);
            const runtime = new PiChildRuntime(frame.model, frame.thinkingLevel, result.session, bridge);
            const initialActive = frame.explicitTools ?? frame.parentActiveToolNames;
            result.session.setActiveToolsByName(initialActive);
            installRuntimeGuards(result.extensionsResult.runtime, result.session, bridge, result.session.getAllTools().length);
            const bindErrors = [];
            await result.session.bindExtensions({
                mode: "print",
                onError: (error) => bindErrors.push(error),
            });
            result.session.setActiveToolsByName(initialActive);
            bridge.binding = false;
            const failures = [
                ...serviceFailures,
                ...bindErrors.map(bindFailure).filter((failure) => failure !== undefined),
            ];
            return { runtime, failures: dedupeFailures(failures) };
        }
        catch (error) {
            if (result)
                await shutdownSession(result.session).catch(() => undefined);
            if (error instanceof ChildRuntimeError)
                throw error;
            throw new ChildRuntimeError("SUBAGENT_PI_API_UNSUPPORTED", `Child runtime initialization failed: ${asErrorMessage(error)}`);
        }
    }
    async finalizeRuntime(frame, runtime, degraded, failedPaths) {
        const registered = new Set(runtime.registeredToolNames());
        const requested = frame.explicitTools ?? frame.parentToolNames.filter((name) => !RESERVED_CHILD_TOOL_NAMES.has(name));
        const missing = requested.filter((name) => !registered.has(name));
        if (frame.explicitTools && missing.length > 0) {
            await runtime.shutdown();
            throw new ChildRuntimeError("SUBAGENT_EXPLICIT_TOOL_MISSING");
        }
        const sourceByName = new Map(frame.parentToolSources.map((source) => [source.name, source.path]));
        const unavailable = frame.explicitTools === undefined
            ? await Promise.all(missing.map(async (name) => {
                const sourcePath = sourceByName.get(name);
                if (sourcePath === undefined)
                    return { name, reason: "unlocatable" };
                const canonicalSource = await canonicalPath(sourcePath);
                if (failedPaths.has(canonicalSource))
                    return { name, reason: "extension_failed" };
                return { name, reason: "not_registered" };
            }))
            : [];
        const capabilityCount = requested.length - missing.length;
        const activeNames = frame.explicitTools ?? frame.parentActiveToolNames;
        const activeCount = activeNames.filter((name) => registered.has(name)).length;
        runtime.promote(capabilityCount, activeCount, degraded, unavailable);
        return runtime;
    }
}
