#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const sessionsDir = process.argv[2];
if (typeof sessionsDir !== "string" || sessionsDir.length === 0) {
	console.error("usage: goal-settlement.mjs SESSIONS_DIR [MINIMUM_STOP_COUNT]");
	process.exit(64);
}
const minimumStopCount = Number.parseInt(process.argv[3] ?? "0", 10);
if (!Number.isSafeInteger(minimumStopCount) || minimumStopCount < 0) {
	console.error("MINIMUM_STOP_COUNT must be a non-negative integer");
	process.exit(64);
}

function readEntries(dir) {
	let names;
	try {
		names = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
	} catch {
		return [];
	}
	const entries = [];
	for (const name of names) {
		let text;
		try {
			text = readFileSync(join(dir, name), "utf8");
		} catch {
			continue;
		}
		for (const line of text.split("\n")) {
			if (line.trim().length === 0) continue;
			try {
				entries.push(JSON.parse(line));
			} catch {
				// The live session file may end with a partial line.
			}
		}
	}
	return entries;
}

function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function latestGoalPhase(change, current) {
	if (!isRecord(change) || change.kind !== "goal/change") return current;
	if (change.operation === "clear") return undefined;
	if (!isRecord(change.goal)) return current;
	const phase = change.goal.phase;
	if (phase === "active" || phase === "paused" || phase === "blocked" || phase === "complete") {
		return phase;
	}
	return current;
}

const entries = readEntries(sessionsDir);
let phase;
let lastStopIndex = -1;
let lastUserIndex = -1;
let stopCount = 0;
let roundAfterStop = false;

for (let index = 0; index < entries.length; index += 1) {
	const entry = entries[index];
	if (!isRecord(entry)) continue;
	if (entry.type === "custom" && entry.customType === "goal:change") {
		phase = latestGoalPhase(entry.data, phase);
		continue;
	}
	if (entry.type === "custom" && entry.customType === "goal:round") {
		if (lastStopIndex >= 0 && index > lastStopIndex) roundAfterStop = true;
		continue;
	}
	if (entry.type !== "message" || !isRecord(entry.message)) continue;
	if (entry.message.role === "user") {
		lastUserIndex = index;
		continue;
	}
	if (entry.message.role === "assistant" && entry.message.stopReason === "stop") {
		stopCount += 1;
		lastStopIndex = index;
		roundAfterStop = false;
	}
}

let state = "running";
if (stopCount > minimumStopCount && lastStopIndex >= 0 && lastStopIndex > lastUserIndex) {
	if (phase !== "active") state = "quit";
	else if (roundAfterStop) state = "driven";
	else state = "armed";
}

process.stdout.write(`${state}\n`);
