// POST /api/bookmarks/by-url/screenshot — SPEC §15.2 (m23).
//
// Real Postgres (PGlite with the production migrations, the sync.test.ts
// harness) and a real Bearer token, so auth, URL normalization and the
// keep-first UPDATE are exercised as written. Only Supabase Storage is faked:
// the route's contract with it is "upload, or throw PipelineError", and that
// boundary is covered in storage.test.ts.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { eq, sql } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import * as schema from "../../../../../db/schema";
import { apiTokens, bookmarks } from "../../../../../db/schema";
import { hashToken } from "../../../../../lib/pairing";
import { PipelineError } from "../../../../../lib/pipelineError";

const SHOT_BASE =
	"https://project.supabase.co/storage/v1/object/public/bookmark-screenshots/";

// Hoisted so the module factories below (which vitest lifts above the imports)
// can reach them.
const mocks = vi.hoisted(() => ({
	// biome-ignore lint/suspicious/noExplicitAny: the PGlite drizzle instance is installed after the mock is registered.
	dbRef: { current: null as any },
	suffix: { current: "aaaa.jpg" },
	uploadScreenshot: vi.fn(async (_path: string, _image: Uint8Array) => {}),
	deleteScreenshot: vi.fn(async (_path: string) => {}),
}));

// Mirrors the production lazy-singleton proxy (src/db/index.ts), pointed at
// PGlite. `apiTokenAuth` imports the same module, so token auth is real too.
vi.mock("../../../../../db", () => ({
	db: new Proxy(
		{},
		{
			get(_target, prop, receiver) {
				return Reflect.get(mocks.dbRef.current as object, prop, receiver);
			},
		},
	),
}));

vi.mock("../../../../../lib/storage", () => ({
	SCREENSHOT_MAX_BYTES: 2 * 1024 * 1024,
	screenshotPublicBase: () => SHOT_BASE,
	screenshotObjectPath: (userId: string, bookmarkId: number) =>
		`${userId}/${bookmarkId}/${mocks.suffix.current}`,
	uploadScreenshot: mocks.uploadScreenshot,
	deleteScreenshot: mocks.deleteScreenshot,
}));

const { POST } = await import("./route");

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const TOKEN_A = "token-for-user-a";
const TOKEN_B = "token-for-user-b";

const URL_A = "https://example.com/article";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const SAVED_AT = new Date("2026-02-02T03:04:05.678Z");

const drizzleDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../../../../../drizzle",
);

let client: PGlite;
let db: PgliteDatabase<typeof schema>;

beforeAll(async () => {
	client = new PGlite({ extensions: { pg_trgm } });
	await client.exec(
		"CREATE SCHEMA auth; CREATE TABLE auth.users (id uuid PRIMARY KEY);",
	);

	const journal = JSON.parse(
		readFileSync(join(drizzleDir, "meta/_journal.json"), "utf8"),
	) as { entries: Array<{ tag: string }> };
	for (const entry of journal.entries) {
		const migration = readFileSync(
			join(drizzleDir, `${entry.tag}.sql`),
			"utf8",
		);
		for (const statement of migration.split("--> statement-breakpoint")) {
			await client.exec(statement);
		}
	}

	await client.exec(
		`INSERT INTO auth.users (id) VALUES ('${USER_A}'), ('${USER_B}');`,
	);

	db = drizzle(client, { schema });
	mocks.dbRef.current = db;

	await db.insert(apiTokens).values([
		{ userId: USER_A, tokenHash: hashToken(TOKEN_A), createdAt: new Date() },
		{ userId: USER_B, tokenHash: hashToken(TOKEN_B), createdAt: new Date() },
	]);
});

afterAll(async () => {
	await client.close();
});

beforeEach(async () => {
	await db.execute(sql`DELETE FROM smultron.bookmarks`);
	mocks.suffix.current = "aaaa.jpg";
	mocks.uploadScreenshot.mockReset();
	mocks.uploadScreenshot.mockResolvedValue(undefined);
	mocks.deleteScreenshot.mockReset();
	mocks.deleteScreenshot.mockResolvedValue(undefined);
});

async function seedBookmark(
	userId = USER_A,
	url = URL_A,
	extra: { archivedAt?: Date } = {},
): Promise<number> {
	const [row] = await db
		.insert(bookmarks)
		.values({
			userId,
			url,
			urlNormalized: url,
			title: "Article",
			tags: ["t"],
			faviconUrl: "https://example.com/icon.png",
			createdAt: SAVED_AT,
			updatedAt: SAVED_AT,
			archivedAt: extra.archivedAt ?? null,
		})
		.returning({ id: bookmarks.id });
	return row.id;
}

async function rawRow(id: number) {
	const [row] = await db.select().from(bookmarks).where(eq(bookmarks.id, id));
	return row;
}

