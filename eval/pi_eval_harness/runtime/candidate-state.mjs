#!/usr/bin/env node
import { readFileSync } from "node:fs";

const tracePath = process.argv[2];
if (typeof tracePath !== "string" || tracePath.length === 0) {
	console.error("usage: candidate-state.mjs TRACE_PATH");
	process.exit(64);
}

const phases = new Set(["started", "ready", "installed", "discarded", "failed"]);
let latest = "none";
let text = "";
try {
	text = readFileSync(tracePath, "utf8");
} catch {
	process.stdout.write("none\n");
	process.exit(0);
}
for (const line of text.split("\n")) {
	if (line.trim().length === 0) continue;
	try {
		const record = JSON.parse(line);
		if (record?.event === "candidate_lifecycle" && phases.has(record?.data?.phase)) {
			latest = record.data.phase;
		}
	} catch {
		// The live trace may end with one partial record.
	}
}
process.stdout.write(`${latest}\n`);
