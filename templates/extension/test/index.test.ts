import { describe, expect, it } from "vitest";
import extensionName from "../index.js";
import sourceEntry from "../src/index.js";

describe("extension-name", () => {
	it("exports the source factory through the root naming adapter", () => {
		expect(extensionName).toBeTypeOf("function");
		expect(extensionName).toBe(sourceEntry);
	});
});
