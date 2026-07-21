import { describe, expect, it } from "vitest";
import {
	createEffectiveDomainPolicy,
	domainPatternMatches,
	hostnameAllowed,
	parseCallDomainPatterns,
	parseDomainPattern,
	tavilyDomainPushdown,
} from "../src/domains.js";
import { TavilyToolError } from "../src/errors.js";
import { normalizePublicUrl, UrlAdmissionError } from "../src/urls.js";

describe("domain patterns", () => {
	it("normalizes exact, subdomain-only, and apex-plus-subdomain forms", () => {
		expect(parseDomainPattern("BÜCHER.Example.")).toEqual({
			kind: "exact",
			hostname: "xn--bcher-kva.example",
			canonical: "xn--bcher-kva.example",
		});
		expect(parseDomainPattern("*.Example.COM")).toEqual({
			kind: "subdomains",
			hostname: "example.com",
			canonical: "*.example.com",
		});
		expect(parseDomainPattern("**.Example.COM.")).toEqual({
			kind: "apex_and_subdomains",
			hostname: "example.com",
			canonical: "**.example.com",
		});
	});

	it("matches only complete label boundaries at arbitrary subdomain depth", () => {
		const exact = parseDomainPattern("example.com");
		const subdomains = parseDomainPattern("*.example.com");
		const apexAndSubdomains = parseDomainPattern("**.example.com");

		expect(domainPatternMatches(exact, "example.com")).toBe(true);
		expect(domainPatternMatches(exact, "www.example.com")).toBe(false);
		expect(domainPatternMatches(subdomains, "example.com")).toBe(false);
		expect(domainPatternMatches(subdomains, "www.example.com")).toBe(true);
		expect(domainPatternMatches(subdomains, "deep.www.example.com")).toBe(true);
		expect(domainPatternMatches(subdomains, "notexample.com")).toBe(false);
		expect(domainPatternMatches(apexAndSubdomains, "example.com")).toBe(true);
		expect(domainPatternMatches(apexAndSubdomains, "deep.www.example.com")).toBe(true);
	});

	it.each([
		" https://example.com",
		"https://example.com",
		"example.com:443",
		"example.com/path",
		"example.com?query=1",
		"example.com#fragment",
		"example.*",
		"foo.*.example.com",
		"***.example.com",
		"*.example..com",
		"-bad.example.com",
		"bad-.example.com",
		"127.0.0.1",
		"[::1]",
	])("rejects invalid pattern %s", (input) => {
		expect(() => parseDomainPattern(input)).toThrow();
	});

	it("deduplicates call-level patterns after normalization and enforces the call limit", () => {
		expect(parseCallDomainPatterns(["EXAMPLE.com", "example.com.", "*.example.com"], "include_domains")).toEqual([
			parseDomainPattern("example.com"),
			parseDomainPattern("*.example.com"),
		]);
		expect(() =>
			parseCallDomainPatterns(
				Array.from({ length: 21 }, (_, index) => `d${index}.example.com`),
				"exclude_domains",
			),
		).toThrowError(TavilyToolError);
	});
});

