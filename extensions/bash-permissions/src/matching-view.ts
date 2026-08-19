const MAX_WRAPPER_LAYERS = 12;
const MAX_WRAPPER_OPTIONS = 16;
const MAX_EXEC_OPTIONS = 8;
const WRAPPER_PATH = /^(?:\/(?:usr\/)?s?bin\/)/;
const ASSIGNMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*=/;

const SUDO_CLUSTER_FLAGS = new Set("ABbEHkNnPSis");
const SUDO_ARG_FLAGS = new Set("CDRTUghprtu");
const SUDO_LONG_FLAGS = new Set([
	"askpass",
	"background",
	"bell",
	"preserve-env",
	"set-home",
	"login",
	"non-interactive",
	"preserve-groups",
	"reset-timestamp",
	"stdin",
	"shell",
]);
const SUDO_LONG_ARG_FLAGS = new Set([
	"close-from",
	"chdir",
	"group",
	"host",
	"prompt",
	"chroot",
	"command-timeout",
	"user",
	"role",
	"type",
]);

const DOAS_CLUSTER_FLAGS = new Set("Lns");
const DOAS_ARG_FLAGS = new Set("aCu");

export function matchingView(command: string): string {
	return peelWrappers(removeBashLineContinuations(command));
}

function peelWrappers(text: string): string {
	let rest = text;
	for (let layer = 0; layer < MAX_WRAPPER_LAYERS; layer += 1) {
		const peeled = peelOneWrapper(rest);
		if (peeled === undefined) break;
		rest = peeled;
	}
	return rest;
}

function peelOneWrapper(text: string): string | undefined {
	const start = skipHorizontalSpace(text, 0);
	return (
		peelBang(text, start) ??
		peelAssignment(text, start) ??
		peelSimpleWrapper(text, start, ["command"], (index) =>
			consumeOptionalFlags(text, index, { short: "p", allowEndOfOptions: true }),
		) ??
		peelSimpleWrapper(text, start, ["time"], (index) =>
			consumeOptionalFlags(text, index, { short: "p", allowEndOfOptions: true }),
		) ??
		peelSimpleWrapper(text, start, ["nohup"], (index) =>
			consumeOptionalFlags(text, index, { allowEndOfOptions: true }),
		) ??
		peelSimpleWrapper(text, start, ["exec"], (index) => consumeExecOptions(text, index)) ??
		peelSimpleWrapper(text, start, ["env"], (index) => consumeEnvOptions(text, index)) ??
		peelSimpleWrapper(text, start, ["sudo"], (index) => consumeSudoOptions(text, index)) ??
		peelSimpleWrapper(text, start, ["doas"], (index) => consumeDoasOptions(text, index))
	);
}

function peelBang(text: string, start: number): string | undefined {
	if (text[start] !== "!") return undefined;
	const afterBang = start + 1;
	if (text[afterBang] !== " " && text[afterBang] !== "\t") return undefined;
	const rest = skipHorizontalSpace(text, afterBang);
	return rest > afterBang && rest < text.length ? text.slice(rest) : undefined;
}

function peelAssignment(text: string, start: number): string | undefined {
	const name = ASSIGNMENT_NAME.exec(text.slice(start));
	if (name === null) return undefined;
	const value = readQuotedOrBare(text, start + name[0].length, true);
	if (value === undefined) return undefined;
	const rest = skipHorizontalSpace(text, value.end);
	if (rest === value.end || rest >= text.length) return undefined;
	return text.slice(rest);
}

function peelSimpleWrapper(
	text: string,
	start: number,
	names: readonly string[],
	consumeOptions: (index: number) => number | undefined,
): string | undefined {
	const matched = matchWrapperToken(text, start, names);
	if (matched === undefined) return undefined;
	const afterOptions = consumeOptions(matched.end);
	if (afterOptions === undefined) return undefined;
	const rest = skipHorizontalSpace(text, afterOptions);
	if (rest === afterOptions || rest >= text.length) return undefined;
	return text.slice(rest);
}

