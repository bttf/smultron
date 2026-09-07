// Bucket bootstrapping on the upload paths — audio (SPEC §10) and screenshots
// (m23, SPEC §15.1) — plus the screenshot path/URL helpers.
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
	delete process.env.BOOKMARK_SCREENSHOT_BUCKET;
	// `ensureBucket` memoizes per process; a fresh module per test keeps the
	// cases independent.
	vi.resetModules();
});

afterEach(() => {
	vi.unstubAllGlobals();
	process.env = { ...originalEnv };
});

type Call = {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: string;
};

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
			calls.push({
				url,
				method,
				headers: (init.headers ?? {}) as Record<string, string>,
				body: typeof init.body === "string" ? init.body : undefined,
			});

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

const SHOT_PATH = "11111111-1111-4111-8111-111111111111/7/abc.jpg";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);

async function uploadShot(path = SHOT_PATH) {
	const { uploadScreenshot } = await import("./storage");
	await uploadScreenshot(path, JPEG);
}

// m23 (SPEC §15.1): the screenshot bucket is created PUBLIC with a JPEG-only
// mime allow-list and a 2 MiB object cap, and shares `ensureBucket` with the
// private audio bucket — so every already-exists shape must behave identically
// for it, and the two memos must not shadow each other.
describe("uploadScreenshot bucket bootstrap", () => {
	it("creates a public, JPEG-only, size-capped bucket then uploads", async () => {
		const calls = stubFetch({ createStatus: 200 });

		await uploadShot();

		const create = calls[0];
		expect(create.url).toMatch(/\/storage\/v1\/bucket$/);
		expect(JSON.parse(create.body ?? "{}")).toEqual({
			id: "bookmark-screenshots",
			name: "bookmark-screenshots",
			public: true,
			allowed_mime_types: ["image/jpeg"],
			file_size_limit: 2 * 1024 * 1024,
		});

		const upload = calls[1];
		expect(upload.url).toBe(
			`https://project.supabase.co/storage/v1/object/bookmark-screenshots/${SHOT_PATH}`,
		);
		expect(upload.method).toBe("POST");
		expect(upload.headers["Content-Type"]).toBe("image/jpeg");
		expect(upload.headers["cache-control"]).toBe("max-age=31536000");
		// No overwrite path in m23: the object path is fresh every time.
		expect(upload.headers["x-upsert"]).toBeUndefined();
	});

	it("honours BOOKMARK_SCREENSHOT_BUCKET", async () => {
		const calls = stubFetch({ createStatus: 200 });
		process.env.BOOKMARK_SCREENSHOT_BUCKET = "shots";

		await uploadShot();

		expect(JSON.parse(calls[0].body ?? "{}").id).toBe("shots");
		expect(calls[1].url).toContain("/object/shots/");
	});

	it.each([
		["a plain 409", { createStatus: 409 }],
		[
			"Supabase's 400-wrapped duplicate",
			{
				createStatus: 400,
				createBody: JSON.stringify({
					statusCode: "409",
					error: "Duplicate",
					code: "BucketAlreadyExists",
				}),
			},
		],
	])("treats %s as an existing bucket", async (_label, options) => {
		const calls = stubFetch(options);

		await uploadShot();

		expect(calls.map((c) => c.method)).toEqual(["POST", "POST"]);
	});

	it("proceeds when an unrecognized failure turns out to have a bucket anyway", async () => {
		const calls = stubFetch({
			createStatus: 400,
			createBody: "not json at all",
			bucketGetStatus: 200,
		});

		await uploadShot();

		expect(calls.map((c) => c.method)).toEqual(["POST", "GET", "POST"]);
	});

	it("fails when the bucket neither was created nor exists", async () => {
		stubFetch({
			createStatus: 403,
			createBody: JSON.stringify({ message: "not authorized" }),
			bucketGetStatus: 404,
		});

		await expect(uploadShot()).rejects.toMatchObject({
			name: "PipelineError",
			step: "storage",
			code: "bucket_http_403",
			retryable: false,
		});
	});

	it("marks a 5xx upload failure retryable and a 4xx not", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: RequestInit = {}) => {
				if (url.endsWith("/bucket") && init.method === "POST") {
					return new Response("", { status: 200 });
				}
				return new Response("nope", { status: 503 });
			}),
		);
		await expect(uploadShot()).rejects.toMatchObject({
			code: "upload_http_503",
			retryable: true,
		});

		vi.resetModules();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init: RequestInit = {}) => {
				if (url.endsWith("/bucket") && init.method === "POST") {
					return new Response("", { status: 200 });
				}
				return new Response("nope", { status: 400 });
			}),
		);
		await expect(uploadShot()).rejects.toMatchObject({
			code: "upload_http_400",
			retryable: false,
		});
	});

	it("memoizes the two buckets independently", async () => {
		const calls = stubFetch({ createStatus: 200 });
		const { uploadAudio, uploadScreenshot } = await import("./storage");

		await uploadScreenshot(SHOT_PATH, JPEG);
		await uploadAudio("user/1/summary-sage.mp3", new Uint8Array([1]));
		// Second round: both buckets are already known, so neither is re-created.
		await uploadScreenshot("user/2/other.jpg", JPEG);
		await uploadAudio("user/1/full-sage.mp3", new Uint8Array([2]));

		const creates = calls.filter((c) => c.url.endsWith("/bucket"));
		expect(creates).toHaveLength(2);
		expect(creates.map((c) => JSON.parse(c.body ?? "{}").id)).toEqual([
			"bookmark-screenshots",
			"article-audio",
		]);
	});
});

