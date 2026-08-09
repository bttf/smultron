// Firecrawl scrape client — SPEC §10 (article pipeline, step 1) and the m17
// web-add metadata fetch (SPEC §5).
//
// One page in, readable markdown out. Deliberately a thin `fetch` wrapper
// rather than the `@mendable/firecrawl-js` SDK: we use exactly one endpoint,
// and a hand-rolled call keeps the dependency surface (and the bundle) small
// while letting us map failures onto PipelineError precisely.
//
// API: POST https://api.firecrawl.dev/v2/scrape, Bearer auth. Response is
// `{ success, data: { markdown, rawHtml, metadata: { title, sourceURL, statusCode } } }`.
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

/** Page title + favicon for a bookmark's metadata fill (m17, SPEC §5). */
export type PageMetadata = {
	/** `<title>`/og title as Firecrawl saw it; null when the page had none. */
	title: string | null;
	/** Absolute favicon URL; null when the page declared none we could resolve. */
	faviconUrl: string | null;
	/** Resolved URL after redirects; null when absent from the response. */
	sourceUrl: string | null;
};

/** Shape of the bits of Firecrawl's response we actually read. */
type ScrapeResponse = {
	success?: boolean;
	error?: string;
	data?: {
		markdown?: string | null;
		rawHtml?: string | null;
		metadata?: {
			title?: string | string[] | null;
			// Undocumented but present on many responses — read opportunistically,
			// with the raw HTML's <link rel="icon"> as the real source of truth.
			favicon?: string | string[] | null;
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

/**
 * Only the document head can carry the icon links, and a `<link>` past the
 * first 300 KB is not one we need. Bounds the regex scans below on pages that
 * inline megabytes of markup.
 */
const HEAD_SCAN_CHARS = 300_000;

/** Favicon URLs go in a text column and an <img src> — keep them sane. */
const MAX_FAVICON_URL_CHARS = 2048;

const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const LINK_TAG_RE = /<link\b[^>]*>/gi;

/** Reads one attribute off a single tag's source (quoted or bare). */
function attr(tag: string, name: string): string | null {
	const match = new RegExp(
		`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`,
		"i",
	).exec(tag);
	if (!match) {
		return null;
	}
	const value = match[2] ?? match[3] ?? match[4] ?? "";
	return value.trim() || null;
}

/** The handful of entities that actually show up in a `<title>`. */
function decodeEntities(text: string): string {
	return text
		.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (entity, body: string) => {
			if (body.startsWith("#")) {
				const code = body.startsWith("#x")
					? Number.parseInt(body.slice(2), 16)
					: Number.parseInt(body.slice(1), 10);
				return Number.isFinite(code) && code > 0 && code <= 0x10ffff
					? String.fromCodePoint(code)
					: entity;
			}
			const named: Record<string, string> = {
				amp: "&",
				lt: "<",
				gt: ">",
				quot: '"',
				apos: "'",
				nbsp: " ",
			};
			return named[body.toLowerCase()] ?? entity;
		})
		.replace(/\s+/g, " ")
		.trim();
}

/** `<title>` text, as a fallback when Firecrawl's metadata carried none. */
export function titleFromHtml(html: string): string | null {
	const match = TITLE_RE.exec(html.slice(0, HEAD_SCAN_CHARS));
	if (!match) {
		return null;
	}
	const decoded = decodeEntities(match[1]);
	return decoded === "" ? null : decoded;
}

/**
 * The page's declared icon href, still relative if that's how it was written.
 * Prefers a real `icon`/`shortcut icon` link over `apple-touch-icon` (the
 * former is what browsers show in a tab), first declaration wins within a
 * tier. Returns null when the page declares none — callers must NOT invent
 * `/favicon.ico`: a stored URL that 404s is worse than no URL at all, since
 * the UI's hostname-based fallback always renders something.
 */
export function faviconHrefFromHtml(html: string): string | null {
	const head = html.slice(0, HEAD_SCAN_CHARS);
	let fallback: string | null = null;

	for (const [tag] of head.matchAll(LINK_TAG_RE)) {
		const rel = attr(tag, "rel")?.toLowerCase();
		if (!rel) {
			continue;
		}
		const rels = rel.split(/\s+/);
		const href = attr(tag, "href");
		if (!href) {
			continue;
		}
		if (rels.includes("icon") || rels.includes("shortcut")) {
			return href;
		}
		if (!fallback && rels.some((r) => r.endsWith("touch-icon"))) {
			fallback = href;
		}
	}

	return fallback;
}

/**
 * Resolves a favicon href against the page URL and keeps only what is safe to
 * store and render: absolute http(s), within the column's sanity bound. A
 * `data:` icon is dropped rather than inlined into every feed response.
 */
export function resolveFaviconUrl(
	href: string | null,
	baseUrl: string,
): string | null {
	if (!href) {
		return null;
	}
	let resolved: URL;
	try {
		resolved = new URL(href, baseUrl);
	} catch {
		return null;
	}
	if (resolved.protocol !== "http:" && resolved.protocol !== "https:") {
		return null;
	}
	return resolved.href.length <= MAX_FAVICON_URL_CHARS ? resolved.href : null;
}

/**
 * Fetches just what a bookmark row needs after a web add (m17, SPEC §5): the
 * page's real title and its favicon.
 *
 * Asks for `rawHtml` rather than `markdown` — the title comes back in the
 * metadata either way, and the favicon is only ever in the markup (Firecrawl
 * exposes it in the separate `branding` format, which costs an extra
 * extraction). `onlyMainContent` is off for the same reason: the icon links
 * live in the head that main-content extraction throws away.
 *
 * Throws `PipelineError` like `scrapeArticle` — the caller (which is holding a
 * user's add request open) decides that a failure just means no metadata.
 */
export async function scrapePageMetadata(url: string): Promise<PageMetadata> {
	const payload = await requestScrape(
		{
			url,
			formats: ["rawHtml"],
			onlyMainContent: false,
			blockAds: true,
		},
		METADATA_TIMEOUT_MS,
	);

	const metadata = payload.data?.metadata ?? null;
	const html = payload.data?.rawHtml ?? "";
	const sourceUrl = firstString(metadata?.sourceURL);
	// Resolve relative hrefs against the URL the page was actually served from.
	const base = sourceUrl ?? url;

	return {
		title: firstString(metadata?.title) ?? titleFromHtml(html),
		faviconUrl:
			resolveFaviconUrl(firstString(metadata?.favicon), base) ??
			resolveFaviconUrl(faviconHrefFromHtml(html), base),
		sourceUrl,
	};
}
