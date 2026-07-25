import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const FIXTURE_STATE_KEY = Symbol.for("pi-sub-agent-worker-fixture");

interface FixtureState {
	factoryCount: number;
	shutdownCount: number;
}

function fixtureState(): FixtureState {
	const globalRecord = globalThis as typeof globalThis & {
		[FIXTURE_STATE_KEY]?: FixtureState;
	};
	globalRecord[FIXTURE_STATE_KEY] ??= { factoryCount: 0, shutdownCount: 0 };
	return globalRecord[FIXTURE_STATE_KEY];
}

export default function workerFixtureExtension(pi: ExtensionAPI): void {
	const state = fixtureState();
	state.factoryCount++;

	pi.registerTool({
		name: "worker_fixture_echo",
		label: "Worker fixture echo",
		description: "Returns the supplied fixture text.",
		parameters: Type.Object({ text: Type.String() }),
		async execute(_toolCallId, input) {
			return {
				content: [{ type: "text", text: input.text }],
				details: { echoed: input.text },
			};
		},
	});

	pi.on("input", (event) => {
		if (event.text === "fixture:handled") return { action: "handled" };
		return { action: "continue" };
	});

	pi.on("session_shutdown", () => {
		state.shutdownCount++;
	});
}
