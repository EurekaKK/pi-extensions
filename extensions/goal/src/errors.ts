const MAX_ERROR_CHARACTERS = 500;

const SECRET_PATTERNS: readonly RegExp[] = [
	/(authorization\s*[:=]\s*)([^\s,;]+)/giu,
	/(bearer\s+)([a-z0-9._~+/-]+)/giu,
	/((?:api[_ -]?key|token|secret|password)\s*[:=]\s*)([^\s,;]+)/giu,
];

export function sanitizeGoalError(error: unknown): string {
	let message = error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown goal error.";
	for (const pattern of SECRET_PATTERNS) {
		message = message.replace(pattern, "$1[redacted]");
	}
	message = [...message]
		.filter((character) => {
			const code = character.codePointAt(0) ?? 0;
			return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
		})
		.join("")
		.trim();
	if (message.length === 0) return "Unknown goal error.";
	const characters = [...message];
	return characters.length <= MAX_ERROR_CHARACTERS
		? message
		: `${characters.slice(0, MAX_ERROR_CHARACTERS - 1).join("")}…`;
}
