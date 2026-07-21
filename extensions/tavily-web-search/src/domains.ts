import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { type TavilyTool, TavilyToolError } from "./errors.js";
import type { DomainPattern, EffectiveDomainPolicy } from "./types.js";

export class DomainPatternError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DomainPatternError";
	}
}

export function parseDomainPattern(input: string): DomainPattern {
	if (input.length === 0 || input !== input.trim()) {
		throw new DomainPatternError("must be a non-empty domain pattern without surrounding whitespace");
	}

	let kind: DomainPattern["kind"] = "exact";
	let hostnameInput = input;
	if (hostnameInput.startsWith("**.")) {
		kind = "apex_and_subdomains";
		hostnameInput = hostnameInput.slice(3);
	} else if (hostnameInput.startsWith("*.")) {
		kind = "subdomains";
		hostnameInput = hostnameInput.slice(2);
	}

	if (hostnameInput.endsWith(".")) hostnameInput = hostnameInput.slice(0, -1);
	if (
		hostnameInput.length === 0 ||
		hostnameInput.includes("*") ||
		/[/:?#@[\]]/u.test(hostnameInput) ||
		hostnameInput.includes("..")
	) {
		throw new DomainPatternError("must contain only a hostname with an optional leading *. or **. wildcard");
	}

	const hostname = domainToASCII(hostnameInput).toLowerCase();
	if (hostname.length === 0 || hostname.length > 253) {
		throw new DomainPatternError("has an invalid IDNA hostname or exceeds 253 ASCII characters");
	}
	if (isIP(stripIpv6Brackets(hostname)) !== 0) throw new DomainPatternError("must not be an IP address");
	for (const label of hostname.split(".")) {
		if (label.length < 1 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)) {
			throw new DomainPatternError("contains an invalid DNS label");
		}
	}

	const prefix = kind === "subdomains" ? "*." : kind === "apex_and_subdomains" ? "**." : "";
	return Object.freeze({ kind, hostname, canonical: `${prefix}${hostname}` });
}

export function parseCallDomainPatterns(
	values: readonly string[] | undefined,
	field: "include_domains" | "exclude_domains",
	tool: TavilyTool = "search",
): readonly DomainPattern[] {
	if (values === undefined) return [];
	if (values.length > 20) {
		throw new TavilyToolError(tool, "tavily_invalid_arguments", "fix_call", `${field} accepts at most 20 patterns.`);
	}
	const result: DomainPattern[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		if (typeof value !== "string") {
			throw new TavilyToolError(tool, "tavily_invalid_arguments", "fix_call", `${field} must contain only strings.`);
		}
		let parsed: DomainPattern;
		try {
			parsed = parseDomainPattern(value);
		} catch (error) {
			const reason = error instanceof DomainPatternError ? error.message : "is invalid";
			throw new TavilyToolError(
				tool,
				"tavily_invalid_arguments",
				"fix_call",
				`${field} contains a pattern that ${reason}.`,
			);
		}
		if (seen.has(parsed.canonical)) continue;
		seen.add(parsed.canonical);
		result.push(parsed);
	}
	return Object.freeze(result);
}

export function createEffectiveDomainPolicy(
	globalAllowValues: readonly string[],
	globalDenyValues: readonly string[],
	callAllow: readonly DomainPattern[],
	callDeny: readonly DomainPattern[],
): EffectiveDomainPolicy {
	const globalAllow = globalAllowValues.map(parseDomainPattern);
	const globalDeny = globalDenyValues.map(parseDomainPattern);
	const deny = deduplicatePatterns([...globalDeny, ...callDeny]);
	const intersections = effectiveAllowPatterns(globalAllow, callAllow);
	if (intersections?.every((pattern) => deny.some((item) => patternSubsetOf(pattern, item)))) {
		throw new TavilyToolError(
			"search",
			"tavily_domain_policy_blocked",
			"fix_call",
			"The call-level domain filters leave no hostname permitted by the configured policy.",
		);
	}
	return Object.freeze({
		globalAllow: Object.freeze(globalAllow),
		callAllow: Object.freeze([...callAllow]),
		deny: Object.freeze(deny),
		canonicalAllow: Object.freeze((intersections ?? []).map((pattern) => pattern.canonical).sort()),
		canonicalDeny: Object.freeze(deny.map((pattern) => pattern.canonical).sort()),
	});
}

