import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { MAX_URL_CHARACTERS } from "./constants.js";
import { hostnameAllowed } from "./domains.js";
import type { EffectiveDomainPolicy, NormalizedUrl } from "./types.js";

export type UrlRejectionReason = "malformed" | "scheme" | "userinfo" | "ip" | "port" | "special" | "policy" | "length";

export class UrlAdmissionError extends Error {
	readonly reason: UrlRejectionReason;

	constructor(reason: UrlRejectionReason, message: string) {
		super(message);
		this.name = "UrlAdmissionError";
		this.reason = reason;
	}
}

const SPECIAL_EXACT = new Set(["localhost", "local", "internal", "onion", "invalid", "test", "example", "alt"]);
const SPECIAL_SUFFIXES = [
	".localhost",
	".local",
	".internal",
	".onion",
	".invalid",
	".test",
	".example",
	".alt",
	".home.arpa",
	".in-addr.arpa",
	".ip6.arpa",
] as const;

export function normalizePublicUrl(input: string, policy: EffectiveDomainPolicy): NormalizedUrl {
	if (new TextEncoder().encode(input).byteLength > MAX_URL_CHARACTERS) {
		throw new UrlAdmissionError("length", "URL exceeds the 8 KiB limit");
	}
	let parsed: URL;
	try {
		parsed = new URL(input);
	} catch {
		throw new UrlAdmissionError("malformed", "URL is malformed");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new UrlAdmissionError("scheme", "URL scheme must be HTTP or HTTPS");
	}
	if (parsed.username.length > 0 || parsed.password.length > 0) {
		throw new UrlAdmissionError("userinfo", "URL must not contain userinfo");
	}
	if (parsed.port.length > 0) throw new UrlAdmissionError("port", "URL must not use a non-default port");

	const hostname = domainToASCII(stripIpv6Brackets(parsed.hostname)).toLowerCase();
	if (hostname.length === 0) throw new UrlAdmissionError("malformed", "URL hostname is invalid");
	if (isIP(hostname) !== 0) throw new UrlAdmissionError("ip", "URL hostname must not be an IP literal");
	if (hostname.split(".").length < 2 || isSpecialHostname(hostname)) {
		throw new UrlAdmissionError("special", "URL hostname is local, single-label, or special-use");
	}
	if (!hostnameAllowed(hostname, policy)) throw new UrlAdmissionError("policy", "URL is blocked by domain policy");

	parsed.hostname = hostname;
	parsed.hash = "";
	const normalized = parsed.toString();
	if (new TextEncoder().encode(normalized).byteLength > MAX_URL_CHARACTERS) {
		throw new UrlAdmissionError("length", "normalized URL exceeds the 8 KiB limit");
	}
	return Object.freeze({ url: normalized, hostname });
}

export function isSpecialHostname(hostname: string): boolean {
	if (SPECIAL_EXACT.has(hostname)) return true;
	if (hostname === "home.arpa" || hostname === "in-addr.arpa" || hostname === "ip6.arpa") return true;
	return SPECIAL_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
}

function stripIpv6Brackets(hostname: string): string {
	return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}
