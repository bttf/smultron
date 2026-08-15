// Bucket bootstrapping on the audio upload path (SPEC §10).
//
// The interesting case is the steady state: the bucket already exists.
// Supabase Storage reports that inconsistently — the observed production
// response is HTTP 400 carrying `{"statusCode":"409","error":"Duplicate",
// "code":"BucketAlreadyExists"}` — so an existing bucket must never fail a
// listen. Everything here stubs `fetch`; no network, no Supabase.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };

beforeEach(() => {
	process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.co";
	process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
	delete process.env.ARTICLE_AUDIO_BUCKET;
	// `ensureBucket` memoizes per process; a fresh module per test keeps the
	// cases independent.
	vi.resetModules();
});

afterEach(() => {
	vi.unstubAllGlobals();
	process.env = { ...originalEnv };
});

type Call = { url: string; method: string };

/**
 * Stubs `fetch` with a canned bucket-create response; every other request
 * (the object upload itself) succeeds.
 */
function stubFetch(options: {
	createStatus: number;
	createBody?: string;
	bucketGetStatus?: number;
}) {
	const calls: Call[] = [];

	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit = {}) => {
			const method = init.method ?? "GET";
			calls.push({ url, method });

			if (url.endsWith("/bucket") && method === "POST") {
				return new Response(options.createBody ?? "", {
					status: options.createStatus,
				});
			}
			if (url.includes("/bucket/") && method === "GET") {
				return new Response("", { status: options.bucketGetStatus ?? 404 });
			}
			return new Response("", { status: 200 });
		}),
	);

	return calls;
}

async function upload() {
	const { uploadAudio } = await import("./storage");
	await uploadAudio("user/1/summary-sage.mp3", new Uint8Array([1, 2, 3]));
}

describe("uploadAudio bucket bootstrap", () => {
	it("uploads after creating the bucket", async () => {
		const calls = stubFetch({ createStatus: 200 });

		await upload();

		expect(calls.map((c) => c.method)).toEqual(["POST", "POST"]);
		expect(calls[1].url).toContain(
			"/storage/v1/object/article-audio/user/1/summary-sage.mp3",
		);
	});

	it("treats a plain 409 as an existing bucket", async () => {
		const calls = stubFetch({ createStatus: 409 });

		await upload();

		expect(calls).toHaveLength(2);
	});

	it("treats Supabase's 400-wrapped duplicate as an existing bucket", async () => {
		// The exact production body from the reported failure.
		const calls = stubFetch({
			createStatus: 400,
			createBody: JSON.stringify({
				statusCode: "409",
				error: "Duplicate",
				message: "The resource already exists",
				code: "BucketAlreadyExists",
			}),
		});

		await upload();

		// Recognized from the body alone — no existence probe needed.
		expect(calls.map((c) => c.method)).toEqual(["POST", "POST"]);
	});

	it("proceeds when an unrecognized failure turns out to have a bucket anyway", async () => {
		const calls = stubFetch({
			createStatus: 400,
			createBody: "not json at all",
			bucketGetStatus: 200,
		});

		await upload();

		expect(calls.map((c) => c.method)).toEqual(["POST", "GET", "POST"]);
	});

	it("fails when the bucket neither was created nor exists", async () => {
		stubFetch({
			createStatus: 403,
			createBody: JSON.stringify({ message: "not authorized" }),
			bucketGetStatus: 404,
		});

		// `name` rather than `instanceof`: `vi.resetModules()` means the module
		// under test carries its own copy of the PipelineError class.
		await expect(upload()).rejects.toMatchObject({
			name: "PipelineError",
			step: "storage",
			code: "bucket_http_403",
			retryable: false,
		});
	});

	it("marks a 5xx bucket failure retryable", async () => {
		stubFetch({ createStatus: 503, bucketGetStatus: 404 });

		await expect(upload()).rejects.toMatchObject({
			code: "bucket_http_503",
			retryable: true,
		});
	});

	it("memoizes readiness across uploads", async () => {
		const calls = stubFetch({
			createStatus: 400,
			createBody: JSON.stringify({ code: "BucketAlreadyExists" }),
		});
		const { uploadAudio } = await import("./storage");

		await uploadAudio("user/1/summary-sage.mp3", new Uint8Array([1]));
		await uploadAudio("user/1/full-sage.mp3", new Uint8Array([2]));

		expect(calls.filter((c) => c.url.endsWith("/bucket"))).toHaveLength(1);
	});

	it("re-checks when the configured bucket changes", async () => {
		const calls = stubFetch({ createStatus: 200 });
		const { uploadAudio } = await import("./storage");

		await uploadAudio("user/1/summary-sage.mp3", new Uint8Array([1]));
		process.env.ARTICLE_AUDIO_BUCKET = "other-audio";
		await uploadAudio("user/1/summary-sage.mp3", new Uint8Array([1]));

		expect(calls.filter((c) => c.url.endsWith("/bucket"))).toHaveLength(2);
		expect(calls.at(-1)?.url).toContain("/object/other-audio/");
	});
});
