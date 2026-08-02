// LLM passes over scraped markdown — SPEC §10 (article pipeline, steps 2-3).
//
// Step 2 (clean): scraped markdown is not speakable. Even with Firecrawl's
// `onlyMainContent`, what comes back carries link syntax, image alt text,
// figure captions, "Share this on X", newsletter interstitials, footnote
// markers, code fences, and tables — all of which a TTS engine reads aloud
// verbatim as noise. This pass rewrites the article into continuous spoken
// prose. It is explicitly NOT a summary: nothing the author actually said is
// dropped.
//
// Step 3 (summarize): a short spoken summary, generated FROM the cleaned
// transcript rather than the raw markdown, so it never quotes scrape cruft.
//
// Both passes stream (`.stream()` + `.finalMessage()`): the clean pass emits
// article-length output, and a non-streaming request at that size risks an
// SDK HTTP timeout.
import Anthropic from "@anthropic-ai/sdk";
import { chunkText, MARKDOWN_SEPARATORS } from "./chunk";
import { PipelineError } from "./pipelineError";

const MODEL = "claude-opus-5";

/**
 * Markdown characters per clean-pass request. A chunk has to fit in the
 * request's OUTPUT budget too (the pass rewrites roughly 1:1), so this sits
 * well under `CLEAN_MAX_TOKENS` worth of text — ~24k chars is ~6k tokens in,
 * a comparable number out, leaving generous headroom.
 */
const CLEAN_CHUNK_CHARS = 24_000;

const CLEAN_MAX_TOKENS = 32_000;
const SUMMARY_MAX_TOKENS = 4_000;

/** Guards against a pathological page turning into a 40-minute LLM bill. */
const MAX_CLEAN_CHUNKS = 12;

let client: Anthropic | undefined;

/**
 * Lazy singleton, mirroring `db/index.ts`: importing this module must not
 * throw when ANTHROPIC_API_KEY is unset (build time, tests that never call).
 */
function anthropic(): Anthropic {
	if (!client) {
		if (!process.env.ANTHROPIC_API_KEY) {
			throw new PipelineError(
				"clean",
				"not_configured",
				"ANTHROPIC_API_KEY is not set.",
			);
		}
		client = new Anthropic();
	}
	return client;
}

const CLEAN_SYSTEM = `You convert scraped web-page markdown into clean prose for a text-to-speech reader.

The text you receive was extracted automatically from a web page, so it contains artifacts that make no sense when read aloud. Remove them, and rewrite what remains so it flows as continuous spoken prose.

Remove entirely:
- Navigation crumbs, menus, "skip to content", cookie and consent notices
- Newsletter and subscription interstitials, paywall prompts, app-download nags
- Social calls to action ("Share this", "Follow us on X", like/comment counts)
- Author bio boxes, related-article lists, "read next", tag lists, comment threads
- Image markdown, figure captions, alt text, and photo credits
- Advertisement blocks and sponsor labels
- Timestamps, bylines, and datelines that repeat outside the article body
- Footnote markers and reference superscripts (keep the substance if a footnote states a fact inline)

Convert rather than delete:
- Markdown links: keep the link TEXT, drop the URL and brackets. Never read a URL aloud.
- Headings: turn into a spoken transition ("Turning to the second argument," / "On the question of cost,") or drop them if the flow already reads naturally. Never leave "#" characters or a bare heading fragment.
- Lists: rewrite as flowing sentences ("There are three reasons. First, ... Second, ...") rather than bullet fragments.
- Tables: state the point the table makes in a sentence or two. Never read a table row by row.
- Code blocks: replace with a one-line spoken description of what the code does. Never read code character by character.
- Numbers, symbols, and abbreviations: write as they should be SPOKEN ("about 45 percent", "roughly 3.2 million dollars", "for example", "versus"). Expand "e.g.", "i.e.", "&", "%", "#", and units.
- Block quotes: introduce the speaker in prose ("As Chen put it, ...").

Preserve:
- Every substantive claim, argument, example, and piece of evidence the author made
- The author's ordering, voice, and register
- Named entities and direct quotes, verbatim

Rules:
- This is a faithful rewrite, NOT a summary. Do not condense, skip, or editorialize. The output should be close in length to the article's actual prose.
- Output plain text only. No markdown syntax whatsoever: no #, *, _, backticks, brackets, or pipes.
- Do not add a preamble, a title, a sign-off, or any commentary about your task. Do not say "Here is the cleaned text". Begin directly with the article's first spoken sentence.
- Write in paragraphs separated by a blank line.
- If a passage is pure boilerplate with no article content, output nothing for it rather than inventing filler.`;

const SUMMARY_SYSTEM = `You write short spoken summaries of articles, to be played as audio before (or instead of) the full reading.

Write for the ear, not the page:
- 150 to 250 words, in flowing paragraphs. No headings, no bullet points, no markdown.
- Open with one sentence that says what the piece is and what it argues or reports. Do not open with "This article" more than once.
- Then give the substance: the main claims, the evidence behind them, and any conclusion the author reaches. Prefer the author's specifics over generalities.
- Close with what a listener should take away, only if the piece actually supports one.
- Spell numbers, symbols, and abbreviations as they should be spoken.
- Stay faithful to the source. Do not add facts, opinions, or context the article does not contain.
- Output the summary text only, with no preamble or commentary.`;

/**
 * One streamed Messages request, returning the concatenated text blocks.
 *
 * `effort: medium` on both passes: neither is an open-ended reasoning problem
 * — one is a mechanical-but-judgement-laden rewrite, the other a summary —
 * and medium keeps latency and cost sane on multi-chunk articles.
 */
