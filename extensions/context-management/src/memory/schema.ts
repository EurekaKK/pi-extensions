import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import {
	MEMORY_CONTENT_BYTE_LIMIT,
	MEMORY_ID_PREFIX,
	MEMORY_SCHEMA,
	MEMORY_STORE_BYTE_LIMIT,
	MEMORY_SUMMARY_TOKEN_LIMIT,
} from "../constants.js";
import { ContextManagementError } from "../errors.js";
import { estimateTextTokens } from "../runtime/budget.js";
import { stableFingerprint } from "../stable-json.js";

export const MEMORY_KINDS = ["decision", "verified-change", "learning", "milestone"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export type MemoryScope =
	| { readonly kind: "repository"; readonly paths: readonly string[] }
	| { readonly kind: "branch"; readonly branch: string; readonly paths: readonly string[] };

export interface MemoryOrigin {
	readonly sessionId: string;
	readonly entryId: string | null;
	readonly gitBranch: string | null;
	readonly gitHead: string | null;
	readonly trigger: "primary-agent-tool";
}

export interface MemoryRecord {
	readonly id: string;
	readonly kind: MemoryKind;
	readonly title: string;
	readonly summary: string;
	readonly contentMarkdown: string;
	readonly scope: MemoryScope;
	readonly origin: MemoryOrigin;
	readonly createdAt: string;
	readonly fingerprint: string;
	readonly supersedes: readonly string[];
	readonly supersededBy: string | null;
}

export interface RepositoryMetadata {
	readonly key: string;
	readonly identityKind: "git-common-dir" | "directory";
	readonly canonicalPath: string;
	readonly createdAt: string;
}

export interface MemoryEnvelope {
	readonly schemaVersion: 1;
	readonly repository: RepositoryMetadata;
	readonly records: readonly MemoryRecord[];
}

export interface MemoryAuthorFields {
	readonly kind: MemoryKind;
	readonly title: string;
	readonly summary: string;
	readonly contentMarkdown: string;
	readonly scope: MemoryScope;
	readonly supersedes: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0 || value.includes("\0") || !isWellFormed(value)) {
		throw new ContextManagementError(
			"context_management.memory_validation_failure",
			`${field} must be a non-empty Unicode string without NUL.`,
		);
	}
	return value;
}

function isWellFormed(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
			index += 1;
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			return false;
		}
	}
	return true;
}

function nullableString(value: unknown, field: string): string | null {
	return value === null ? null : requiredString(value, field);
}

function parseIsoDate(value: unknown, field: string): string {
	const text = requiredString(value, field);
	if (!Number.isFinite(Date.parse(text))) {
		throw new ContextManagementError("context_management.memory_validation_failure", `${field} must be ISO time.`);
	}
	return text;
}

export function normalizeMemoryPath(path: string): string {
	if (path.length === 0 || path.includes("\0") || path.startsWith("/") || /^[A-Za-z]:\//.test(path)) {
		throw new ContextManagementError(
			"context_management.memory_validation_failure",
			`Memory scope path must be repository-relative: ${JSON.stringify(path)}.`,
		);
	}
	const normalized = posix.normalize(path.replaceAll("\\", "/")).replace(/^\.\//, "");
	if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
		throw new ContextManagementError(
			"context_management.memory_validation_failure",
			`Memory scope path escapes the repository: ${JSON.stringify(path)}.`,
		);
	}
	return normalized;
}

export function canonicalizePaths(paths: readonly string[]): readonly string[] {
	return Object.freeze([...new Set(paths.map(normalizeMemoryPath))].sort());
}

function parseStringArray(value: unknown, field: string): readonly string[] {
	if (!Array.isArray(value)) {
		throw new ContextManagementError("context_management.memory_validation_failure", `${field} must be an array.`);
	}
	return Object.freeze(value.map((item, index) => requiredString(item, `${field}[${index}]`)));
}

export function parseMemoryScope(value: unknown): MemoryScope {
	if (!isRecord(value)) {
		throw new ContextManagementError("context_management.memory_validation_failure", "scope must be an object.");
	}
	const paths = canonicalizePaths(parseStringArray(value.paths, "scope.paths"));
	if (value.kind === "repository") return Object.freeze({ kind: "repository", paths });
	if (value.kind === "branch") {
		return Object.freeze({ kind: "branch", branch: requiredString(value.branch, "scope.branch"), paths });
	}
	throw new ContextManagementError(
		"context_management.memory_validation_failure",
		"scope.kind must be repository or branch.",
	);
}

