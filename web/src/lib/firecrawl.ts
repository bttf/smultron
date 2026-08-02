// Firecrawl scrape client — SPEC §10 (article pipeline, step 1).
//
// One page in, readable markdown out. Deliberately a thin `fetch` wrapper
// rather than the `@mendable/firecrawl-js` SDK: we use exactly one endpoint,
// and a hand-rolled call keeps the dependency surface (and the bundle) small
// while letting us map failures onto PipelineError precisely.
//
// API: POST https://api.firecrawl.dev/v2/scrape, Bearer auth. Response is
// `{ success, data: { markdown, metadata: { title, sourceURL, statusCode } } }`.
import { PipelineError } from "./pipelineError";

const SCRAPE_URL = "https://api.firecrawl.dev/v2/scrape";

/**
 * Firecrawl's own scrape budget. Its documented ceiling is 300 000ms; 90s is
 * plenty for an article and keeps a failing scrape from eating the whole
 * serverless invocation before the clean pass gets a chance to run.
 */
const SCRAPE_TIMEOUT_MS = 90_000;

/** Our own abort, slightly above Firecrawl's, so its error wins when it can. */
const REQUEST_TIMEOUT_MS = SCRAPE_TIMEOUT_MS + 15_000;

/**
 * Below this, whatever came back is a cookie wall, a JS-only shell, or a 404
 * page — not an article. Failing here produces a clear message instead of a
 * transcript of "Enable JavaScript to continue".
 */
const MIN_USEFUL_MARKDOWN = 200;

export type ScrapedArticle = {
	/** Main-content markdown, as returned by Firecrawl. */
	markdown: string;
	/** Extracted page title; null when Firecrawl found none. */
	title: string | null;
	/** Resolved URL after redirects; null when absent from the response. */
	sourceUrl: string | null;
};

/** Shape of the bits of Firecrawl's response we actually read. */
type ScrapeResponse = {
	success?: boolean;
	error?: string;
	data?: {
		markdown?: string | null;
		metadata?: {
			title?: string | string[] | null;
			sourceURL?: string | null;
			statusCode?: number | null;
			error?: string | null;
		} | null;
	} | null;
};

/**
 * Firecrawl types several metadata fields as `string | string[]` (a page can
 * carry repeated `<meta>` tags). Take the first non-empty string.
 */
function firstString(
	value: string | string[] | null | undefined,
): string | null {
	if (Array.isArray(value)) {
		const found = value.find((entry) => entry.trim() !== "");
		return found?.trim() ?? null;
	}
	const trimmed = value?.trim();
	return trimmed ? trimmed : null;
}

/** Maps a non-2xx Firecrawl response onto a PipelineError. */
function httpFailure(status: number, body: string): PipelineError {
	const detail = body.slice(0, 300);

	if (status === 401 || status === 403) {
		return new PipelineError(
			"scrape",
			"unauthorized",
			"Firecrawl rejected the API key. Check FIRECRAWL_API_KEY.",
		);
	}
	if (status === 402) {
		return new PipelineError(
			"scrape",
			"payment_required",
			"Firecrawl credits exhausted.",
		);
	}
	if (status === 429) {
		return new PipelineError(
			"scrape",
			"rate_limited",
			"Firecrawl rate limit hit. Try again shortly.",
			{ retryable: true },
		);
	}
	if (status >= 500) {
		return new PipelineError(
			"scrape",
			`http_${status}`,
			`Firecrawl server error (${status}). Try again shortly.`,
			{ retryable: true },
		);
	}
	return new PipelineError(
		"scrape",
		`http_${status}`,
		`Firecrawl request failed (${status}): ${detail}`,
	);
}

/**
 * Scrapes `url` into markdown.
 *
 * `onlyMainContent` strips nav/header/footer server-side — the LLM clean pass
 * (SPEC §10) still has plenty to do, but this removes the bulk cheaply.
 * `maxAge` lets Firecrawl serve a recent cached crawl: re-scraping the same
 * bookmark within the day shouldn't re-bill or re-fetch.
 *
 * Throws `PipelineError` on every failure path, including a page that
 * scraped "successfully" but yielded no usable text.
 */
export async function scrapeArticle(url: string): Promise<ScrapedArticle> {
	const apiKey = process.env.FIRECRAWL_API_KEY;
	if (!apiKey) {
		throw new PipelineError(
			"scrape",
			"not_configured",
			"FIRECRAWL_API_KEY is not set.",
		);
	}

	let response: Response;
	try {
		response = await fetch(SCRAPE_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				url,
				formats: ["markdown"],
				onlyMainContent: true,
				blockAds: true,
				timeout: SCRAPE_TIMEOUT_MS,
				// 24h: a re-scrape the same day reuses Firecrawl's cached crawl.
				maxAge: 86_400_000,
			}),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	} catch (cause) {
		const timedOut =
			cause instanceof Error &&
			(cause.name === "AbortError" || cause.name === "TimeoutError");
		throw new PipelineError(
			"scrape",
			timedOut ? "timeout" : "network",
			timedOut
				? "Firecrawl did not respond in time."
				: `Could not reach Firecrawl: ${cause instanceof Error ? cause.message : String(cause)}`,
			{ retryable: true, cause },
		);
	}

	if (!response.ok) {
		throw httpFailure(response.status, await response.text().catch(() => ""));
	}

	let payload: ScrapeResponse;
	try {
		payload = (await response.json()) as ScrapeResponse;
	} catch (cause) {
		throw new PipelineError(
			"scrape",
			"bad_response",
			"Firecrawl returned a response that was not JSON.",
			{ retryable: true, cause },
		);
	}

	if (payload.success === false) {
		throw new PipelineError(
			"scrape",
			"unsuccessful",
			payload.error?.slice(0, 300) ?? "Firecrawl reported the scrape failed.",
		);
	}

	const metadata = payload.data?.metadata ?? null;
	const pageStatus = metadata?.statusCode ?? null;
	// Firecrawl reports the TARGET page's status here; a 2xx envelope around a
	// 404 page would otherwise be scraped into a transcript of the error page.
	if (pageStatus !== null && (pageStatus < 200 || pageStatus >= 400)) {
		throw new PipelineError(
			"scrape",
			`page_${pageStatus}`,
			`The page returned ${pageStatus}.`,
			{ retryable: pageStatus >= 500 },
		);
	}

	const markdown = payload.data?.markdown?.trim() ?? "";
	if (markdown.length < MIN_USEFUL_MARKDOWN) {
		throw new PipelineError(
			"scrape",
			"empty_content",
			markdown === ""
				? "No readable content found on the page (it may require JavaScript or a login)."
				: "The page yielded too little text to read.",
		);
	}

	return {
		markdown,
		title: firstString(metadata?.title),
		sourceUrl: firstString(metadata?.sourceURL),
	};
}
