import { describe, expect, it } from "vitest";
import { stableFingerprint, stableJson } from "../src/stable-json.js";

describe("stable JSON", () => {
	it("sorts object keys, keeps array order, and normalizes line endings", () => {
		expect(stableJson({ z: [2, 1], a: "x\r\ny" })).toBe('{"a":"x\\ny","z":[2,1]}');
	});

	it("distinguishes numbers from numeric strings", () => {
		expect(stableFingerprint({ value: 1 })).not.toBe(stableFingerprint({ value: "1" }));
	});

	it("rejects cycles and non-finite values", () => {
		const value: Record<string, unknown> = {};
		value.self = value;
		expect(() => stableJson(value)).toThrow(/Cyclic/);
		const array: unknown[] = [];
		array.push(array);
		expect(() => stableJson(array)).toThrow(/Cyclic/);
		expect(() => stableJson({ value: Number.NaN })).toThrow(/Non-finite/);
	});
});
