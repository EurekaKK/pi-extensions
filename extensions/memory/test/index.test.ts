import { describe, expect, it } from "vitest";
import memory from "../index.js";
import sourceEntry from "../src/index.js";

describe("memory", () => {
	it("exports the source factory through the root naming adapter", () => {
		expect(memory).toBeTypeOf("function");
		expect(memory).toBe(sourceEntry);
	});
});
