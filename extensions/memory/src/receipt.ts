import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { MemoryReadOutcome, MemoryWriteOutcome } from "./service.js";
import type { MemoryRecordV1 } from "./store.js";

/** Stable structured receipt for every successful `memory_write` call. */
export interface MemoryWriteReceiptV1 {
	readonly kind: "memory:write-receipt";
	readonly version: 1;
	readonly operation: "add" | "supersede";
	readonly outcome: "added" | "no-op" | "superseded";
	readonly record: MemoryRecordV1;
	/** The exact superseded target; present only for a committed supersession. */
	readonly replaced?: MemoryRecordV1;
	readonly storeRevision: number;
	readonly previousStoreRevision?: number;
	readonly ignoreMarker?: "created" | "preserved";
}

export function makeWriteReceipt(outcome: MemoryWriteOutcome, operation: "add" | "supersede"): MemoryWriteReceiptV1 {
	if (outcome.kind === "no-op") {
		return {
			kind: "memory:write-receipt",
			version: 1,
			operation,
			outcome: "no-op",
			record: outcome.record,
			storeRevision: outcome.storeRevision,
		};
	}
	if (outcome.kind === "superseded") {
		return {
			kind: "memory:write-receipt",
			version: 1,
			operation,
			outcome: "superseded",
			record: outcome.record,
			replaced: outcome.replaced,
			storeRevision: outcome.storeRevision,
			previousStoreRevision: outcome.previousStoreRevision,
			...(outcome.ignoreMarker === null ? {} : { ignoreMarker: outcome.ignoreMarker }),
		};
	}
	return {
		kind: "memory:write-receipt",
		version: 1,
		operation,
		outcome: "added",
		record: outcome.record,
		storeRevision: outcome.storeRevision,
		previousStoreRevision: outcome.previousStoreRevision,
		...(outcome.ignoreMarker === null ? {} : { ignoreMarker: outcome.ignoreMarker }),
	};
}

/** Stable structured result for every successful `memory_read` call. */
export interface MemoryReadResultV1 {
	readonly kind: "memory:read-result";
	readonly version: 1;
	readonly found: true;
	readonly record: MemoryRecordV1;
}

export function makeReadResult(outcome: MemoryReadOutcome): MemoryReadResultV1 {
	return { kind: "memory:read-result", version: 1, found: true, record: outcome.record };
}

function recordHeader(record: MemoryRecordV1): string {
	const entry = record.provenance.entryId === undefined ? "" : ` · entry ${record.provenance.entryId}`;
	return [
		`Record: ${record.id}`,
		`Revision: ${record.revision}`,
		`State: ${record.state}`,
		`Directory: ${record.provenance.directoryId}`,
		`Provenance: session ${record.provenance.sessionId}${entry} · ${record.provenance.author}`,
	].join("\n");
}

/** Full-content receipt text returned to the model on every write (add, no-op, or supersede). */
export function renderWriteReceiptText(receipt: MemoryWriteReceiptV1): string {
	const record = receipt.record;
	if (receipt.outcome === "no-op") {
		const prefix =
			receipt.operation === "supersede"
				? "memory_write · no-op (identical correction: the replacement matches the target record; Store unchanged)"
				: "memory_write · no-op (identical memory is already present; Store unchanged)";
		return [prefix, "", recordHeader(record), "", `Summary: ${record.summary}`, `Content:\n${record.content}`].join(
			"\n",
		);
	}
	if (receipt.outcome === "superseded") {
		const replaced = receipt.replaced;
		if (replaced === undefined) {
			// Defensive: a committed supersession always carries its replaced record.
			return "memory_write · superseded (replaced record details unavailable)";
		}
		return [
			`memory_write · superseded (Store revision ${receipt.previousStoreRevision ?? "new"} → ${receipt.storeRevision})`,
			"",
			recordHeader(record),
			`Supersedes: ${record.supersedes?.id ?? "?"} revision ${record.supersedes?.revision ?? "?"}`,
			"",
			`Summary: ${record.summary}`,
			`Content:\n${record.content}`,
			"",
			"Replaced record (superseded; preserved for historical inspection):",
			"",
			recordHeader(replaced),
			"",
			`Summary: ${replaced.summary}`,
			`Content:\n${replaced.content}`,
		].join("\n");
	}
	const prefix = `memory_write · added (Store revision ${receipt.previousStoreRevision ?? "new"} → ${receipt.storeRevision})`;
	return [prefix, "", recordHeader(record), "", `Summary: ${record.summary}`, `Content:\n${record.content}`].join("\n");
}

/** Text for a successful `memory_read` result. */
export function renderReadResultText(result: MemoryReadResultV1): string {
	const record = result.record;
	return [
		"memory_read · exact record",
		"",
		recordHeader(record),
		"",
		`Summary: ${record.summary}`,
		`Content:\n${record.content}`,
	].join("\n");
}

export function renderMemoryFailure(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Extract model-visible text from a tool result for fallback rendering. */
export function resultText(result: {
	readonly content: readonly { readonly type: string; readonly text?: string }[];
}): string {
	return result.content
		.filter(
			(block): block is { readonly type: "text"; readonly text: string } =>
				block.type === "text" && typeof block.text === "string",
		)
		.map((block) => block.text)
		.join("\n");
}

class BoundedLinesComponent implements Component {
	readonly #lines: readonly string[];

	constructor(lines: readonly string[]) {
		this.#lines = lines;
	}

	render(width: number): string[] {
		return this.#lines.map((line) => truncateToWidth(line, Math.max(1, width)));
	}

	invalidate(): void {}
}

/** Width-bounded single/highlighting lines for compact tool calls. */
export function compactLines(lines: readonly string[]): Component {
	return new BoundedLinesComponent(lines);
}

function renderToolResult(
	result: {
		readonly content: readonly { readonly type: string; readonly text?: string }[];
		readonly details?: unknown;
	},
	expanded: boolean,
	theme: Theme,
	isError: boolean,
): Component {
	const raw = resultText(result);
	if (isError) {
		if (expanded) return new Text(theme.fg("error", raw), 0, 0);
		return new BoundedLinesComponent([theme.fg("error", raw.split("\n", 1)[0] ?? "memory operation failed")]);
	}
	if (expanded) return new Text(theme.fg("text", raw), 0, 0);
	return new BoundedLinesComponent(raw.split("\n", 4).map((line) => theme.fg("success", line)));
}

/** Compact fallback renderer shared by `memory_write` and `memory_read`. */
export function renderMemoryToolResult(
	result: {
		readonly content: readonly { readonly type: string; readonly text?: string }[];
		readonly details?: unknown;
	},
	expanded: boolean,
	theme: Theme,
	isError: boolean,
): Component {
	return renderToolResult(result, expanded, theme, isError);
}
