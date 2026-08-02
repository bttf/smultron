// Boundary-aware text splitting — SPEC §10 (article pipeline).
//
// Used twice, with different limits and different notions of a "good" split:
//
//   1. The LLM clean pass, over raw Firecrawl markdown. A long article won't
//      fit in one request's output budget, so it's cleaned in chunks and the
//      cleaned pieces are rejoined. Splitting at headings/blank lines keeps
//      each chunk a self-contained run of prose.
//   2. TTS, over the cleaned transcript. OpenAI's /v1/audio/speech caps
//      `input` at 4096 CHARACTERS (a hard API limit, not a suggestion), so a
//      transcript of any real length must be spoken in segments and the mp3s
//      concatenated. Splitting mid-sentence would be audible.
//
// The algorithm is the same in both cases: try the most desirable separator
// first, and only fall back to a coarser one when a piece still doesn't fit.
// A chunk is emitted as soon as adding the next piece would exceed `limit`,
// so chunks are as full as the boundaries allow.

/** Separators tried in order, most-desirable first. */
export type Separators = readonly RegExp[];

/**
 * Markdown: prefer to break before a heading, then at blank lines
 * (paragraph/list/code-fence gaps), then at single newlines.
 * `m` so `^` matches at line starts.
 */
export const MARKDOWN_SEPARATORS: Separators = [
	/(?=^#{1,6} )/m,
	/\n{2,}/,
	/\n/,
];

/**
 * Prose for speech: prefer paragraph gaps, then sentence ends (a `.`/`!`/`?`
 * — optionally closed by a quote or bracket — followed by whitespace), then
 * any whitespace. The sentence pattern is deliberately conservative: it will
 * happily split after "Inc." or "Dr.", which is harmless here because the
 * pieces are rejoined into the same chunk unless the limit forces a break.
 */
export const PROSE_SEPARATORS: Separators = [
	/\n{2,}/,
	/(?<=[.!?]["')\]]?)\s+/,
	/\s+/,
];

export type ChunkOptions = {
	/** Hard maximum size, in characters, of every returned chunk. */
	limit: number;
	/** Separators tried in order; defaults to `PROSE_SEPARATORS`. */
	separators?: Separators;
};

/**
 * Splits `text` on `separator`, keeping the separator attached to the piece
 * that precedes it so a rejoin is lossless. Returns `[text]` when the
 * separator doesn't match anywhere.
 */
function splitKeepingSeparators(text: string, separator: RegExp): string[] {
	// A lookahead separator (e.g. the markdown heading rule) consumes nothing,
	// so `split` already yields the pieces with their boundaries intact.
	const source = separator.source;
	const isLookahead = source.startsWith("(?=");
	const flags = separator.flags.includes("g")
		? separator.flags
		: `${separator.flags}g`;
	const global = new RegExp(source, flags);

	if (isLookahead) {
		return text.split(global).filter((piece) => piece !== "");
	}

	const pieces: string[] = [];
	let cursor = 0;
	for (const match of text.matchAll(global)) {
		// Zero-length matches can't advance the cursor — skip them so this
		// can't loop forever on a pathological separator.
		if (match[0].length === 0) {
			continue;
		}
		const end = match.index + match[0].length;
		pieces.push(text.slice(cursor, end));
		cursor = end;
	}
	if (cursor < text.length) {
		pieces.push(text.slice(cursor));
	}
	return pieces.length > 0 ? pieces : [text];
}

/**
 * Breaks a piece that no separator could get under `limit` into hard slices.
 * Last resort — reached only by text with no whitespace at all for `limit`
 * characters (minified blobs, long URLs, CJK without spaces).
 */
function hardSlice(text: string, limit: number): string[] {
	const slices: string[] = [];
	for (let i = 0; i < text.length; i += limit) {
		slices.push(text.slice(i, i + limit));
	}
	return slices;
}

/**
 * Splits `text` into pieces that each fit within `limit`, trying `separators`
 * in order and hard-slicing only what no separator can break down.
 */
function toFittingPieces(
	text: string,
	limit: number,
	separators: Separators,
): string[] {
	if (text.length <= limit) {
		return [text];
	}

	const [separator, ...rest] = separators;
	if (!separator) {
		return hardSlice(text, limit);
	}

	const pieces = splitKeepingSeparators(text, separator);
	if (pieces.length === 1) {
		// This separator didn't help — go straight to the next one.
		return toFittingPieces(text, limit, rest);
	}

	return pieces.flatMap((piece) =>
		piece.length <= limit ? [piece] : toFittingPieces(piece, limit, rest),
	);
}

/**
 * Splits `text` into chunks of at most `limit` characters, breaking at the
 * most desirable separator that works and packing each chunk as full as those
 * boundaries allow.
 *
 * Guarantees:
 *   - every returned chunk is non-empty after trimming, and `<= limit`;
 *   - concatenating the chunks reproduces `text` modulo whitespace at the
 *     joins (chunks are trimmed, so a rejoin needs a separator of its own);
 *   - text shorter than `limit` comes back as a single chunk;
 *   - empty/whitespace-only input returns `[]`.
 *
 * `limit` must be a positive integer — a non-positive limit can't be
 * satisfied by any chunking and throws rather than looping.
 */
export function chunkText(text: string, options: ChunkOptions): string[] {
	const { limit, separators = PROSE_SEPARATORS } = options;

	if (!Number.isInteger(limit) || limit <= 0) {
		throw new RangeError(
			`chunk limit must be a positive integer, got ${limit}`,
		);
	}

	if (text.trim() === "") {
		return [];
	}

	const chunks: string[] = [];
	let current = "";

	for (const piece of toFittingPieces(text, limit, separators)) {
		if (current !== "" && current.length + piece.length > limit) {
			// Flush before overflowing. A piece that is itself whitespace-only
			// would trim to nothing — drop it rather than emit an empty chunk.
			const flushed = current.trim();
			if (flushed !== "") {
				chunks.push(flushed);
			}
			current = "";
		}
		current += piece;
	}

	const last = current.trim();
	if (last !== "") {
		chunks.push(last);
	}

	return chunks;
}

/** Words in `text`, for the article's `word_count`. */
export function countWords(text: string): number {
	const trimmed = text.trim();
	return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}
