import { Readability } from "@mozilla/readability";
import { collectMetadata } from "../metadata";
import type { Adapter } from "../types";
import { htmlToMarkdown, tidyMarkdown } from "./markdown";

/**
 * Best-effort adapter for unrecognized sites: Readability on a clone of the page, then turndown.
 * Falls back to the page's visible text when Readability finds no article.
 */
export const genericAdapter: Adapter = {
	id: "generic",
	name: "Generic (best effort)",
	description: "Extracts the main article content of any page.",
	version: "1.0.0",
	matches: () => true,
	async extract({ document, url }) {
		const meta = collectMetadata(document);
		const article = parseArticle(document);

		let body = "";
		if (article?.content && article.textContent?.trim()) {
			try {
				body = htmlToMarkdown(
					article.content as HTMLElement,
					document.baseURI || url.href,
					url.href,
				);
			} catch {
				body = "";
			}
		}
		const extraction = body ? "readability" : "text";
		if (!body) body = pageText(document);

		const title = clean(article?.title) || meta.title || url.href;
		const byline = cleanByline(article?.byline) || meta.author;
		const siteName = clean(article?.siteName) || meta.siteName;
		const publishedAt = clean(article?.publishedTime) || meta.publishedAt;

		const header = [`# ${title}`, "", `URL: ${url.href}`];
		if (byline) header.push(`Author: ${byline}`);
		if (siteName) header.push(`Site: ${siteName}`);
		if (publishedAt) header.push(`Published: ${formatDate(publishedAt)}`);

		return {
			title,
			markdown: body
				? `${header.join("\n")}\n\n---\n\n${body}`
				: header.join("\n"),
			data: {
				extraction,
				byline,
				siteName,
				publishedAt,
				excerpt: clean(article?.excerpt) || meta.description,
				lang: clean(article?.lang) || meta.lang,
			},
		};
	},
};

function parseArticle(document: Document) {
	try {
		// Readability mutates the document it parses; never hand it the live page.
		const clone = document.cloneNode(true) as Document;
		return new Readability<Node>(clone, {
			serializer: (node) => node,
			keepClasses: true,
		}).parse();
	} catch {
		return null;
	}
}

/** Visible page text, used when Readability finds no article. */
function pageText(document: Document): string {
	const body = document.body;
	if (!body) return "";
	let text: string;
	if (typeof body.innerText === "string") {
		text = body.innerText;
	} else {
		// Environments without layout (no innerText): drop non-text elements and use textContent.
		const clone = body.cloneNode(true) as HTMLElement;
		for (const el of clone.querySelectorAll(
			"script, style, noscript, template",
		)) {
			el.remove();
		}
		text = clone.textContent ?? "";
	}
	return tidyMarkdown(
		text
			.split("\n")
			.map((line) => line.replace(/[ \t\f\v\r ]+/g, " ").trim())
			.join("\n"),
	);
}

function clean(value: string | null | undefined): string {
	return (value ?? "").replace(/\s+/g, " ").trim();
}

function cleanByline(value: string | null | undefined): string {
	const byline = clean(value).replace(/^by\s+/i, "");
	return byline.length <= 200 ? byline : "";
}

/** YYYY-MM-DD as written on the page when possible, so the author's timezone is kept. */
function formatDate(value: string): string {
	const date = value.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
	if (date) return date;
	const time = Date.parse(value);
	return Number.isNaN(time) ? value : new Date(time).toISOString().slice(0, 10);
}