function parseKind(value: unknown): MemoryKind {
	if (typeof value === "string" && (MEMORY_KINDS as readonly string[]).includes(value)) return value as MemoryKind;
	throw new ContextManagementError("context_management.memory_validation_failure", "Invalid Memory Record kind.");
}

function parseOrigin(value: unknown): MemoryOrigin {
	if (!isRecord(value) || value.trigger !== "primary-agent-tool") {
		throw new ContextManagementError("context_management.memory_validation_failure", "Invalid Memory Record origin.");
	}
	return Object.freeze({
		sessionId: requiredString(value.sessionId, "origin.sessionId"),
		entryId: nullableString(value.entryId, "origin.entryId"),
		gitBranch: nullableString(value.gitBranch, "origin.gitBranch"),
		gitHead: nullableString(value.gitHead, "origin.gitHead"),
		trigger: "primary-agent-tool",
	});
}

export function createMemoryFingerprint(fields: MemoryAuthorFields): string {
	return `sha256:${stableFingerprint({
		contentMarkdown: fields.contentMarkdown.replace(/\r\n?/g, "\n"),
		kind: fields.kind,
		scope: fields.scope,
		summary: fields.summary.normalize("NFKC").replace(/\r\n?/g, "\n"),
		supersedes: [...new Set(fields.supersedes)].sort(),
		title: fields.title.normalize("NFKC").replace(/\r\n?/g, "\n"),
	})}`;
}

export function validateMemoryAuthorFields(fields: MemoryAuthorFields): MemoryAuthorFields {
	const title = requiredString(fields.title.trim(), "title");
	const summary = requiredString(fields.summary.trim(), "summary");
	requiredString(fields.contentMarkdown.trim(), "contentMarkdown");
	const contentMarkdown = requiredString(fields.contentMarkdown, "contentMarkdown");
	if (estimateTextTokens(summary) > MEMORY_SUMMARY_TOKEN_LIMIT) {
		throw new ContextManagementError(
			"context_management.memory_validation_failure",
			`Memory summary exceeds ${MEMORY_SUMMARY_TOKEN_LIMIT} estimated tokens.`,
		);
	}
	const contentBytes = Buffer.byteLength(contentMarkdown, "utf8");
	if (contentBytes > MEMORY_CONTENT_BYTE_LIMIT) {
		throw new ContextManagementError(
			"context_management.memory_content_too_large",
			`Memory content is ${contentBytes} bytes; limit is ${MEMORY_CONTENT_BYTE_LIMIT} bytes.`,
			{ contentBytes, limitBytes: MEMORY_CONTENT_BYTE_LIMIT },
		);
	}
	const supersedes = Object.freeze(
		[...new Set(fields.supersedes.map((id) => requiredString(id, "supersedes")))].sort(),
	);
	return Object.freeze({
		kind: parseKind(fields.kind),
		title,
		summary,
		contentMarkdown,
		scope: parseMemoryScope(fields.scope),
		supersedes,
	});
}

function parseMemoryRecord(value: unknown): MemoryRecord {
	if (!isRecord(value)) {
		throw new ContextManagementError(
			"context_management.memory_validation_failure",
			"Memory record must be an object.",
		);
	}
	const id = requiredString(value.id, "record.id");
	if (!/^mem_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) {
		throw new ContextManagementError("context_management.memory_validation_failure", `Invalid Memory Record ID ${id}.`);
	}
	const kind = parseKind(value.kind);
	const title = requiredString(value.title, "record.title");
	const summary = requiredString(value.summary, "record.summary");
	const contentMarkdown = requiredString(value.contentMarkdown, "record.contentMarkdown");
	const scope = parseMemoryScope(value.scope);
	const supersedes = Object.freeze([...parseStringArray(value.supersedes, "record.supersedes")].sort());
	const parsed: MemoryRecord = Object.freeze({
		id,
		kind,
		title,
		summary,
		contentMarkdown,
		scope,
		origin: parseOrigin(value.origin),
		createdAt: parseIsoDate(value.createdAt, "record.createdAt"),
		fingerprint: requiredString(value.fingerprint, "record.fingerprint"),
		supersedes,
		supersededBy: nullableString(value.supersededBy, "record.supersededBy"),
	});
	validateMemoryAuthorFields({ kind, title, summary, contentMarkdown, scope, supersedes });
	if (parsed.fingerprint !== createMemoryFingerprint(parsed)) {
		throw new ContextManagementError(
			"context_management.memory_validation_failure",
			`Memory Record ${id} has an invalid fingerprint.`,
		);
	}
	return parsed;
}