describe("deleteScreenshot", () => {
	it("DELETEs the object in the screenshot bucket", async () => {
		const calls = stubFetch({ createStatus: 200 });
		const { deleteScreenshot } = await import("./storage");

		await deleteScreenshot(SHOT_PATH);

		expect(calls).toEqual([
			expect.objectContaining({
				method: "DELETE",
				url: `https://project.supabase.co/storage/v1/object/bookmark-screenshots/${SHOT_PATH}`,
			}),
		]);
	});

	it("never throws — it only ever removes an unreferenced object", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("network down");
			}),
		);
		const { deleteScreenshot } = await import("./storage");

		await expect(deleteScreenshot(SHOT_PATH)).resolves.toBeUndefined();

		// Unconfigured Storage is swallowed the same way (config() throws).
		delete process.env.SUPABASE_SERVICE_ROLE_KEY;
		await expect(deleteScreenshot(SHOT_PATH)).resolves.toBeUndefined();
	});
});

describe("screenshot path and public URL", () => {
	it("mints <userId>/<bookmarkId>/<32 hex>.jpg, fresh every time", async () => {
		const { screenshotObjectPath } = await import("./storage");
		const user = "11111111-1111-4111-8111-111111111111";

		const a = screenshotObjectPath(user, 42);
		const b = screenshotObjectPath(user, 42);

		expect(a).toMatch(new RegExp(`^${user}/42/[0-9a-f]{32}\\.jpg$`));
		expect(b).not.toBe(a);
	});

	it("builds the public base, and concatenating a path gives the object URL", async () => {
		const { screenshotObjectPath, screenshotPublicBase } = await import(
			"./storage"
		);
		const user = "11111111-1111-4111-8111-111111111111";
		const path = screenshotObjectPath(user, 7);

		expect(`${screenshotPublicBase()}${path}`).toBe(
			`https://project.supabase.co/storage/v1/object/public/bookmark-screenshots/${path}`,
		);
	});

	it("returns null when Storage is unconfigured — and never throws", async () => {
		delete process.env.NEXT_PUBLIC_SUPABASE_URL;
		const { screenshotPublicBase } = await import("./storage");

		expect(screenshotPublicBase()).toBeNull();
	});
});
