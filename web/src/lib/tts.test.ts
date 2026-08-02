// TTS segmentation + concatenation. The OpenAI call is stubbed at `fetch`:
// what matters here is that no request exceeds the API's 4096-character cap,
// that segments are concatenated in ORDER (out-of-order audio is scrambled
// but not obviously broken), and that failures surface as PipelineError.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PipelineError } from "./pipelineError";
import { configuredVoice, speechSegments, synthesizeSpeech } from "./tts";

const MAX_INPUT_CHARS = 4096;

const originalEnv = { ...process.env };

beforeEach(() => {
	process.env.OPENAI_API_KEY = "test-key";
	delete process.env.TTS_VOICE;
});

afterEach(() => {
	vi.unstubAllGlobals();
	process.env = { ...originalEnv };
});

/** Bodies of every speech request made, in call order. */
type Captured = { input: string; voice: string; model: string };

/**
 * Stubs `fetch` so each segment returns a distinct one-byte "mp3" derived
 * from its call index — making concatenation order directly assertable.
 */
function stubSpeech(options: { fail?: number; status?: number } = {}) {
	const captured: Captured[] = [];
	let call = 0;

	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url: string, init: RequestInit) => {
			const body = JSON.parse(String(init.body)) as Captured;
			captured.push(body);
			const index = call++;

			if (options.fail === index) {
				return new Response("upstream boom", {
					status: options.status ?? 500,
				});
			}
			// One byte per segment, valued by position in the INPUT list so the
			// assertion catches reordering even under concurrency.
			const position = captured.length - 1;
			return new Response(new Uint8Array([position + 1]), { status: 200 });
		}),
	);

	return captured;
}

describe("speechSegments", () => {
	it("returns one segment for short text", () => {
		expect(speechSegments("Hello there.")).toEqual(["Hello there."]);
	});

	it("returns [] for empty input", () => {
		expect(speechSegments("   ")).toEqual([]);
	});

	it("never exceeds the API's 4096-character cap", () => {
		const long = Array.from(
			{ length: 500 },
			(_, i) => `Sentence number ${i} in a long transcript.`,
		).join(" ");
		const segments = speechSegments(long);

		expect(segments.length).toBeGreaterThan(1);
		for (const segment of segments) {
			expect(segment.length).toBeLessThanOrEqual(MAX_INPUT_CHARS);
		}
	});

	it("breaks between sentences, not mid-word", () => {
		const long = `${"Word ".repeat(1200)}End.`;
		for (const segment of speechSegments(long)) {
			expect(segment).not.toMatch(/\bWor$/);
		}
	});
});

describe("configuredVoice", () => {
	it("defaults when TTS_VOICE is unset", () => {
		expect(configuredVoice()).toBe("sage");
	});

	it("honours a recognized voice, case-insensitively", () => {
		process.env.TTS_VOICE = "Nova";
		expect(configuredVoice()).toBe("nova");
	});

	it("falls back to the default on an unrecognized voice", () => {
		process.env.TTS_VOICE = "not-a-voice";
		expect(configuredVoice()).toBe("sage");
	});
});

describe("synthesizeSpeech", () => {
	it("throws when OPENAI_API_KEY is unset", async () => {
		delete process.env.OPENAI_API_KEY;
		await expect(synthesizeSpeech("hello")).rejects.toThrow(PipelineError);
	});

	it("throws on empty text", async () => {
		stubSpeech();
		await expect(synthesizeSpeech("   ")).rejects.toMatchObject({
			code: "empty_input",
		});
	});

	it("makes one request per segment, each within the cap", async () => {
		const captured = stubSpeech();
		const long = Array.from(
			{ length: 400 },
			(_, i) => `Sentence ${i} of the transcript.`,
		).join(" ");

		const result = await synthesizeSpeech(long);

		expect(captured.length).toBeGreaterThan(1);
		expect(result.segmentCount).toBe(captured.length);
		for (const request of captured) {
			expect(request.input.length).toBeLessThanOrEqual(MAX_INPUT_CHARS);
			expect(request.model).toBe("gpt-4o-mini-tts");
		}
	});

	it("concatenates segment audio in input order even when responses resolve out of order", async () => {
		// Long enough to need several segments, so ordering is meaningful.
		const long = Array.from(
			{ length: 400 },
			(_, i) => `Sentence ${i} of the transcript.`,
		).join(" ");
		const segments = speechSegments(long);
		expect(segments.length).toBeGreaterThan(2);

		// Each response's byte is keyed to the segment's position in the INPUT,
		// and earlier segments are delayed LONGER so responses arrive in
		// reverse. An implementation that appends on arrival scrambles the
		// audio; one that writes results by index does not.
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string, init: RequestInit) => {
				const { input } = JSON.parse(String(init.body)) as { input: string };
				const index = segments.indexOf(input);
				await new Promise((resolve) =>
					setTimeout(resolve, (segments.length - index) * 5),
				);
				return new Response(new Uint8Array([index + 1]), { status: 200 });
			}),
		);

		const result = await synthesizeSpeech(long);

		expect(result.segmentCount).toBe(segments.length);
		expect(result.audio).toEqual(
			Uint8Array.from({ length: segments.length }, (_, i) => i + 1),
		);
	});

	it("reports the voice and character count it used", async () => {
		process.env.TTS_VOICE = "verse";
		const captured = stubSpeech();

		const result = await synthesizeSpeech("A short sentence to speak.");

		expect(result.voice).toBe("verse");
		expect(captured[0].voice).toBe("verse");
		expect(result.charCount).toBe("A short sentence to speak.".length);
		expect(result.segmentCount).toBe(1);
	});

	it("lets an explicit voice override the environment", async () => {
		process.env.TTS_VOICE = "verse";
		const captured = stubSpeech();

		await synthesizeSpeech("Hello.", { voice: "onyx" });

		expect(captured[0].voice).toBe("onyx");
	});

	it("surfaces a 401 as a non-retryable PipelineError", async () => {
		stubSpeech({ fail: 0, status: 401 });
		await expect(synthesizeSpeech("Hello.")).rejects.toMatchObject({
			code: "unauthorized",
			retryable: false,
		});
	});

	it("surfaces a 429 as retryable", async () => {
		stubSpeech({ fail: 0, status: 429 });
		await expect(synthesizeSpeech("Hello.")).rejects.toMatchObject({
			code: "rate_limited",
			retryable: true,
		});
	});

	it("fails the whole synthesis if any segment fails", async () => {
		// Never return partial audio: a silently half-read article is worse
		// than a visible error.
		stubSpeech({ fail: 1, status: 500 });
		const long = Array.from(
			{ length: 400 },
			(_, i) => `Sentence ${i} of the transcript.`,
		).join(" ");

		await expect(synthesizeSpeech(long)).rejects.toBeInstanceOf(PipelineError);
	});

	it("rejects an empty audio body", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(new Uint8Array([]), { status: 200 })),
		);
		await expect(synthesizeSpeech("Hello.")).rejects.toMatchObject({
			code: "empty_audio",
		});
	});
});
