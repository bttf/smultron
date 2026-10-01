import type { PageMetadata } from "./types";

type MetaEntry = PageMetadata["meta"][number];
type LinkEntry = PageMetadata["links"][number];
type JsonLdNode = Record<string, unknown>;

/** Collects everything PageMetadata describes from the page DOM. Browser DOM APIs only. */
export function collectMetadata(document: Document): PageMetadata {
	const win = document.defaultView;
	const url = document.location?.href ?? document.URL;
	const base = document.baseURI || url;

	const metaEls = Array.from(document.querySelectorAll("meta"));
	const meta = metaEls.map(metaEntry);
	const lookup = metaLookup(metaEls);
	const pick = (...keys: string[]) =>
		firstDefined(keys.map((k) => lookup.get(k)));

	const jsonLd = parseJsonLd(document);
	const nodes = jsonLdNodes(jsonLd);
	const articleNode = nodes.find(isArticleNode);
	const ldPick = (key: string) =>
		firstDefined([articleNode, ...nodes].map((n) => text(n?.[key])));

	const links = collectLinks(document, base);
	const canonicalUrl =
		links.find((l) => relTokens(l.rel).includes("canonical"))?.href ??
		absoluteUrl(pick("og:url"), base);

	return {
		url,
		canonicalUrl,
		title: clean(document.title) || pick("og:title", "twitter:title") || "",
		description:
			pick("description", "og:description", "twitter:description") ??
			ldPick("description"),
		lang:
			clean(document.documentElement?.getAttribute("lang")) ||
			pick("content-language", "og:locale", "inlanguage") ||
			undefined,
		siteName:
			pick("og:site_name", "application-name", "apple-mobile-web-app-title") ??
			ldName(articleNode?.publisher, nodes) ??
			text(nodes.find((n) => hasType(n, /^WebSite$/))?.name),
		author:
			pick(
				"author",
				"parsely-author",
				"sailthru.author",
				"dc.creator",
				"citation_author",
			) ??
			notUrl(pick("article:author")) ??
			ldName(
				articleNode?.author ?? nodes.find((n) => n.author)?.author,
				nodes,
			) ??
			clean(pick("byl")?.replace(/^by\s+/i, "")),
		publishedAt:
			pick(
				"article:published_time",
				"og:published_time",
				"datepublished",
				"parsely-pub-date",
				"sailthru.date",
				"pubdate",
				"publishdate",
				"dc.date.issued",
				"dc.date",
				"citation_publication_date",
				"date",
			) ?? ldPick("datePublished"),
		modifiedAt:
			pick(
				"article:modified_time",
				"og:updated_time",
				"datemodified",
				"last-modified",
			) ?? ldPick("dateModified"),
		favicon: findFavicon(links, url),
		meta,
		openGraph: collectOpenGraph(metaEls),
		twitter: collectTwitter(metaEls),
		jsonLd,
		links,
		viewport: {
			width: win?.innerWidth ?? 0,
			height: win?.innerHeight ?? 0,
			devicePixelRatio: win?.devicePixelRatio ?? 1,
		},
		scrollHeight: Math.max(
			document.documentElement?.scrollHeight ?? 0,
			document.body?.scrollHeight ?? 0,
		),
		userAgent: win?.navigator.userAgent ?? "",
		capturedAt: new Date().toISOString(),
	};
}

function metaEntry(el: HTMLMetaElement): MetaEntry {
	const entry: MetaEntry = {};
	const set = (key: keyof MetaEntry, attr: string) => {
		const value = el.getAttribute(attr);
		if (value !== null) entry[key] = value;
	};
	set("name", "name");
	set("property", "property");
	set("httpEquiv", "http-equiv");
	set("charset", "charset");
	set("content", "content");
	return entry;
}

/** Lowercased property/name/itemprop/http-equiv -> first non-empty content. */
function metaLookup(metaEls: HTMLMetaElement[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const el of metaEls) {
		const content = clean(el.getAttribute("content"));
		if (!content) continue;
		for (const attr of ["property", "name", "itemprop", "http-equiv"]) {
			const key = el.getAttribute(attr)?.trim().toLowerCase();
			if (key && !map.has(key)) map.set(key, content);
		}
	}
	return map;
}

function metaKey(el: HTMLMetaElement): string | undefined {
	return (
		(el.getAttribute("property") ?? el.getAttribute("name"))
			?.trim()
			.toLowerCase() || undefined
	);
}

function collectOpenGraph(
	metaEls: HTMLMetaElement[],
): Record<string, string | string[]> {
	const og: Record<string, string | string[]> = {};
	for (const el of metaEls) {
		const key = metaKey(el);
		const content = el.getAttribute("content");
		if (!key?.startsWith("og:") || content === null) continue;
		const k = key.slice(3);
		const prev = og[k];
		og[k] =
			prev === undefined
				? content
				: Array.isArray(prev)
					? [...prev, content]
					: [prev, content];
	}
	return og;
}

