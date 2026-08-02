// Text-to-speech synthesis — SPEC §10 (article pipeline, step 4).
//
// OpenAI's POST /v1/audio/speech caps `input` at 4096 CHARACTERS, which no
// real article transcript respects. So the text is segmented on sentence and
// paragraph boundaries (lib/chunk.ts) and each segment synthesized
// separately; the resulting mp3 buffers are concatenated. MP3 is a stream of
// self-contained frames, so byte concatenation yields a single playable file
// — no re-encode, and no ffmpeg dependency in a serverless function.
//
// Segments are synthesized with bounded concurrency: fully serial is slow on
// a long article, fully parallel trips OpenAI's rate limit.
import { chunkText } from "./chunk";
import { PipelineError } from "./pipelineError";

const SPEECH_URL = "https://api.openai.com/v1/audio/speech";

/** OpenAI's documented hard cap on `input`. Not a tunable. */
const MAX_INPUT_CHARS = 4096;

const MODEL = "gpt-4o-mini-tts";

/** Voices the speech endpoint accepts; used to validate TTS_VOICE. */
const VOICES = [
	"alloy",
	"ash",
	"ballad",
	"coral",
	"echo",
	"fable",
	"onyx",
	"nova",
	"sage",
	"shimmer",
	"verse",
	"marin",
	"cedar",
] as const;

export type Voice = (typeof VOICES)[number];

const DEFAULT_VOICE: Voice = "sage";

/** Concurrent speech requests. Enough to be quick, low enough to stay under
 * the per-minute request limit on a modest OpenAI tier. */
const CONCURRENCY = 3;

const REQUEST_TIMEOUT_MS = 60_000;

/**
 * How the narrator should sound. `gpt-4o-mini-tts` accepts free-text
 * `instructions` (unlike tts-1), which is what makes it worth using here:
 * article narration wants a measured reading voice, not the default cadence.
 */
const INSTRUCTIONS =
	"Read as a calm, articulate narrator reading an article aloud to one listener. " +
	"Measured, unhurried pace with natural pauses at sentence and paragraph breaks. " +
	"Warm and engaged but not performative — inform, do not sell. " +
	"Keep tone and volume consistent throughout.";

/**
 * Resolves the configured voice. An unrecognized `TTS_VOICE` falls back to
 * the default rather than failing synthesis — a typo in optional config
 * shouldn't break the feature.
 */
export function configuredVoice(): Voice {
	const value = process.env.TTS_VOICE?.trim().toLowerCase();
	return VOICES.includes(value as Voice) ? (value as Voice) : DEFAULT_VOICE;
}

/**
 * Segments `text` into pieces the speech endpoint will accept.
 * Exported for tests and so callers can report `segmentCount` up front.
 */
export function speechSegments(text: string): string[] {
	return chunkText(text, { limit: MAX_INPUT_CHARS });
}

/** Synthesizes ONE segment (must already be within the character cap). */
async function synthesizeSegment(
	text: string,
	voice: Voice,
	apiKey: string,
): Promise<Uint8Array> {
	let response: Response;
	try {
		response = await fetch(SPEECH_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: MODEL,
				voice,
				input: text,
				instructions: INSTRUCTIONS,
				response_format: "mp3",
			}),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	} catch (cause) {
		const timedOut =
			cause instanceof Error &&
			(cause.name === "AbortError" || cause.name === "TimeoutError");
		throw new PipelineError(
			"speech",
			timedOut ? "timeout" : "network",
			timedOut
				? "OpenAI did not respond in time."
				: "Could not reach the OpenAI speech API.",
			{ retryable: true, cause },
		);
	}

	if (!response.ok) {
		const body = await response.text().catch(() => "");
		if (response.status === 401) {
			throw new PipelineError(
				"speech",
				"unauthorized",
				"OpenAI rejected the API key. Check OPENAI_API_KEY.",
			);
		}
		if (response.status === 429) {
			throw new PipelineError(
				"speech",
				"rate_limited",
				"OpenAI rate limit hit. Try again shortly.",
				{ retryable: true },
			);
		}
		throw new PipelineError(
			"speech",
			`http_${response.status}`,
			`OpenAI speech request failed (${response.status}): ${body.slice(0, 200)}`,
			{ retryable: response.status >= 500 },
		);
	}

	const buffer = new Uint8Array(await response.arrayBuffer());
	if (buffer.byteLength === 0) {
		throw new PipelineError(
			"speech",
			"empty_audio",
			"OpenAI returned an empty audio response.",
			{ retryable: true },
		);
	}
	return buffer;
}

/**
 * Runs `task` over every item with at most `limit` in flight, preserving
 * input order in the results. Order matters absolutely here — segments
 * concatenated out of order would produce scrambled audio.
 */
async function mapWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;

	const workers = Array.from(
		{ length: Math.min(limit, items.length) },
		async () => {
			while (true) {
				const index = next++;
				if (index >= items.length) {
					return;
				}
				results[index] = await task(items[index], index);
			}
		},
	);

	await Promise.all(workers);
	return results;
}

export type Synthesized = {
	/** Concatenated mp3 bytes, ready to upload. */
	audio: Uint8Array;
	voice: Voice;
	charCount: number;
	segmentCount: number;
};

/**
 * Synthesizes `text` into a single mp3.
 *
 * Throws `PipelineError` when the key is unset, any segment fails, or the
 * text is empty. Partial audio is never returned: a half-read article that
 * looks complete is worse than a visible failure.
 */
export async function synthesizeSpeech(
	text: string,
	options: { voice?: Voice } = {},
): Promise<Synthesized> {
	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey) {
		throw new PipelineError(
			"speech",
			"not_configured",
			"OPENAI_API_KEY is not set.",
		);
	}

	const segments = speechSegments(text);
	if (segments.length === 0) {
		throw new PipelineError(
			"speech",
			"empty_input",
			"There was no text to speak.",
		);
	}

	const voice = options.voice ?? configuredVoice();
	const buffers = await mapWithConcurrency(segments, CONCURRENCY, (segment) =>
		synthesizeSegment(segment, voice, apiKey),
	);

	const total = buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
	const audio = new Uint8Array(total);
	let offset = 0;
	for (const buffer of buffers) {
		audio.set(buffer, offset);
		offset += buffer.byteLength;
	}

	return {
		audio,
		voice,
		charCount: segments.reduce((sum, segment) => sum + segment.length, 0),
		segmentCount: segments.length,
	};
}
