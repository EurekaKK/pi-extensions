import { describe, expect, it } from "vitest";
import { characterLength, hasRejectedControlCharacters, isSecretLike, normalizeRecordText } from "../src/normalize.js";

describe("normalizeRecordText", () => {
	it("folds CRLF and lone CR into LF deterministically", () => {
		expect(normalizeRecordText("a\r\nb")).toBe("a\nb");
		expect(normalizeRecordText("a\rb")).toBe("a\nb");
		expect(normalizeRecordText("a\nb")).toBe("a\nb");
	});

	it("normalizes to NFC so visually identical text collides deterministically", () => {
		expect(normalizeRecordText("e\u0301")) // e + combining acute
			.toBe("\u00e9"); // precomposed é
		expect(normalizeRecordText("\u00e9")).toBe("\u00e9");
	});

	it("is idempotent", () => {
		expect(normalizeRecordText(normalizeRecordText("a\r\nb\te\u0301"))).toBe(normalizeRecordText("a\r\nb\te\u0301"));
	});
});

describe("characterLength", () => {
	it("counts Unicode code points rather than UTF-16 code units", () => {
		expect(characterLength("a😀中")).toBe(3);
	});
});

describe("hasRejectedControlCharacters", () => {
	it("allows tab and newline in multi-line content", () => {
		expect(hasRejectedControlCharacters("line one\n\tline two\n")).toBe(false);
	});

	it("rejects NUL, ESC, DEL, and other C0 controls", () => {
		expect(hasRejectedControlCharacters("a\u0000b")).toBe(true);
		expect(hasRejectedControlCharacters("a\u001bb")).toBe(true);
		expect(hasRejectedControlCharacters("a\u007fb")).toBe(true);
		expect(hasRejectedControlCharacters("a\u0007b")).toBe(true);
	});

	it("rejects C1 controls conservatively", () => {
		expect(hasRejectedControlCharacters("a\u0085b")).toBe(true);
		expect(hasRejectedControlCharacters("a\u009fb")).toBe(true);
	});
});

describe("isSecretLike", () => {
	it("rejects ledger-style API keys and tokens", () => {
		expect(isSecretLike("the key is sk-abcDEF1234ghIJK5678xyz123456789")).toBe(true);
		expect(isSecretLike("AKIAIOSFODNN7EXAMPLE")).toBe(true);
		expect(isSecretLike("ghp_abcdefghijklmnopqrstuvwxyz123456")).toBe(true);
		expect(isSecretLike("xoxb-123456789012-abcdefghijkl")).toBe(true);
		expect(isSecretLike("Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789")).toBe(true);
		expect(isSecretLike("password=correct-horse-battery-staple")).toBe(true);
	});

	it("rejects PEM private keys", () => {
		expect(
			isSecretLike(
				["-----BEGIN RSA PRIVATE KEY-----", "MIIEowIBAAKCAQEA...", "-----END RSA PRIVATE KEY-----"].join("\n"),
			),
		).toBe(true);
	});

	it("accepts ordinary directory knowledge", () => {
		expect(isSecretLike("The monorepo uses npm workspaces and never mixes pnpm or Yarn.")).toBe(false);
		expect(isSecretLike("Deploys run via the ship command inside the tools/ directory.")).toBe(false);
		expect(isSecretLike("summary of a build convention")).toBe(false);
		expect(isSecretLike("The pk-componentIdentifier12345 package name is public metadata.")).toBe(false);
	});
});