async function complete(
	step: "clean" | "summarize",
	system: string,
	userText: string,
	maxTokens: number,
): Promise<string> {
	let message: Anthropic.Message;
	try {
		const stream = anthropic().messages.stream({
			model: MODEL,
			max_tokens: maxTokens,
			system,
			thinking: { type: "adaptive" },
			output_config: { effort: "medium" },
			messages: [{ role: "user", content: userText }],
		});
		message = await stream.finalMessage();
	} catch (cause) {
		if (cause instanceof Anthropic.RateLimitError) {
			throw new PipelineError(
				step,
				"rate_limited",
				"Anthropic rate limit hit. Try again shortly.",
				{ retryable: true, cause },
			);
		}
		if (cause instanceof Anthropic.AuthenticationError) {
			throw new PipelineError(
				step,
				"unauthorized",
				"Anthropic rejected the API key. Check ANTHROPIC_API_KEY.",
				{ cause },
			);
		}
		if (cause instanceof Anthropic.APIConnectionError) {
			throw new PipelineError(step, "network", "Could not reach Anthropic.", {
				retryable: true,
				cause,
			});
		}
		if (cause instanceof Anthropic.APIError) {
			throw new PipelineError(
				step,
				`http_${cause.status ?? "error"}`,
				`Anthropic request failed: ${cause.message}`,
				{ retryable: (cause.status ?? 0) >= 500, cause },
			);
		}
		throw cause;
	}

	// Safety classifiers can decline (HTTP 200 + stop_reason "refusal"), and
	// `content` is then empty — check before reading it.
	if (message.stop_reason === "refusal") {
		throw new PipelineError(
			step,
			"refused",
			"The model declined to process this page's content.",
		);
	}

	const text = message.content
		.filter((block): block is Anthropic.TextBlock => block.type === "text")
		.map((block) => block.text)
		.join("")
		.trim();

	if (text === "") {
		throw new PipelineError(
			step,
			"empty_output",
			"The model returned no text.",
			{ retryable: true },
		);
	}

	return text;
}

/**
 * Rewrites scraped markdown into spoken prose.
 *
 * Long articles are cleaned in chunks (split at heading/paragraph boundaries)
 * and rejoined, because one request cannot emit an arbitrarily long article.
 * Each chunk is labelled with its position so the model knows not to write an
 * opening or a sign-off mid-article; the tail of the previous CLEANED chunk
 * is passed as context so the seam reads continuously.
 *
 * Chunks beyond `MAX_CLEAN_CHUNKS` are dropped, and the caller is told via
 * the returned `truncated` flag — silently returning a partial article as if
 * it were whole would be worse.
 */
export async function cleanToTranscript(
	markdown: string,
	options: { title?: string | null } = {},
): Promise<{ transcript: string; truncated: boolean }> {
	const allChunks = chunkText(markdown, {
		limit: CLEAN_CHUNK_CHARS,
		separators: MARKDOWN_SEPARATORS,
	});

	if (allChunks.length === 0) {
		throw new PipelineError(
			"clean",
			"empty_input",
			"There was no scraped text to clean.",
		);
	}

	const truncated = allChunks.length > MAX_CLEAN_CHUNKS;
	const chunks = truncated ? allChunks.slice(0, MAX_CLEAN_CHUNKS) : allChunks;

	const cleaned: string[] = [];
	for (const [index, chunk] of chunks.entries()) {
		const position =
			chunks.length === 1
				? "This is the complete article."
				: `This is part ${index + 1} of ${chunks.length} of a longer article.` +
					(index > 0
						? " Continue directly from the preceding part — do not re-introduce the topic."
						: "") +
					(index < chunks.length - 1
						? " More parts follow — do not write a conclusion or sign-off."
						: "");

		// The tail of the previous CLEANED output (not the raw markdown) is
		// the right seam context: it's what the listener just heard.
		const previous = cleaned.at(-1);
		const carry = previous
			? `\n\nFor continuity, here are the last words of the previous part as you rewrote them. Do not repeat them; continue after them:\n<previous>\n${previous.slice(-600)}\n</previous>`
			: "";

		const titleLine = options.title ? `\nArticle title: ${options.title}` : "";

		cleaned.push(
			await complete(
				"clean",
				CLEAN_SYSTEM,
				`${position}${titleLine}${carry}\n\nRewrite the following scraped markdown as spoken prose:\n\n<markdown>\n${chunk}\n</markdown>`,
				CLEAN_MAX_TOKENS,
			),
		);
	}

	return { transcript: cleaned.join("\n\n"), truncated };
}

/**
 * Writes a spoken summary of an already-cleaned transcript.
 *
 * Only the head of a very long transcript is sent: a summary is shaped by the
 * opening and the thesis far more than the tail, and this bounds cost on
 * book-length pages.
 */
export async function summarizeTranscript(
	transcript: string,
	options: { title?: string | null } = {},
): Promise<string> {
	const trimmed = transcript.trim();
	if (trimmed === "") {
		throw new PipelineError(
			"summarize",
			"empty_input",
			"There was no transcript to summarize.",
		);
	}

	const body = trimmed.slice(0, 60_000);
	const titleLine = options.title ? `Article title: ${options.title}\n\n` : "";

	return complete(
		"summarize",
		SUMMARY_SYSTEM,
		`${titleLine}Summarize the following article for a listener:\n\n<article>\n${body}\n</article>`,
		SUMMARY_MAX_TOKENS,
	);
}
