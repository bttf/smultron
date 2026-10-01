// Adapter contracts for page snapshots (SPEC §17.5). Pure code: DOM APIs
// only, no Chrome APIs, so adapters run in the injected snapshot script and
// in Vitest alike.

/** What an adapter gets to work with, inside the page. */
export type AdapterContext = {
	document: Document;
	url: URL;
	/** The page's own fetch: same-origin with the user's session (e.g. reddit's .json endpoints). */
	fetch: typeof fetch;
};

export type AdapterOutput = {
	title: string;
	/** Copy-pasteable, text-only markdown. The snapshot's primary export. */
	markdown: string;
	/** Adapter-specific structured output, stored as the `data` asset. */
	data?: unknown;
};

export type Adapter = {
	/** Stable kebab-case id, stored on every snapshot and used for enable/disable. */
	id: string;
	/** Shown in Options. */
	name: string;
	description: string;
	/** Bump when the output format changes. */
	version: string;
	matches(url: URL): boolean;
	extract(ctx: AdapterContext): Promise<AdapterOutput>;
};

export type ScrapeResult = AdapterOutput & {
	adapterId: string;
	adapterVersion: string;
};

/** Everything learned about a page from its DOM at snapshot time (SPEC §17.5). */
export type PageMetadata = {
	url: string;
	canonicalUrl?: string;
	title: string;
	description?: string;
	lang?: string;
	siteName?: string;
	author?: string;
	publishedAt?: string;
	modifiedAt?: string;
	favicon?: string;
	/** Every <meta> tag on the page. */
	meta: Array<{
		name?: string;
		property?: string;
		httpEquiv?: string;
		charset?: string;
		content?: string;
	}>;
	/** og:* properties without the prefix. Repeated properties become arrays. */
	openGraph: Record<string, string | string[]>;
	/** twitter:* properties without the prefix. */
	twitter: Record<string, string>;
	/** Parsed JSON-LD blocks; unparseable blocks are skipped. */
	jsonLd: unknown[];
	/** <link> tags with a rel attribute. */
	links: Array<{
		rel: string;
		href: string;
		type?: string;
		hreflang?: string;
		title?: string;
	}>;
	viewport: { width: number; height: number; devicePixelRatio: number };
	scrollHeight: number;
	userAgent: string;
	/** ISO 8601 */
	capturedAt: string;
};