type CallOptions = {
	token?: string | null;
	url?: string | null;
	contentType?: string | null;
	contentLength?: string;
	body?: BodyInit | null;
};

function post(options: CallOptions = {}): Promise<Response> {
	const {
		token = TOKEN_A,
		url = URL_A,
		contentType = "image/jpeg",
		contentLength,
		body = JPEG,
	} = options;

	const target = new URL(
		"http://localhost:3000/api/bookmarks/by-url/screenshot",
	);
	if (url !== null) {
		target.searchParams.set("url", url);
	}

	const headers = new Headers();
	if (token !== null) {
		headers.set("authorization", `Bearer ${token}`);
	}
	if (contentType !== null) {
		headers.set("content-type", contentType);
	}
	if (contentLength !== undefined) {
		headers.set("content-length", contentLength);
	}

	// `duplex: "half"` is required by undici for a stream body and absent from
	// the DOM RequestInit type.
	const init = { method: "POST", headers, body, duplex: "half" };
	return POST(new Request(target, init as RequestInit));
}

/** A body with no `Content-Length` — the only way to reach the ACTUAL-length check. */
function streamed(bytes: Uint8Array): BodyInit {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
}

describe("auth and addressing", () => {
	it("401s without an Authorization header", async () => {
		await seedBookmark();

		const response = await post({ token: null });

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "unauthorized" });
		expect(mocks.uploadScreenshot).not.toHaveBeenCalled();
	});

	it("401s on an unknown token", async () => {
		await seedBookmark();

		expect((await post({ token: "not-a-token" })).status).toBe(401);
	});

	it("400s when `url` is missing", async () => {
		const response = await post({ url: null });

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "invalid_url" });
	});

	it("400s when `url` is empty", async () => {
		expect((await post({ url: "" })).status).toBe(400);
	});

	it("404s when the caller has no bookmark for that URL", async () => {
		const response = await post();

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "not_found" });
		expect(mocks.uploadScreenshot).not.toHaveBeenCalled();
	});

	it("404s — never 403 — for another user's bookmark", async () => {
		await seedBookmark(USER_A);

		const response = await post({ token: TOKEN_B });

		expect(response.status).toBe(404);
		expect(mocks.uploadScreenshot).not.toHaveBeenCalled();
	});

	it("resolves the row through normalizeUrl, from the raw URL", async () => {
		const id = await seedBookmark();

		const response = await post({
			url: "HTTPS://example.com/article?utm_source=newsletter",
		});

		expect(response.status).toBe(200);
		expect((await rawRow(id)).screenshotPath).toBe(`${USER_A}/${id}/aaaa.jpg`);
	});
});

describe("body policy", () => {
	it("415s on a non-JPEG Content-Type", async () => {
		await seedBookmark();

		const response = await post({ contentType: "image/png" });

		expect(response.status).toBe(415);
		expect(await response.json()).toEqual({ error: "unsupported_media_type" });
		expect(mocks.uploadScreenshot).not.toHaveBeenCalled();
	});

	it("415s when Content-Type is absent", async () => {
		await seedBookmark();

		expect((await post({ contentType: null })).status).toBe(415);
	});

	it("accepts image/jpeg with parameters, in any case", async () => {
		await seedBookmark();

		const response = await post({ contentType: "Image/JPEG; charset=binary" });

		expect(response.status).toBe(200);
	});

	it("413s on an oversized Content-Length, without reading the body", async () => {
		await seedBookmark();

		const response = await post({ contentLength: String(2 * 1024 * 1024 + 1) });

		expect(response.status).toBe(413);
		expect(await response.json()).toEqual({ error: "too_large" });
		expect(mocks.uploadScreenshot).not.toHaveBeenCalled();
	});

	it("413s on an oversized actual body even with no Content-Length", async () => {
		await seedBookmark();
		const big = new Uint8Array(2 * 1024 * 1024 + 1);
		big.set(JPEG);

		const response = await post({ body: streamed(big) });

		expect(response.status).toBe(413);
		expect(await response.json()).toEqual({ error: "too_large" });
		expect(mocks.uploadScreenshot).not.toHaveBeenCalled();
	});

	it("accepts a body exactly at the cap", async () => {
		await seedBookmark();
		const exact = new Uint8Array(2 * 1024 * 1024);
		exact.set(JPEG);

		expect((await post({ body: exact })).status).toBe(200);
	});

	it("400s on an empty body", async () => {
		await seedBookmark();

		const response = await post({ body: new Uint8Array([]) });

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "invalid_image" });
		expect(mocks.uploadScreenshot).not.toHaveBeenCalled();
	});

	it("400s on bytes that don't start with the JPEG SOI marker", async () => {
		await seedBookmark();
		// A PNG signature, correctly labelled image/jpeg by a lying client.
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);

		const response = await post({ body: png });

		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({ error: "invalid_image" });
	});

	it("400s on a truncated SOI marker", async () => {
		await seedBookmark();

		const response = await post({ body: new Uint8Array([0xff, 0xd8]) });

		expect(response.status).toBe(400);
	});
});

