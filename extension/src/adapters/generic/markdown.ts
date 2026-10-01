/// <reference path="./turndown-plugin-gfm.d.ts" />
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

/** Elements that never carry article text. */
const REMOVED = new Set([
	"SCRIPT",
	"STYLE",
	"NOSCRIPT",
	"TEMPLATE",
	"IFRAME",
	"FRAME",
	"OBJECT",
	"EMBED",
	"SVG",
	"CANVAS",
	"VIDEO",
	"AUDIO",
	"FORM",
	"BUTTON",
	"INPUT",
	"SELECT",
	"TEXTAREA",
	"DIALOG",
]);

/**
 * Converts article HTML to text-first markdown.
 * Links and images get absolute URLs; images without alt text or with non-http sources
 * (data:, blob:) are dropped.
 */
export function htmlToMarkdown(
	root: HTMLElement,
	baseUrl: string,
	pageUrl: string,
): string {
	return tidyMarkdown(createTurndown(baseUrl, pageUrl).turndown(root));
}

function createTurndown(baseUrl: string, pageUrl: string): TurndownService {
	const td = new TurndownService({
		headingStyle: "atx",
		hr: "---",
		bulletListMarker: "-",
		codeBlockStyle: "fenced",
		fence: "```",
		emDelimiter: "*",
		strongDelimiter: "**",
		linkStyle: "inlined",
	});
	td.use(gfm);
	td.remove((node) => REMOVED.has(node.nodeName.toUpperCase()));
	td.escape = escapeText;

	// Rules added later take precedence over earlier ones, including the gfm plugin's.
	td.addRule("heading", {
		filter: ["h1", "h2", "h3", "h4", "h5", "h6"],
		replacement(content, node) {
			const text = oneLine(content);
			return text
				? `\n\n${"#".repeat(Number(node.nodeName.charAt(1)))} ${text}\n\n`
				: "";
		},
	});

	td.addRule("listItem", {
		filter: "li",
		replacement(content, node) {
			const parent = node.parentElement;
			let prefix = "- ";
			if (parent?.nodeName === "OL") {
				const start = Number(parent.getAttribute("start") ?? "1");
				const index = Array.prototype.indexOf.call(parent.children, node);
				prefix = `${(Number.isFinite(start) ? start : 1) + index}. `;
			}
			const isParagraph = /\n$/.test(content);
			const body = (
				content.replace(/^\n+/, "").replace(/\n+$/, "") +
				(isParagraph ? "\n" : "")
			).replace(/\n/g, `\n${" ".repeat(prefix.length)}`);
			return prefix + body + (node.nextSibling ? "\n" : "");
		},
	});

	td.addRule("pre", {
		filter: "pre",
		replacement(_content, node) {
			const code = preText(node).replace(/^\n+|\n+$/g, "");
			if (!code.trim()) return "";
			let fence = "```";
			for (const run of code.match(/^`{3,}/gm) ?? []) {
				if (run.length >= fence.length) fence = "`".repeat(run.length + 1);
			}
			return `\n\n${fence}${codeLanguage(node)}\n${code}\n${fence}\n\n`;
		},
	});

	td.addRule("tableCaption", {
		filter: "caption",
		replacement: () => "",
	});

	td.addRule("tableCell", {
		filter: ["th", "td"],
		replacement(content, node) {
			const text = oneLine(content).replace(/\|/g, "\\|");
			return `${(node.previousElementSibling ? " " : "| ") + text} |`;
		},
	});

	td.addRule("tableRow", {
		filter: "tr",
		replacement: (content) => `\n${content}`,
	});

	// Every table gets a GFM header separator after its first row, heading row or not,
	// so no table is passed through as raw HTML.
	td.addRule("table", {
		filter: "table",
		replacement(content, node) {
			const table = node as HTMLTableElement;
			const rows = content.split("\n").filter((line) => line.trim());
			const counts = Array.from(table.rows ?? [], (row) => row.cells.length);
			const cols = Math.max(0, ...counts);
			const caption = oneLine(table.caption?.textContent ?? "");
			const [first, ...rest] = rows;
			if (!first || !cols) return caption ? `\n\n${caption}\n\n` : "";
			const header =
				first + "  |".repeat(Math.max(0, cols - (counts[0] ?? cols)));
			const separator = `|${" --- |".repeat(cols)}`;
			return `\n\n${caption ? `${caption}\n\n` : ""}${[header, separator, ...rest].join("\n")}\n\n`;
		},
	});

	td.addRule("image", {
		filter: "img",
		replacement(_content, node) {
			const alt = oneLine(node.getAttribute("alt") ?? "").replace(
				/[[\]]/g,
				"\\$&",
			);
			const src = resolveUrl(node.getAttribute("src"), baseUrl);
			return alt && src && /^https?:/.test(src)
				? `![${alt}](${linkDestination(src)})`
				: "";
		},
	});

	td.addRule("link", {
		filter: (node) => node.nodeName === "A" && node.hasAttribute("href"),
		replacement(content, node) {
			const label = content.trim();
			if (!label) return "";
			const href = linkHref(node.getAttribute("href"), baseUrl, pageUrl);
			// Block content inside a link (cards, teasers) stays as plain blocks.
			if (!href || label.includes("\n")) return content;
			if (label === href) return href;
			return `[${label}](${linkDestination(href)})`;
		},
	});

	return td;
}

/** Text of a <pre>, keeping <br> and block children as line breaks. */
function preText(node: Node): string {
	let out = "";
	const walk = (parent: Node) => {
		for (const child of Array.from(parent.childNodes)) {
			if (child.nodeType === 3) out += child.nodeValue ?? "";
			else if (child.nodeName === "BR") out += "\n";
			else {
				if (
					(child.nodeName === "DIV" || child.nodeName === "P") &&
					out &&
					!out.endsWith("\n")
				)
					out += "\n";
				walk(child);
			}
		}
	};
	walk(node);
	return out;
}

function codeLanguage(pre: HTMLElement): string {
	for (const el of [pre, pre.querySelector("code")]) {
		if (!el) continue;
		const attr =
			el.getAttribute("data-lang") ?? el.getAttribute("data-language");
		if (attr && /^[\w+#.-]+$/.test(attr)) return attr.toLowerCase();
		const match = (el.getAttribute("class") ?? "").match(
			/(?:^|\s)(?:language|lang)-([\w+#.-]+)/,
		);
		if (match?.[1]) return match[1].toLowerCase();
	}
	return "";
}

/**
 * Lighter than turndown's default escaping: brackets, backslashes and intraword underscores
 * are left alone so prose stays readable. Escapes what would otherwise turn text into
 * emphasis, code, headings, quotes or list items.
 */
function escapeText(text: string): string {
	return text
		.replace(/[*`]/g, "\\$&")
		.replace(/_/g, (_m, offset: number, s: string) =>
			isWordChar(s[offset - 1]) && isWordChar(s[offset + 1]) ? "_" : "\\_",
		)
		.replace(/^(#{1,6}) /, "\\$1 ")
		.replace(/^([-+]) /, "\\$1 ")
		.replace(/^(\d+)\. /, "$1\\. ")
		.replace(/^>/, "\\>");
}

function isWordChar(c: string | undefined): boolean {
	return !!c && /[\p{L}\p{N}]/u.test(c);
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function resolveUrl(raw: string | null, base: string): string | undefined {
	if (!raw?.trim()) return undefined;
	try {
		return new URL(raw.trim(), base).href;
	} catch {
		return undefined;
	}
}

/** Absolute http(s)/mailto URL for a link, or undefined for in-page anchors and script/other schemes. */
function linkHref(
	raw: string | null,
	base: string,
	pageUrl: string,
): string | undefined {
	const href = resolveUrl(raw, base);
	if (!href) return undefined;
	if (href.startsWith("mailto:")) return href;
	if (!/^https?:/.test(href)) return undefined;
	const withoutHash = (u: string) => u.split("#")[0];
	if (href.includes("#") && withoutHash(href) === withoutHash(pageUrl))
		return undefined;
	return href;
}

/** Percent-encodes parentheses only when unbalanced, which would end the markdown link early. */
function linkDestination(url: string): string {
	const open = url.split("(").length;
	const close = url.split(")").length;
	return open === close ? url : url.replace(/\(/g, "%28").replace(/\)/g, "%29");
}

/** Normalizes whitespace and collapses blank-line runs outside fenced code blocks. */
export function tidyMarkdown(markdown: string): string {
	const out: string[] = [];
	let fence: string | undefined;
	let blank = false;
	for (const raw of markdown.replace(/\r\n?/g, "\n").split("\n")) {
		const line = raw.replace(/ /g, " ").replace(/[​﻿]/g, "").trimEnd();
		const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1];
		if (fence) {
			out.push(line);
			if (marker?.startsWith(fence) && line.trim() === marker)
				fence = undefined;
			continue;
		}
		if (marker) fence = marker;
		if (!line.trim()) {
			if (!blank && out.length) out.push("");
			blank = true;
			continue;
		}
		blank = false;
		out.push(line);
	}
	return out.join("\n").trim();
}
