import { createHash } from "node:crypto";

function normalizeValue(value: unknown, seen: Set<object>): unknown {
	if (value === null || typeof value === "boolean" || typeof value === "string") {
		return typeof value === "string" ? value.replace(/\r\n?/g, "\n") : value;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new TypeError("Non-finite numbers cannot be stably serialized.");
		return value;
	}
	if (Array.isArray(value)) {
		if (seen.has(value)) throw new TypeError("Cyclic values cannot be stably serialized.");
		seen.add(value);
		try {
			return value.map((item) => normalizeValue(item, seen));
		} finally {
			seen.delete(value);
		}
	}
	if (typeof value !== "object" || value === undefined) {
		throw new TypeError(`Unsupported stable JSON value: ${typeof value}.`);
	}
	if (seen.has(value)) throw new TypeError("Cyclic values cannot be stably serialized.");
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		throw new TypeError("Only plain objects can be stably serialized.");
	}
	seen.add(value);
	try {
		const record = value as Record<string, unknown>;
		const result: Record<string, unknown> = {};
		for (const key of Object.keys(record).sort()) {
			const item = record[key];
			if (item === undefined) throw new TypeError("Undefined object values cannot be stably serialized.");
			result[key] = normalizeValue(item, seen);
		}
		return result;
	} finally {
		seen.delete(value);
	}
}

export function stableJson(value: unknown): string {
	return JSON.stringify(normalizeValue(value, new Set()));
}

export function sha256Hex(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

export function stableFingerprint(value: unknown): string {
	return sha256Hex(stableJson(value));
}
