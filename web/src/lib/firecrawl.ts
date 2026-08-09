// Firecrawl scrape client — SPEC §10 (article pipeline, step 1) and the m17
// web-add metadata fetch (SPEC §5).
//
// One page in, readable markdown out. Deliberately a thin `fetch` wrapper
// rather than the `@mendable/firecrawl-js` SDK: we use exactly one endpoint,
// and a hand-rolled call keeps the dependency surface (and the bundle) small
// while letting us map failures onto PipelineError precisely.
//
// API: POST https://api.firecrawl.dev/v2/scrape, Bearer auth. Response is
// `{ success, data: { markdown, summary,
//                     metadata: { title, favicon, sourceURL, statusCode } } }`.
import { PipelineError } from "./pipelineError";

const SCRAPE_URL = "https://api.firecrawl.dev/v2/scrape";

/**
 * Firecrawl's own scrape budget. Its documented ceiling is 300 000ms; 90s is
 * plenty for an article and keeps a failing scrape from eating the whole
 * serverless invocation before the clean pass gets a chance to run.
 */
const SCRAPE_TIMEOUT_MS = 90_000;

/**
 * The metadata fetch (m17) blocks the user's add request, so it gets a much
 * tighter budget than the article scrape: a page that hasn't answered in this
 * long isn't worth making someone watch a spinner for. The add still succeeds
 * — the bookmark keeps its hostname title (SPEC §5).
 */
const METADATA_TIMEOUT_MS = 20_000;

/** Our own abort, slightly above Firecrawl's, so its error wins when it can. */
const requestTimeoutFor = (scrapeTimeoutMs: number) => scrapeTimeoutMs + 15_000;

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

/** What a bookmark's metadata fill needs off a page (m17, SPEC §5). */
export type PageMetadata = {
	/** `<title>`/og title as Firecrawl parsed it; null when the page had none. */
	title: string | null;
	/** Absolute, storable favicon URL; null when there was none we'd accept. */
	faviconUrl: string | null;
	/** Firecrawl's LLM summary of the page; null when it returned none. */
	summary: string | null;
};

/** Shape of the bits of Firecrawl's response we actually read. */
type ScrapeResponse = {
	success?: boolean;
	error?: string;
	data?: {
		markdown?: string | null;
		/** The `summary` format's output — a short prose digest of the page. */
		summary?: string | null;
		metadata?: {
			title?: string | string[] | null;
			/** Already resolved to an absolute URL by Firecrawl. */
			favicon?: string | string[] | null;
			sourceURL?: string | null;
			statusCode?: number | null;
			error?: string | null;
		} | null;
	} | null;
};

/**
 * Firecrawl types several metadata fields as `string | string[]` (a page can
 * carry repeated `<meta>` tags). Take the first non-empty string, with the
 * whitespace of a multi-line `<title>` collapsed the way a browser tab shows
 * it — these land verbatim in a feed row.
 */
function firstString(
	value: string | string[] | null | undefined,
): string | null {
	const raw = Array.isArray(value)
		? value.find((entry) => entry.trim() !== "")
		: value;
	const normalized = raw?.replace(/\s+/g, " ").trim();
	return normalized ? normalized : null;
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
 * Runs one `/v2/scrape` request and returns the parsed payload, mapping every
 * failure — transport, HTTP, malformed JSON, Firecrawl's own `success: false`,
 * and a non-2xx TARGET page — onto `PipelineError`. Shared by the article
 * scrape and the m17 metadata fetch so both report failures identically.
 */
async function requestScrape(
	body: Record<string, unknown>,
	scrapeTimeoutMs: number,
): Promise<ScrapeResponse> {
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
				...body,
				timeout: scrapeTimeoutMs,
				// 24h: a re-scrape the same day reuses Firecrawl's cached crawl.
				maxAge: 86_400_000,
			}),
			signal: AbortSignal.timeout(requestTimeoutFor(scrapeTimeoutMs)),
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

	return payload;
}

/**
 * Scrapes `url` into markdown.
 *
 * `onlyMainContent` strips nav/header/footer server-side — the LLM clean pass
 * (SPEC §10) still has plenty to do, but this removes the bulk cheaply.
 *
 * Throws `PipelineError` on every failure path, including a page that
 * scraped "successfully" but yielded no usable text.
 */
export async function scrapeArticle(url: string): Promise<ScrapedArticle> {
	const payload = await requestScrape(
		{
			url,
			formats: ["markdown"],
			onlyMainContent: true,
			blockAds: true,
		},
		SCRAPE_TIMEOUT_MS,
	);

	const metadata = payload.data?.metadata ?? null;
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

/** Favicon URLs go in a text column and an <img src> — keep them sane. */
const MAX_FAVICON_URL_CHARS = 2048;

/**
 * Keeps only a favicon URL that is safe to store and render: absolute http(s),
 * within the column's sanity bound. Firecrawl resolves the page's declared
 * icon to an absolute URL for us, but it hands back whatever the page said —
 * a `data:` icon (kilobytes inlined into every feed response) or a
 * `chrome-extension:`/`ftp:` href both have to be dropped here.
 *
 * Null in, null out, and null on anything rejected — callers must NOT fall
 * back to guessing `/favicon.ico`: a stored URL that 404s is worse than no URL
 * at all, since the UI's hostname-based fallback always renders something.
 */
function validFaviconUrl(value: string | null): string | null {
	if (!value) {
		return null;
	}
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		// Relative or malformed: we have no base to resolve it against, and
		// Firecrawl was supposed to have done that already.
		return null;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return null;
	}
	return parsed.href.length <= MAX_FAVICON_URL_CHARS ? parsed.href : null;
}

/**
 * Fetches what a bookmark row wants after a web add (m17, SPEC §5): the page's
 * real title, its favicon, and a summary to seed the note with.
 *
 * Asks for the `summary` format. Title and favicon ride along in every
 * response's `metadata` — Firecrawl parses the document and resolves the icon
 * href to an absolute URL itself, so no HTML ever reaches us. The summary
 * costs no extra credit over a plain scrape, but it is LLM-generated, so a
 * cache miss can take a while — hence the deadline the caller holds it to.
 *
 * Throws `PipelineError` like `scrapeArticle` — the caller (which is holding a
 * user's add request open) decides that a failure just means no metadata.
 */
export async function scrapePageMetadata(url: string): Promise<PageMetadata> {
	const payload = await requestScrape(
		{
			url,
			formats: ["summary"],
			blockAds: true,
		},
		METADATA_TIMEOUT_MS,
	);

	const metadata = payload.data?.metadata ?? null;
	const summary = payload.data?.summary?.trim();

	return {
		title: firstString(metadata?.title),
		faviconUrl: validFaviconUrl(firstString(metadata?.favicon)),
		summary: summary ? summary : null,
	};
}
