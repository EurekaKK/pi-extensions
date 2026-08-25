import { randomUUID } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { FileMutationQueue } from "./config.js";
import { CONFIG_DIRECTORY_MODE, CONFIG_FILE_MODE } from "./config.js";
import { SPILL_RETRIEVAL_HINT } from "./constants.js";
import { sha256Hex } from "./stable-json.js";

type ToolResultContent = TextContent | ImageContent;

function flattenPlainText(content: readonly ToolResultContent[]): string | undefined {
	let text = "";
	for (const block of content) {
		if (block.type !== "text") return undefined;
		text += block.text;
	}
	return text;
}

function sanitizeToolName(toolName: string): string {
	const sanitized = toolName.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 64);
	return sanitized.length === 0 ? "tool" : sanitized;
}

function sessionKey(sessionId: string): string {
	return sha256Hex(sessionId).slice(0, 16);
}

function utf8HeadTail(text: string, headBytes: number, tailBytes: number): { text: string; omitted: number } {
	const buffer = Buffer.from(text, "utf8");
	if (headBytes + tailBytes >= buffer.byteLength) return { text, omitted: 0 };
	const head = buffer.subarray(0, Math.max(0, headBytes)).toString("utf8");
	const tail = buffer.subarray(buffer.byteLength - Math.max(0, tailBytes)).toString("utf8");
	const kept = Buffer.byteLength(head, "utf8") + Buffer.byteLength(tail, "utf8");
	return { text: `${head}${tail}`, omitted: Math.max(0, buffer.byteLength - kept) };
}

function spillNotice(omitted: number, locator: string): string {
	return `(Omitted ${omitted} bytes. Full formatted result stored at: ${locator}. ${SPILL_RETRIEVAL_HINT})`;
}

export function spillRoot(agentDir: string): string {
	return join(agentDir, "context-management", "spill");
}

export async function maybeSpillToolResult(input: {
	readonly event: ToolResultEvent;
	readonly sessionId: string;
	readonly agentDir: string;
	readonly maxInlineBytes: number;
	readonly withFileMutationQueue: FileMutationQueue;
}): Promise<{ content: Array<TextContent | ImageContent> } | undefined> {
	if (input.event.toolName === "read") return undefined;
	const text = flattenPlainText(input.event.content);
	if (text === undefined) return undefined;
	const totalBytes = Buffer.byteLength(text, "utf8");
	if (totalBytes <= input.maxInlineBytes) return undefined;

	const directory = join(spillRoot(input.agentDir), sessionKey(input.sessionId));
	const fileName = `${sanitizeToolName(input.event.toolName)}-${randomUUID()}.txt`;
	const filePath = join(directory, fileName);
	try {
		await input.withFileMutationQueue(filePath, async () => {
			const root = spillRoot(input.agentDir);
			await mkdir(root, { recursive: true, mode: CONFIG_DIRECTORY_MODE });
			await chmod(root, CONFIG_DIRECTORY_MODE);
			await mkdir(directory, { recursive: true, mode: CONFIG_DIRECTORY_MODE });
			await chmod(directory, CONFIG_DIRECTORY_MODE);
			await writeFile(filePath, text, { encoding: "utf8", mode: CONFIG_FILE_MODE });
			await chmod(filePath, CONFIG_FILE_MODE);
		});
	} catch {
		return undefined;
	}

	const reserve = Buffer.byteLength(spillNotice(totalBytes, filePath), "utf8") + 2;
	const previewBudget = Math.max(0, input.maxInlineBytes - reserve);
	const headBytes = Math.ceil(previewBudget / 2);
	const tailBytes = Math.floor(previewBudget / 2);
	const preview = utf8HeadTail(text, headBytes, tailBytes);
	const notice = spillNotice(preview.omitted === 0 ? totalBytes : preview.omitted, filePath);
	const replacedText = preview.text.length > 0 ? `${preview.text}\n\n${notice}` : notice;
	if (Buffer.byteLength(replacedText, "utf8") > input.maxInlineBytes) return undefined;
	return { content: [{ type: "text", text: replacedText }] };
}
