export interface SearchHit {
	readonly title: string;
	readonly url: string;
	readonly snippet: string;
	readonly score?: number;
}

export interface ExtractPage {
	readonly url: string;
	readonly content: string;
}

function xmlText(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function untrusted(inner: string): string {
	return `<untrusted_external_data>\n${inner}</untrusted_external_data>`;
}

export function searchEnvelope(hits: readonly SearchHit[]): string {
	const inner = hits
		.map((hit) => {
			const score = hit.score === undefined ? "" : `\n<score>${xmlText(String(hit.score))}</score>`;
			return `<hit>\n<title>${xmlText(hit.title)}</title>\n<url>${xmlText(hit.url)}</url>\n<snippet>${xmlText(hit.snippet)}</snippet>${score}\n</hit>`;
		})
		.join("\n");
	return `<tavily_search>\n${untrusted(`${inner}\n`)}</tavily_search>`;
}

export function extractEnvelope(pages: readonly ExtractPage[], failedUrls: readonly string[]): string {
	const pagesXml = pages
		.map((page) => `<page>\n<url>${xmlText(page.url)}</url>\n<content>${xmlText(page.content)}</content>\n</page>`)
		.join("\n");
	const failedXml = failedUrls.map((url) => `<failed>\n<url>${xmlText(url)}</url>\n</failed>`).join("\n");
	const inner = [pagesXml, failedXml].filter((part) => part.length > 0).join("\n");
	return `<tavily_extract>\n${untrusted(`${inner}\n`)}</tavily_extract>`;
}