function matchWrapperToken(
	text: string,
	start: number,
	names: readonly string[],
): { readonly name: string; readonly end: number } | undefined {
	const path = WRAPPER_PATH.exec(text.slice(start));
	const nameStart = start + (path?.[0].length ?? 0);
	for (const name of names) {
		if (!text.startsWith(name, nameStart)) continue;
		const end = nameStart + name.length;
		if (isTokenBoundary(text[end])) return { name, end };
	}
	return undefined;
}

function isTokenBoundary(character: string | undefined): boolean {
	return character === undefined || character === " " || character === "\t" || isTerminator(character);
}

function isTerminator(character: string | undefined): boolean {
	return (
		character === undefined ||
		character === ";" ||
		character === "&" ||
		character === "|" ||
		character === ")" ||
		character === "}" ||
		character === "`" ||
		character === "\n" ||
		character === "\r"
	);
}

function consumeOptionalFlags(
	text: string,
	index: number,
	options: { readonly short?: string; readonly allowEndOfOptions: boolean },
): number {
	let cursor = index;
	const afterSpace = skipHorizontalSpace(text, cursor);
	if (
		options.short !== undefined &&
		text[afterSpace] === "-" &&
		text[afterSpace + 1] === options.short &&
		isTokenBoundary(text[afterSpace + 2])
	) {
		cursor = afterSpace + 2;
	}
	const forEnd = skipHorizontalSpace(text, cursor);
	if (options.allowEndOfOptions && text.startsWith("--", forEnd) && isTokenBoundary(text[forEnd + 2])) {
		return forEnd + 2;
	}
	return cursor;
}

