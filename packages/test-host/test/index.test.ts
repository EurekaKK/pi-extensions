import { describe, expect, it, vi } from "vitest";
import { FakePiHost } from "../src/index.js";

describe("FakePiHost", () => {
	it("delivers event bus messages and supports unsubscribe", () => {
		const host = new FakePiHost();
		const handler = vi.fn();
		const unsubscribe = host.api.events.on("test:event", handler);

		host.api.events.emit("test:event", { value: 1 });
		expect(handler).toHaveBeenCalledWith({ value: 1 });
		unsubscribe();
		host.api.events.emit("test:event", { value: 2 });
		expect(handler).toHaveBeenCalledTimes(1);
	});

	it("captures and invokes extension shortcuts", async () => {
		const host = new FakePiHost();
		const handler = vi.fn();
		host.api.registerShortcut("ctrl+alt+o", { description: "Switch view", handler });

		await host.invokeShortcut("ctrl+alt+o");
		expect(handler).toHaveBeenCalledWith(host.context);
	});
});