describe("storing", () => {
	it("uploads to a fresh path, claims the row, and returns stored: true", async () => {
		const id = await seedBookmark();
		mocks.suffix.current = "0123456789abcdef0123456789abcdef.jpg";
		const path = `${USER_A}/${id}/0123456789abcdef0123456789abcdef.jpg`;

		const response = await post();

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			stored: true,
			bookmark: { id, url: URL_A, screenshotUrl: `${SHOT_BASE}${path}` },
		});
		expect(mocks.uploadScreenshot).toHaveBeenCalledTimes(1);
		expect(mocks.uploadScreenshot.mock.calls[0][0]).toBe(path);
		expect(Array.from(mocks.uploadScreenshot.mock.calls[0][1])).toEqual(
			Array.from(JPEG),
		);
		expect(mocks.deleteScreenshot).not.toHaveBeenCalled();
		expect((await rawRow(id)).screenshotPath).toBe(path);
	});

	it("never serializes screenshot_path", async () => {
		await seedBookmark();

		const { bookmark } = (await (await post()).json()) as {
			bookmark: Record<string, unknown>;
		};

		expect(bookmark).not.toHaveProperty("screenshotPath");
		expect(bookmark).not.toHaveProperty("screenshot_path");
	});

	// Hard rule #1 — a screenshot upload is enrichment, not a live capture.
	it("writes screenshot_path and nothing else", async () => {
		const id = await seedBookmark();
		const before = await rawRow(id);

		await post();

		const after = await rawRow(id);
		expect({ ...after, screenshotPath: null }).toEqual({
			...before,
			screenshotPath: null,
		});
		expect(after.updatedAt).toEqual(SAVED_AT);
	});

	it("accepts an archived row", async () => {
		const archivedAt = new Date("2026-03-03T00:00:00.000Z");
		const id = await seedBookmark(USER_A, URL_A, { archivedAt });

		const response = await post();

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ stored: true });
		expect((await rawRow(id)).archivedAt).toEqual(archivedAt);
	});

	it("is keep-first: a second upload stores nothing and never touches Storage", async () => {
		const id = await seedBookmark();
		await post();
		const firstPath = (await rawRow(id)).screenshotPath;
		mocks.uploadScreenshot.mockClear();
		mocks.suffix.current = "bbbb.jpg";

		const response = await post();

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			stored: false,
			bookmark: { screenshotUrl: `${SHOT_BASE}${firstPath}` },
		});
		expect(mocks.uploadScreenshot).not.toHaveBeenCalled();
		expect(mocks.deleteScreenshot).not.toHaveBeenCalled();
		expect((await rawRow(id)).screenshotPath).toBe(firstPath);
	});

	it("loses the race gracefully: deletes its object and reports the winner's", async () => {
		const id = await seedBookmark();
		const winnerPath = `${USER_A}/${id}/winner.jpg`;
		// A concurrent upload commits between the keep-first read and the UPDATE.
		mocks.uploadScreenshot.mockImplementation(async () => {
			await db
				.update(bookmarks)
				.set({ screenshotPath: winnerPath })
				.where(eq(bookmarks.id, id));
		});

		const response = await post();

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			stored: false,
			bookmark: { screenshotUrl: `${SHOT_BASE}${winnerPath}` },
		});
		expect(mocks.deleteScreenshot).toHaveBeenCalledWith(
			`${USER_A}/${id}/aaaa.jpg`,
		);
		expect((await rawRow(id)).screenshotPath).toBe(winnerPath);
	});
});

describe("Storage failures", () => {
	it("maps a retryable PipelineError to 503", async () => {
		await seedBookmark();
		mocks.uploadScreenshot.mockRejectedValue(
			new PipelineError("storage", "upload_http_503", "Storage is down.", {
				retryable: true,
			}),
		);

		const response = await post();

		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			error: "storage",
			message: "Storage is down.",
		});
	});

	it("maps a non-retryable PipelineError to 502", async () => {
		await seedBookmark();
		mocks.uploadScreenshot.mockRejectedValue(
			new PipelineError("storage", "not_configured", "Storage is not set up.", {
				retryable: false,
			}),
		);

		const response = await post();

		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({
			error: "storage",
			message: "Storage is not set up.",
		});
	});

	it("leaves the row untouched when the upload fails", async () => {
		const id = await seedBookmark();
		mocks.uploadScreenshot.mockRejectedValue(
			new PipelineError("storage", "upload_http_500", "boom", {
				retryable: true,
			}),
		);

		await post();

		expect((await rawRow(id)).screenshotPath).toBeNull();
		expect((await rawRow(id)).updatedAt).toEqual(SAVED_AT);
	});
});