export function hostnameAllowed(hostname: string, policy: EffectiveDomainPolicy): boolean {
	if (policy.deny.some((pattern) => domainPatternMatches(pattern, hostname))) return false;
	if (policy.globalAllow.length > 0 && !policy.globalAllow.some((pattern) => domainPatternMatches(pattern, hostname))) {
		return false;
	}
	if (policy.callAllow.length > 0 && !policy.callAllow.some((pattern) => domainPatternMatches(pattern, hostname))) {
		return false;
	}
	return true;
}

export function domainPatternMatches(pattern: DomainPattern, hostname: string): boolean {
	if (pattern.kind === "exact") return hostname === pattern.hostname;
	if (pattern.kind === "apex_and_subdomains" && hostname === pattern.hostname) return true;
	return hostname.endsWith(`.${pattern.hostname}`);
}

export function tavilyDomainPushdown(policy: EffectiveDomainPolicy): {
	readonly includeDomains: readonly string[];
	readonly excludeDomains: readonly string[];
	readonly needsOverfetch: boolean;
} {
	const effective = effectiveAllowPatterns(policy.globalAllow, policy.callAllow);
	const includeDomains = effective?.every((pattern) => pattern.kind === "exact")
		? effective.map((pattern) => pattern.hostname)
		: [];
	const excludeDomains = policy.deny
		.filter((pattern) => pattern.kind === "apex_and_subdomains")
		.map((pattern) => pattern.hostname);
	const exactPushdownCoversAllow = effective === undefined || includeDomains.length === effective.length;
	const denyPushdownCoversDeny = excludeDomains.length === policy.deny.length;
	return Object.freeze({
		includeDomains: Object.freeze([...new Set(includeDomains)].sort()),
		excludeDomains: Object.freeze([...new Set(excludeDomains)].sort()),
		needsOverfetch: !exactPushdownCoversAllow || !denyPushdownCoversDeny,
	});
}

function effectiveAllowPatterns(
	globalAllow: readonly DomainPattern[],
	callAllow: readonly DomainPattern[],
): readonly DomainPattern[] | undefined {
	if (globalAllow.length === 0 && callAllow.length === 0) return undefined;
	if (globalAllow.length === 0) return deduplicatePatterns(callAllow);
	if (callAllow.length === 0) return deduplicatePatterns(globalAllow);
	const intersections: DomainPattern[] = [];
	for (const globalPattern of globalAllow) {
		for (const callPattern of callAllow) {
			const intersection = intersectPatterns(globalPattern, callPattern);
			if (intersection) intersections.push(intersection);
		}
	}
	if (intersections.length === 0) {
		throw new TavilyToolError(
			"search",
			"tavily_domain_policy_blocked",
			"fix_call",
			"The call-level include_domains filter cannot intersect the configured allow policy.",
		);
	}
	return deduplicatePatterns(intersections);
}

function intersectPatterns(first: DomainPattern, second: DomainPattern): DomainPattern | undefined {
	if (first.kind === "exact") return domainPatternMatches(second, first.hostname) ? first : undefined;
	if (second.kind === "exact") return domainPatternMatches(first, second.hostname) ? second : undefined;
	if (first.hostname === second.hostname) {
		return first.kind === "subdomains" || second.kind === "subdomains"
			? patternFromParts("subdomains", first.hostname)
			: patternFromParts("apex_and_subdomains", first.hostname);
	}
	if (first.hostname.endsWith(`.${second.hostname}`)) return first;
	if (second.hostname.endsWith(`.${first.hostname}`)) return second;
	return undefined;
}

function patternSubsetOf(candidate: DomainPattern, container: DomainPattern): boolean {
	if (candidate.kind === "exact") return domainPatternMatches(container, candidate.hostname);
	if (container.kind === "exact") return false;
	if (candidate.hostname === container.hostname) {
		return container.kind === "apex_and_subdomains" || candidate.kind === "subdomains";
	}
	return candidate.hostname.endsWith(`.${container.hostname}`);
}

function patternFromParts(kind: DomainPattern["kind"], hostname: string): DomainPattern {
	const prefix = kind === "subdomains" ? "*." : kind === "apex_and_subdomains" ? "**." : "";
	return Object.freeze({ kind, hostname, canonical: `${prefix}${hostname}` });
}

function deduplicatePatterns(patterns: readonly DomainPattern[]): DomainPattern[] {
	const byCanonical = new Map<string, DomainPattern>();
	for (const pattern of patterns) byCanonical.set(pattern.canonical, pattern);
	return [...byCanonical.values()].sort((first, second) => first.canonical.localeCompare(second.canonical));
}

function stripIpv6Brackets(hostname: string): string {
	return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}
