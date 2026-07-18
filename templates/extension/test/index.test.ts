import { describe, expect, it } from "vitest";
import extensionName from "../src/index.js";

describe("extension-name", () => {
	it("exports an extension factory", () => {
		expect(extensionName).toBeTypeOf("function");
	});
});
