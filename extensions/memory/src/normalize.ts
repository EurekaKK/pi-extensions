/**
 * Deterministic normalization and capture-policy validation for Memory Record
 * text (summary + content).
 *
 * Every write normalizes input with NFC plus CRLF/CR → LF line-ending folding
 * before any comparison, so two textual forms that render identically are the
 * same memory and land on disk byte-for-byte identically across sessions and
 * platforms. Input that violates capture policy (blank, control characters,
 * secret-like patterns) is rejected before any Store mutation.
 */

/**
 * Fold CRLF and lone CR into LF, then apply NFC composition. Deterministic and
 * idempotent: applying it twice changes nothing.
 */
export function normalizeRecordText(value: string): string {
	return value.replace(/\r\n?/gu, "\n").normalize("NFC");
}

/** Count Unicode code points for configured human-text character budgets. */
export function characterLength(value: string): number {
	return Array.from(value).length;
}

/**
 * Conservative control-character guard over already-normalized text. Rejects
 * NUL, C0 controls other than tab (`\t`) and newline (`\n`), DEL, and C1
 * controls. CR never survives normalization, so multi-line content is allowed
 * but terminal/encoding-hazardous control characters are not.
 */
export function hasRejectedControlCharacters(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code < 0x20 && code !== 0x09 && code !== 0x0a) return true;
		if (code >= 0x7f && code <= 0x9f) return true;
	}
	return false;
}

/**
 * High-precision local ledger-style secret patterns. Conservative by design:
 * credentials and raw tokens must never be promoted into durable memory, so
 * these patterns err on the side of rejection without matching ordinary prose.
 */
const SECRET_LIKE_PATTERNS: readonly RegExp[] = [
	/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/iu,
	/\b(?:sk|rk)[_-][A-Za-z0-9-]{16,}\b/u,
	/\bwhsec_[A-Za-z0-9]{16,}\b/u,
	/\bAKIA[0-9A-Z]{16}\b/u,
	/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/u,
	/\b(?:xox[baprs])-[A-Za-z0-9-]{10,}\b/u,
	/\bBearer[ \t]+[A-Za-z0-9._~+/=-]{20,}\b/iu,
	/\b(?:api[_-]?key|access[_-]?token|password|passwd|secret)[ \t]*[:=][ \t]*["']?[^\s"']{8,}/iu,
];

/** True when the normalized text resembles a secret/token/credential. */
export function isSecretLike(value: string): boolean {
	return SECRET_LIKE_PATTERNS.some((pattern) => pattern.test(value));
}