function collectTwitter(metaEls: HTMLMetaElement[]): Record<string, string> {
	const tw: Record<string, string> = {};
	for (const el of metaEls) {
		const key = metaKey(el);
		const content = el.getAttribute("content");
		if (!key?.startsWith("twitter:") || content === null) continue;
		tw[key.slice(8)] ??= content;
	}
	return tw;
}

function parseJsonLd(document: Document): unknown[] {
	const out: unknown[] = [];
	for (const script of Array.from(document.querySelectorAll("script[type]"))) {
		if (!/^\s*application\/ld\+json/i.test(script.getAttribute("type") ?? ""))
			continue;
		const raw = script.textContent?.trim();
		if (!raw) continue;
		try {
			out.push(JSON.parse(raw));
		} catch {
			// Common breakage: HTML comment / CDATA wrappers and raw control characters inside strings.
			try {
				const repaired = raw
					.replace(/^\s*(<!--|\/\/\s*<!\[CDATA\[|<!\[CDATA\[)/, "")
					.replace(/(-->|\/\/\s*\]\]>|\]\]>)\s*$/, "")
					// biome-ignore lint/suspicious/noControlCharactersInRegex: raw control characters inside JSON-LD strings break JSON.parse
					.replace(/[\u0000-\u001f]+/g, " ");
				out.push(JSON.parse(repaired));
			} catch {
				// Skip unparseable blocks.
			}
		}
	}
	return out;
}

/** Flattens arrays and @graph containers into a list of JSON-LD objects. */
function jsonLdNodes(blocks: unknown[]): JsonLdNode[] {
	const out: JsonLdNode[] = [];
	const visit = (value: unknown) => {
		if (Array.isArray(value)) value.forEach(visit);
		else if (value && typeof value === "object") {
			const node = value as JsonLdNode;
			out.push(node);
			if (node["@graph"]) visit(node["@graph"]);
		}
	};
	blocks.forEach(visit);
	return out;
}

function hasType(node: JsonLdNode, pattern: RegExp): boolean {
	const types = ([] as unknown[]).concat(node["@type"] ?? []);
	return types.some((t) => typeof t === "string" && pattern.test(t));
}

function isArticleNode(node: JsonLdNode): boolean {
	return hasType(node, /Article|Posting|Report/);
}

/** Name(s) from a JSON-LD Person/Organization value: string, object with name, @id reference, or array. */
function ldName(value: unknown, nodes: JsonLdNode[]): string | undefined {
	const names: string[] = [];
	const visit = (v: unknown) => {
		if (Array.isArray(v)) v.forEach(visit);
		else if (typeof v === "string") {
			const name = notUrl(clean(v));
			if (name) names.push(name);
		} else if (v && typeof v === "object") {
			const node = v as JsonLdNode;
			const name = text(node.name);
			if (name) names.push(name);
			else if (typeof node["@id"] === "string") {
				const ref = nodes.find((n) => n !== node && n["@id"] === node["@id"]);
				const refName = ref && text(ref.name);
				if (refName) names.push(refName);
			}
		}
	};
	visit(value);
	return names.length ? [...new Set(names)].join(", ") : undefined;
}

function collectLinks(document: Document, base: string): LinkEntry[] {
	const links: LinkEntry[] = [];
	for (const el of Array.from(document.querySelectorAll("link[rel][href]"))) {
		const rel = clean(el.getAttribute("rel"));
		const href = absoluteUrl(el.getAttribute("href"), base);
		if (!rel || !href) continue;
		const link: LinkEntry = { rel, href };
		const type = el.getAttribute("type");
		const hreflang = el.getAttribute("hreflang");
		const title = el.getAttribute("title");
		if (type) link.type = type;
		if (hreflang) link.hreflang = hreflang;
		if (title) link.title = title;
		links.push(link);
	}
	return links;
}

function findFavicon(links: LinkEntry[], pageUrl: string): string | undefined {
	const byRel = (rel: string) =>
		links.find((l) => relTokens(l.rel).includes(rel))?.href;
	const found =
		byRel("icon") ??
		byRel("apple-touch-icon") ??
		byRel("apple-touch-icon-precomposed");
	if (found) return found;
	try {
		const u = new URL(pageUrl);
		if (u.protocol === "http:" || u.protocol === "https:")
			return new URL("/favicon.ico", u.origin).href;
	} catch {
		// Not a parseable URL.
	}
	return undefined;
}

function relTokens(rel: string): string[] {
	return rel.toLowerCase().split(/\s+/);
}

function absoluteUrl(
	href: string | null | undefined,
	base: string,
): string | undefined {
	if (!href?.trim()) return undefined;
	try {
		return new URL(href.trim(), base).href;
	} catch {
		return undefined;
	}
}

function text(value: unknown): string | undefined {
	if (typeof value === "string") return clean(value) || undefined;
	if (typeof value === "number") return String(value);
	return undefined;
}

function notUrl(value: string | undefined): string | undefined {
	return value && !/^https?:\/\//i.test(value) ? value : undefined;
}

function clean(value: string | null | undefined): string {
	return (value ?? "").replace(/\s+/g, " ").trim();
}

function firstDefined<T>(values: Array<T | undefined>): T | undefined {
	return values.find((v) => v !== undefined);
}