function parseRepository(value: unknown, expectedKey?: string): RepositoryMetadata {
	if (!isRecord(value)) {
		throw new ContextManagementError("context_management.memory_validation_failure", "repository must be an object.");
	}
	const key = requiredString(value.key, "repository.key");
	if (expectedKey !== undefined && key !== expectedKey) {
		throw new ContextManagementError(
			"context_management.memory_validation_failure",
			`Memory repository key ${key} does not match directory key ${expectedKey}.`,
		);
	}
	if (value.identityKind !== "git-common-dir" && value.identityKind !== "directory") {
		throw new ContextManagementError(
			"context_management.memory_validation_failure",
			"Invalid repository identity kind.",
		);
	}
	return Object.freeze({
		key,
		identityKind: value.identityKind,
		canonicalPath: requiredString(value.canonicalPath, "repository.canonicalPath"),
		createdAt: parseIsoDate(value.createdAt, "repository.createdAt"),
	});
}

export function parseMemoryEnvelope(value: unknown, expectedKey?: string): MemoryEnvelope {
	if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.records)) {
		throw new ContextManagementError(
			"context_management.memory_validation_failure",
			`Memory store must use ${MEMORY_SCHEMA} with schemaVersion 1.`,
		);
	}
	const records = Object.freeze(value.records.map(parseMemoryRecord));
	const byId = new Map<string, MemoryRecord>();
	for (const record of records) {
		if (byId.has(record.id)) {
			throw new ContextManagementError(
				"context_management.memory_validation_failure",
				`Duplicate Memory Record ID ${record.id}.`,
			);
		}
		byId.set(record.id, record);
	}
	for (const record of records) {
		if (record.supersedes.includes(record.id) || record.supersededBy === record.id) {
			throw new ContextManagementError(
				"context_management.memory_validation_failure",
				`Memory Record ${record.id} has a self-reference.`,
			);
		}
		for (const oldId of record.supersedes) {
			const old = byId.get(oldId);
			if (old === undefined || old.supersededBy !== record.id) {
				throw new ContextManagementError(
					"context_management.memory_validation_failure",
					`Memory supersession ${record.id} -> ${oldId} is not reciprocal.`,
				);
			}
		}
		if (record.supersededBy !== null) {
			const newer = byId.get(record.supersededBy);
			if (newer === undefined || !newer.supersedes.includes(record.id)) {
				throw new ContextManagementError(
					"context_management.memory_validation_failure",
					`Memory supersededBy relation for ${record.id} is dangling.`,
				);
			}
		}
	}
	return Object.freeze({
		schemaVersion: 1,
		repository: parseRepository(value.repository, expectedKey),
		records,
	});
}

export function serializeMemoryEnvelope(envelope: MemoryEnvelope): string {
	const parsed = parseMemoryEnvelope(envelope, envelope.repository.key);
	const text = `${JSON.stringify(parsed, null, 2)}\n`;
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes > MEMORY_STORE_BYTE_LIMIT) {
		throw new ContextManagementError(
			"context_management.memory_store_too_large",
			`Candidate memory store is ${bytes} bytes; limit is ${MEMORY_STORE_BYTE_LIMIT} bytes.`,
			{ candidateBytes: bytes, limitBytes: MEMORY_STORE_BYTE_LIMIT },
		);
	}
	return text;
}

export function createUuidV7(now = Date.now()): string {
	if (!Number.isSafeInteger(now) || now < 0 || now > 0xffffffffffff) throw new RangeError("Invalid UUIDv7 time.");
	const bytes = randomBytes(16);
	let timestamp = BigInt(now);
	for (let index = 5; index >= 0; index -= 1) {
		bytes[index] = Number(timestamp & 0xffn);
		timestamp >>= 8n;
	}
	bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x70, 6);
	bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createMemoryId(now = Date.now()): string {
	return `${MEMORY_ID_PREFIX}${createUuidV7(now)}`;
}