function consumeExecOptions(text: string, index: number): number | undefined {
	let cursor = index;
	for (let count = 0; count < MAX_EXEC_OPTIONS; count += 1) {
		const next = skipHorizontalSpace(text, cursor);
		if (text[next] !== "-") break;
		if (text.startsWith("--", next) && isTokenBoundary(text[next + 2])) {
			return next + 2;
		}
		if (/^-[cl]+(?=$|[\s;&|)`])/.test(text.slice(next))) {
			const match = /^-[cl]+/.exec(text.slice(next));
			if (match === null) return undefined;
			cursor = next + match[0].length;
			continue;
		}
		if (text.startsWith("-a", next) && (text[next + 2] === " " || text[next + 2] === "\t")) {
			const arg = readQuotedOrBare(text, skipHorizontalSpace(text, next + 2), false);
			if (arg === undefined) return undefined;
			cursor = arg.end;
			continue;
		}
		break;
	}
	return cursor;
}

function consumeEnvOptions(text: string, index: number): number | undefined {
	let cursor = index;
	for (let count = 0; count < MAX_WRAPPER_OPTIONS; count += 1) {
		const next = skipHorizontalSpace(text, cursor);
		if (text.startsWith("--", next)) {
			if (isTokenBoundary(text[next + 2])) return next + 2;
			const long =
				consumeLongFlag(text, next, ["ignore-environment", "null"], false) ??
				consumeLongFlag(text, next, ["unset", "chdir", "split-string", "argv0"], true);
			if (long === undefined) return undefined;
			cursor = long;
			continue;
		}
		if (text[next] === "-" && text[next + 1] !== undefined && text[next + 1] !== "-") {
			const flag = text[next + 1];
			if ((flag === "i" || flag === "0") && isTokenBoundary(text[next + 2])) {
				cursor = next + 2;
				continue;
			}
			if ((flag === "u" || flag === "C" || flag === "S" || flag === "a") && isTokenBoundary(text[next + 2])) {
				const arg = readQuotedOrBare(text, skipHorizontalSpace(text, next + 2), false);
				if (arg === undefined) return undefined;
				cursor = arg.end;
				continue;
			}
			return undefined;
		}
		if (ASSIGNMENT_NAME.test(text.slice(next))) {
			const assignment = peelAssignmentRemainder(text, next);
			if (assignment === undefined) return undefined;
			cursor = assignment;
			continue;
		}
		break;
	}
	return cursor;
}

function consumeSudoOptions(text: string, index: number): number | undefined {
	let cursor = index;
	for (let count = 0; count < MAX_WRAPPER_OPTIONS; count += 1) {
		const next = skipHorizontalSpace(text, cursor);
		if (text.startsWith("--", next)) {
			if (isTokenBoundary(text[next + 2])) return next + 2;
			const long =
				consumeLongFlag(text, next, [...SUDO_LONG_FLAGS], false) ??
				consumeLongFlag(text, next, [...SUDO_LONG_ARG_FLAGS], true);
			if (long === undefined) return undefined;
			cursor = long;
			continue;
		}
		if (text[next] === "-" && text[next + 1] !== undefined && text[next + 1] !== "-") {
			const body = readFlagBody(text, next + 1);
			if (body === undefined) return undefined;
			if (body.letters.length === 1 && SUDO_ARG_FLAGS.has(body.letters)) {
				const arg = readQuotedOrBare(text, skipHorizontalSpace(text, body.end), false);
				if (arg === undefined) return undefined;
				cursor = arg.end;
				continue;
			}
			if ([...body.letters].every((letter) => SUDO_CLUSTER_FLAGS.has(letter))) {
				cursor = body.end;
				continue;
			}
			return undefined;
		}
		if (ASSIGNMENT_NAME.test(text.slice(next))) {
			const assignment = peelAssignmentRemainder(text, next);
			if (assignment === undefined) return undefined;
			cursor = assignment;
			continue;
		}
		break;
	}
	return cursor;
}

function consumeDoasOptions(text: string, index: number): number | undefined {
	let cursor = index;
	for (let count = 0; count < MAX_WRAPPER_OPTIONS; count += 1) {
		const next = skipHorizontalSpace(text, cursor);
		if (text.startsWith("--", next) && isTokenBoundary(text[next + 2])) {
			return next + 2;
		}
		if (text[next] !== "-" || text[next + 1] === undefined || text[next + 1] === "-") break;
		const body = readFlagBody(text, next + 1);
		if (body === undefined) return undefined;
		if (body.letters.length === 1 && DOAS_ARG_FLAGS.has(body.letters)) {
			const arg = readQuotedOrBare(text, skipHorizontalSpace(text, body.end), false);
			if (arg === undefined) return undefined;
			cursor = arg.end;
			continue;
		}
		if ([...body.letters].every((letter) => DOAS_CLUSTER_FLAGS.has(letter))) {
			cursor = body.end;
			continue;
		}
		return undefined;
	}
	return cursor;
}

function consumeLongFlag(text: string, index: number, names: readonly string[], takesArg: boolean): number | undefined {
	if (!text.startsWith("--", index)) return undefined;
	const nameStart = index + 2;
	for (const name of names) {
		if (!text.startsWith(name, nameStart)) continue;
		const afterName = nameStart + name.length;
		if (takesArg) {
			if (text[afterName] === "=") {
				const arg = readQuotedOrBare(text, afterName + 1, false);
				return arg?.end;
			}
			if (text[afterName] === " " || text[afterName] === "\t") {
				const arg = readQuotedOrBare(text, skipHorizontalSpace(text, afterName), false);
				return arg?.end;
			}
			return undefined;
		}
		if (name === "preserve-env" && text[afterName] === "=") {
			const arg = readQuotedOrBare(text, afterName + 1, true);
			return arg?.end;
		}
		if (isTokenBoundary(text[afterName])) return afterName;
	}
	return undefined;
}

function readFlagBody(text: string, index: number): { readonly letters: string; readonly end: number } | undefined {
	let end = index;
	while (end < text.length && /[A-Za-z]/.test(text[end] ?? "")) end += 1;
	if (end === index) return undefined;
	return { letters: text.slice(index, end), end };
}

function peelAssignmentRemainder(text: string, start: number): number | undefined {
	const name = ASSIGNMENT_NAME.exec(text.slice(start));
	if (name === null) return undefined;
	const value = readQuotedOrBare(text, start + name[0].length, true);
	return value?.end;
}

function readQuotedOrBare(text: string, index: number, allowEmptyBare: boolean): { readonly end: number } | undefined {
	if (text[index] === '"') {
		let cursor = index + 1;
		while (cursor < text.length) {
			if (text[cursor] === "\\" && cursor + 1 < text.length) {
				cursor += 2;
				continue;
			}
			if (text[cursor] === '"') return { end: cursor + 1 };
			cursor += 1;
		}
		return undefined;
	}
	if (text[index] === "'") {
		const closing = text.indexOf("'", index + 1);
		if (closing === -1) return undefined;
		return { end: closing + 1 };
	}
	let end = index;
	while (end < text.length && !/[ \t;&|)`]/.test(text[end] ?? "")) end += 1;
	if (end === index && !allowEmptyBare) return undefined;
	return { end };
}

function skipHorizontalSpace(text: string, index: number): number {
	let cursor = index;
	while (cursor < text.length && (text[cursor] === " " || text[cursor] === "\t")) cursor += 1;
	return cursor;
}

function removeBashLineContinuations(command: string): string {
	type Quote = "single" | "double";
	interface LexicalFrame {
		quote: Quote | undefined;
		readonly terminator: ")" | "`" | undefined;
		parenthesisDepth: number;
	}

	const frames: LexicalFrame[] = [{ quote: undefined, terminator: undefined, parenthesisDepth: 0 }];
	let joined = "";
	for (let index = 0; index < command.length; index += 1) {
		const character = command[index];
		const frame = frames.at(-1);
		if (frame === undefined) {
			throw new Error("bash-permissions 内部错误：Bash 词法栈为空。");
		}

		if (character === "\\" && (frame.quote !== "single" || frame.terminator === "`")) {
			const next = command[index + 1];
			if (next === "\n") {
				index += 1;
				continue;
			}
			if (next === "\r" && command[index + 2] === "\n") {
				index += 2;
				continue;
			}
			if (next !== undefined) {
				joined += character + next;
				index += 1;
				continue;
			}
		}

		if (frame.quote === "single") {
			if (character === "'") {
				frame.quote = undefined;
			}
			joined += character;
			continue;
		}

		if (character === '"') {
			frame.quote = frame.quote === "double" ? undefined : "double";
			joined += character;
			continue;
		}
		if (character === "'" && frame.quote === undefined) {
			frame.quote = "single";
			joined += character;
			continue;
		}

		const next = command[index + 1];
		if (character === "$" && next === "(") {
			joined += "$(";
			frames.push({ quote: undefined, terminator: ")", parenthesisDepth: 0 });
			index += 1;
			continue;
		}
		if (frame.quote === undefined && (character === "<" || character === ">") && next === "(") {
			joined += `${character}(`;
			frames.push({ quote: undefined, terminator: ")", parenthesisDepth: 0 });
			index += 1;
			continue;
		}
		if (character === "`") {
			joined += character;
			if (frame.quote === undefined && frame.terminator === "`") {
				frames.pop();
			} else {
				frames.push({ quote: undefined, terminator: "`", parenthesisDepth: 0 });
			}
			continue;
		}

		if (frame.quote === undefined && frame.terminator === ")") {
			if (character === "(") {
				frame.parenthesisDepth += 1;
			} else if (character === ")") {
				if (frame.parenthesisDepth === 0) {
					frames.pop();
				} else {
					frame.parenthesisDepth -= 1;
				}
			}
		}
		joined += character;
	}
	return joined;
}