describe("effective domain policy", () => {
	it("intersects global and call allow rules while deny remains authoritative", () => {
		const include = parseCallDomainPatterns(["*.api.example.com"], "include_domains");
		const exclude = parseCallDomainPatterns(["private.api.example.com"], "exclude_domains");
		const policy = createEffectiveDomainPolicy(["**.example.com"], ["**.blocked.example.com"], include, exclude);

		expect(policy.canonicalAllow).toEqual(["*.api.example.com"]);
		expect(policy.canonicalDeny).toEqual(["**.blocked.example.com", "private.api.example.com"]);
		expect(hostnameAllowed("v1.api.example.com", policy)).toBe(true);
		expect(hostnameAllowed("api.example.com", policy)).toBe(false);
		expect(hostnameAllowed("private.api.example.com", policy)).toBe(false);
		expect(hostnameAllowed("x.blocked.example.com", policy)).toBe(false);
		expect(hostnameAllowed("other.example.com", policy)).toBe(false);
	});

	it("fails before network when allow policies cannot intersect or deny covers every result", () => {
		const disjoint = parseCallDomainPatterns(["example.net"], "include_domains");
		expect(() => createEffectiveDomainPolicy(["example.com"], [], disjoint, [])).toThrowError(
			expect.objectContaining<Partial<TavilyToolError>>({ code: "tavily_domain_policy_blocked" }),
		);

		expect(() => createEffectiveDomainPolicy(["*.example.com"], ["**.example.com"], [], [])).toThrowError(
			expect.objectContaining<Partial<TavilyToolError>>({ code: "tavily_domain_policy_blocked" }),
		);
	});

	it("only pushes exact allow and apex-plus-subdomain deny rules without narrowing approximations", () => {
		const exact = createEffectiveDomainPolicy(["example.com"], ["**.blocked.example"], [], []);
		expect(tavilyDomainPushdown(exact)).toEqual({
			includeDomains: ["example.com"],
			excludeDomains: ["blocked.example"],
			needsOverfetch: false,
		});

		const wildcard = createEffectiveDomainPolicy(["**.example.com"], ["private.example.com"], [], []);
		expect(tavilyDomainPushdown(wildcard)).toEqual({ includeDomains: [], excludeDomains: [], needsOverfetch: true });
	});
});

describe("public URL admission", () => {
	const unrestricted = createEffectiveDomainPolicy([], [], [], []);

	it("normalizes scheme/IDNA/default port and removes only the fragment", () => {
		expect(normalizePublicUrl("HTTPS://BÜCHER.DE:443/a%20b?z=1&z=2#fragment", unrestricted)).toEqual({
			url: "https://xn--bcher-kva.de/a%20b?z=1&z=2",
			hostname: "xn--bcher-kva.de",
		});
		expect(normalizePublicUrl("http://Example.COM:80/path?utm_source=x&a=1", unrestricted).url).toBe(
			"http://example.com/path?utm_source=x&a=1",
		);
	});

	it("keeps query ordering and admits extractable resources without guessing by suffix", () => {
		const result = normalizePublicUrl("https://example.com/report.pdf?b=2&a=1&a=3", unrestricted);
		expect(result.url).toBe("https://example.com/report.pdf?b=2&a=1&a=3");
	});

	it.each([
		["not a URL", "malformed"],
		["ftp://example.com/file", "scheme"],
		["https://user:pass@example.com/", "userinfo"],
		["https://127.0.0.1/", "ip"],
		["https://example.com:444/", "port"],
		["https://localhost/", "special"],
		["https://singlelabel/", "special"],
		["https://host.local/", "special"],
		["https://host.internal/", "special"],
		["https://host.onion/", "special"],
		["https://host.invalid/", "special"],
		["https://host.test/", "special"],
		["https://home.arpa/", "special"],
		["https://x.in-addr.arpa/", "special"],
		["https://x.ip6.arpa/", "special"],
	] as const)("rejects %s as %s", (url, reason) => {
		try {
			normalizePublicUrl(url, unrestricted);
			expect.fail("URL should have been rejected");
		} catch (error) {
			expect(error).toBeInstanceOf(UrlAdmissionError);
			if (error instanceof UrlAdmissionError) expect(error.reason).toBe(reason);
		}
	});

	it.each(["https://[::1]/", "https://[::ffff:127.0.0.1]/"])("rejects IPv6 literal %s", (url) => {
		expect(() => normalizePublicUrl(url, unrestricted)).toThrowError(UrlAdmissionError);
	});

	it("enforces the effective policy and URL byte limit after normalization", () => {
		const restricted = createEffectiveDomainPolicy(["allowed.example.com"], [], [], []);
		expect(() => normalizePublicUrl("https://blocked.example.com/", restricted)).toThrowError(
			expect.objectContaining<Partial<UrlAdmissionError>>({ reason: "policy" }),
		);

		const oversized = `https://example.com/${"é".repeat(4_096)}`;
		expect(() => normalizePublicUrl(oversized, unrestricted)).toThrowError(
			expect.objectContaining<Partial<UrlAdmissionError>>({ reason: "length" }),
		);
	});
});
