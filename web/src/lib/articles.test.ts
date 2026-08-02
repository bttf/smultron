// Article pipeline tests against REAL Postgres semantics: an in-memory
// PGlite database with the production migrations from web/drizzle/ applied
// in journal order, plus a stubbed auth.users (Supabase-managed in prod).
// Harness copied from sync.test.ts per AGENTS.md.
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
import * as schema from "../db/schema";
import { articleAudio, articles, bookmarks } from "../db/schema";
import {
	claimArticleRun,
	failArticle,
	getArticle,
	getAudio,
	getBookmarkUrl,
	isRunning,
	type PipelineDeps,
	runArticleJob,
	STALE_RUN_MS,
	saveAudio,
	setArticleStatus,
} from "./articles";
import { PipelineError } from "./pipelineError";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";

const drizzleDir = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../drizzle",
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
});

afterAll(async () => {
	await client.close();
});

beforeEach(async () => {
	// article_audio -> articles -> bookmarks (FK order).
	await db.execute(sql`DELETE FROM smultron.article_audio`);
	await db.execute(sql`DELETE FROM smultron.articles`);
	await db.execute(sql`DELETE FROM smultron.bookmarks`);
});

/** Inserts a bookmark and returns its id. */
async function seedBookmark(
	userId = USER_A,
	url = "https://example.com/post",
): Promise<number> {
	const now = new Date("2024-05-01T10:00:00.000Z");
	const rows = await db
		.insert(bookmarks)
		.values({
			userId,
			url,
			urlNormalized: url,
			title: "Post",
			createdAt: now,
			updatedAt: now,
		})
		.returning({ id: bookmarks.id });
	return rows[0].id;
}

async function bookmarkUpdatedAt(id: number): Promise<Date> {
	const rows = await db
		.select({ updatedAt: bookmarks.updatedAt })
		.from(bookmarks)
		.where(eq(bookmarks.id, id));
	return rows[0].updatedAt;
}

/** Forces an article's progress clock back, simulating a dead run. */
async function ageArticle(articleId: number, ms: number) {
	await db
		.update(articles)
		.set({ updatedAt: new Date(Date.now() - ms) })
		.where(eq(articles.id, articleId));
}

function deps(overrides: Partial<PipelineDeps> = {}): PipelineDeps {
	return {
		scrape: vi.fn(async () => ({
			markdown: "# Title\n\n[link](https://x.com) Some scraped body text.",
			title: "Scraped Title",
			sourceUrl: "https://example.com/post",
		})),
		clean: vi.fn(async () => ({
			transcript: "Some scraped body text, cleaned into prose.",
			truncated: false,
		})),
		summarize: vi.fn(async () => "A short spoken summary."),
		...overrides,
	};
}

describe("getBookmarkUrl", () => {
	it("returns the raw URL for the owner", async () => {
		const id = await seedBookmark(USER_A, "https://example.com/a?b=1");
		expect(await getBookmarkUrl(db, USER_A, id)).toBe(
			"https://example.com/a?b=1",
		);
	});

	it("returns null for another user's bookmark", async () => {
		const id = await seedBookmark(USER_A);
		expect(await getBookmarkUrl(db, USER_B, id)).toBeNull();
	});

	it("returns null for a missing bookmark", async () => {
		expect(await getBookmarkUrl(db, USER_A, 999_999)).toBeNull();
	});
});

describe("claimArticleRun", () => {
	it("creates a queued article on first claim", async () => {
		const bookmarkId = await seedBookmark();
		const article = await claimArticleRun(db, USER_A, bookmarkId);

		expect(article).not.toBeNull();
		expect(article?.status).toBe("queued");
		expect(article?.bookmarkId).toBe(bookmarkId);
		expect(article?.error).toBeNull();
	});

	it("refuses a second claim while a run is in flight", async () => {
		const bookmarkId = await seedBookmark();
		const first = await claimArticleRun(db, USER_A, bookmarkId);
		await setArticleStatus(db, first?.id ?? 0, "cleaning");

		expect(await claimArticleRun(db, USER_A, bookmarkId)).toBeNull();
	});

	it("re-claims a run that went stale", async () => {
		const bookmarkId = await seedBookmark();
		const first = await claimArticleRun(db, USER_A, bookmarkId);
		await setArticleStatus(db, first?.id ?? 0, "cleaning");
		await ageArticle(first?.id ?? 0, STALE_RUN_MS + 60_000);

		const reclaimed = await claimArticleRun(db, USER_A, bookmarkId);
		expect(reclaimed?.id).toBe(first?.id);
		expect(reclaimed?.status).toBe("queued");
	});

	it("re-claims a terminal run immediately, no staleness wait", async () => {
		const bookmarkId = await seedBookmark();
		const first = await claimArticleRun(db, USER_A, bookmarkId);
		await failArticle(db, first?.id ?? 0, "scrape: boom");

		const reclaimed = await claimArticleRun(db, USER_A, bookmarkId);
		expect(reclaimed?.id).toBe(first?.id);
		expect(reclaimed?.status).toBe("queued");
		// The previous failure is cleared so the UI doesn't show a stale error.
		expect(reclaimed?.error).toBeNull();
	});

	it("keeps cached scrape/clean output by default", async () => {
		const bookmarkId = await seedBookmark();
		const first = await claimArticleRun(db, USER_A, bookmarkId);
		await runArticleJob(db, deps(), {
			articleId: first?.id ?? 0,
			url: "https://example.com/post",
		});

		const reclaimed = await claimArticleRun(db, USER_A, bookmarkId);
		expect(reclaimed?.transcript).not.toBeNull();

		const view = await getArticle(db, USER_A, bookmarkId);
		expect(view?.hasRawMarkdown).toBe(true);
	});

	it("reset:true discards cached scrape/clean output", async () => {
		const bookmarkId = await seedBookmark();
		const first = await claimArticleRun(db, USER_A, bookmarkId);
		await runArticleJob(db, deps(), {
			articleId: first?.id ?? 0,
			url: "https://example.com/post",
		});

		const reclaimed = await claimArticleRun(db, USER_A, bookmarkId, {
			reset: true,
		});
		expect(reclaimed?.transcript).toBeNull();
		expect(reclaimed?.summary).toBeNull();
		expect(reclaimed?.wordCount).toBeNull();

		const view = await getArticle(db, USER_A, bookmarkId);
		expect(view?.hasRawMarkdown).toBe(false);
	});

	it("never creates a second row for the same bookmark", async () => {
		const bookmarkId = await seedBookmark();
		await claimArticleRun(db, USER_A, bookmarkId);
		await failArticle(
			db,
			(await getArticle(db, USER_A, bookmarkId))?.id ?? 0,
			"x",
		);
		await claimArticleRun(db, USER_A, bookmarkId);

		const rows = await db
			.select()
			.from(articles)
			.where(eq(articles.bookmarkId, bookmarkId));
		expect(rows).toHaveLength(1);
	});
});

describe("Hard rule #1: the article pipeline never bumps bookmarks.updated_at", () => {
	it("holds across claim, full run, and audio save", async () => {
		const bookmarkId = await seedBookmark();
		const before = await bookmarkUpdatedAt(bookmarkId);

		const article = await claimArticleRun(db, USER_A, bookmarkId);
		await runArticleJob(db, deps(), {
			articleId: article?.id ?? 0,
			url: "https://example.com/post",
		});
		await saveAudio(db, USER_A, article?.id ?? 0, {
			kind: "summary",
			voice: "sage",
			storagePath: `${USER_A}/1/summary-sage.mp3`,
			byteSize: 1234,
			charCount: 100,
			segmentCount: 1,
		});

		expect((await bookmarkUpdatedAt(bookmarkId)).getTime()).toBe(
			before.getTime(),
		);
	});

	it("holds when the run fails", async () => {
		const bookmarkId = await seedBookmark();
		const before = await bookmarkUpdatedAt(bookmarkId);

		const article = await claimArticleRun(db, USER_A, bookmarkId);
		await runArticleJob(
			db,
			deps({
				scrape: async () => {
					throw new PipelineError("scrape", "empty_content", "nothing here");
				},
			}),
			{ articleId: article?.id ?? 0, url: "https://example.com/post" },
		);

		expect((await bookmarkUpdatedAt(bookmarkId)).getTime()).toBe(
			before.getTime(),
		);
	});
});

describe("runArticleJob", () => {
	it("walks scrape -> clean -> summarize and lands ready", async () => {
		const bookmarkId = await seedBookmark();
		const article = await claimArticleRun(db, USER_A, bookmarkId);
		const d = deps();

		await runArticleJob(db, d, {
			articleId: article?.id ?? 0,
			url: "https://example.com/post",
		});

		const view = await getArticle(db, USER_A, bookmarkId);
		expect(view?.status).toBe("ready");
		expect(view?.error).toBeNull();
		expect(view?.title).toBe("Scraped Title");
		expect(view?.sourceUrl).toBe("https://example.com/post");
		expect(view?.transcript).toBe(
			"Some scraped body text, cleaned into prose.",
		);
		expect(view?.summary).toBe("A short spoken summary.");
		// countWords over the transcript above.
		expect(view?.wordCount).toBe(7);
		expect(d.scrape).toHaveBeenCalledTimes(1);
		expect(d.clean).toHaveBeenCalledTimes(1);
		expect(d.summarize).toHaveBeenCalledTimes(1);
	});

	it("passes the scraped title into both LLM passes", async () => {
		const bookmarkId = await seedBookmark();
		const article = await claimArticleRun(db, USER_A, bookmarkId);
		const d = deps();

		await runArticleJob(db, d, {
			articleId: article?.id ?? 0,
			url: "https://example.com/post",
		});

		expect(d.clean).toHaveBeenCalledWith(expect.any(String), {
			title: "Scraped Title",
		});
		expect(d.summarize).toHaveBeenCalledWith(expect.any(String), {
			title: "Scraped Title",
		});
	});

	it("records a failure instead of throwing", async () => {
		const bookmarkId = await seedBookmark();
		const article = await claimArticleRun(db, USER_A, bookmarkId);

		await expect(
			runArticleJob(
				db,
				deps({
					scrape: async () => {
						throw new PipelineError(
							"scrape",
							"empty_content",
							"No readable content found on the page.",
						);
					},
				}),
				{ articleId: article?.id ?? 0, url: "https://example.com/post" },
			),
		).resolves.toBeUndefined();

		const view = await getArticle(db, USER_A, bookmarkId);
		expect(view?.status).toBe("failed");
		expect(view?.error).toBe("scrape: No readable content found on the page.");
	});

	it("labels a non-PipelineError failure with its step", async () => {
		const bookmarkId = await seedBookmark();
		const article = await claimArticleRun(db, USER_A, bookmarkId);

		await runArticleJob(
			db,
			deps({
				summarize: async () => {
					throw new Error("socket hang up");
				},
			}),
			{ articleId: article?.id ?? 0, url: "https://example.com/post" },
		);

		const view = await getArticle(db, USER_A, bookmarkId);
		expect(view?.status).toBe("failed");
		expect(view?.error).toBe("summarize: socket hang up");
	});

	it("keeps a partially-failed run's completed work", async () => {
		const bookmarkId = await seedBookmark();
		const article = await claimArticleRun(db, USER_A, bookmarkId);

		await runArticleJob(
			db,
			deps({
				summarize: async () => {
					throw new PipelineError("summarize", "rate_limited", "slow down");
				},
			}),
			{ articleId: article?.id ?? 0, url: "https://example.com/post" },
		);

		const view = await getArticle(db, USER_A, bookmarkId);
		expect(view?.status).toBe("failed");
		// The transcript survives, so a retry doesn't re-scrape or re-clean.
		expect(view?.transcript).not.toBeNull();
		expect(view?.hasRawMarkdown).toBe(true);
	});

	describe("resume", () => {
		it("skips the scrape when raw markdown is already cached", async () => {
			const bookmarkId = await seedBookmark();
			const article = await claimArticleRun(db, USER_A, bookmarkId);
			const articleId = article?.id ?? 0;

			// First run fails at the clean step, leaving raw markdown behind.
			await runArticleJob(
				db,
				deps({
					clean: async () => {
						throw new PipelineError("clean", "rate_limited", "slow down");
					},
				}),
				{ articleId, url: "https://example.com/post" },
			);

			await claimArticleRun(db, USER_A, bookmarkId);
			const second = deps();
			await runArticleJob(db, second, {
				articleId,
				url: "https://example.com/post",
			});

			expect(second.scrape).not.toHaveBeenCalled();
			expect(second.clean).toHaveBeenCalledTimes(1);
			expect((await getArticle(db, USER_A, bookmarkId))?.status).toBe("ready");
		});

		it("skips scrape AND clean when a transcript is already cached", async () => {
			const bookmarkId = await seedBookmark();
			const article = await claimArticleRun(db, USER_A, bookmarkId);
			const articleId = article?.id ?? 0;

			await runArticleJob(
				db,
				deps({
					summarize: async () => {
						throw new PipelineError("summarize", "rate_limited", "slow down");
					},
				}),
				{ articleId, url: "https://example.com/post" },
			);

			await claimArticleRun(db, USER_A, bookmarkId);
			const second = deps();
			await runArticleJob(db, second, {
				articleId,
				url: "https://example.com/post",
			});

			expect(second.scrape).not.toHaveBeenCalled();
			expect(second.clean).not.toHaveBeenCalled();
			expect(second.summarize).toHaveBeenCalledTimes(1);
		});

		it("re-scrapes after a reset claim", async () => {
			const bookmarkId = await seedBookmark();
			const article = await claimArticleRun(db, USER_A, bookmarkId);
			const articleId = article?.id ?? 0;
			await runArticleJob(db, deps(), {
				articleId,
				url: "https://example.com/post",
			});

			await claimArticleRun(db, USER_A, bookmarkId, { reset: true });
			const second = deps();
			await runArticleJob(db, second, {
				articleId,
				url: "https://example.com/post",
			});

			expect(second.scrape).toHaveBeenCalledTimes(1);
			expect(second.clean).toHaveBeenCalledTimes(1);
		});

		it("resumes using the title stored by the earlier scrape", async () => {
			const bookmarkId = await seedBookmark();
			const article = await claimArticleRun(db, USER_A, bookmarkId);
			const articleId = article?.id ?? 0;

			await runArticleJob(
				db,
				deps({
					clean: async () => {
						throw new PipelineError("clean", "rate_limited", "slow down");
					},
				}),
				{ articleId, url: "https://example.com/post" },
			);

			await claimArticleRun(db, USER_A, bookmarkId);
			const second = deps();
			await runArticleJob(db, second, {
				articleId,
				url: "https://example.com/post",
			});

			expect(second.clean).toHaveBeenCalledWith(expect.any(String), {
				title: "Scraped Title",
			});
		});
	});

	it("appends a notice when the clean pass truncated a long article", async () => {
		const bookmarkId = await seedBookmark();
		const article = await claimArticleRun(db, USER_A, bookmarkId);

		await runArticleJob(
			db,
			deps({
				clean: async () => ({ transcript: "Partial prose.", truncated: true }),
			}),
			{ articleId: article?.id ?? 0, url: "https://example.com/post" },
		);

		const view = await getArticle(db, USER_A, bookmarkId);
		expect(view?.transcript).toContain("Partial prose.");
		expect(view?.transcript).toContain("only its earlier portion");
	});
});

describe("getArticle", () => {
	it("returns null when the bookmark was never scraped", async () => {
		const bookmarkId = await seedBookmark();
		expect(await getArticle(db, USER_A, bookmarkId)).toBeNull();
	});

	it("is scoped to the owner", async () => {
		const bookmarkId = await seedBookmark(USER_A);
		await claimArticleRun(db, USER_A, bookmarkId);
		expect(await getArticle(db, USER_B, bookmarkId)).toBeNull();
	});

	it("reports which audio kinds exist for the current voice", async () => {
		const bookmarkId = await seedBookmark();
		const article = await claimArticleRun(db, USER_A, bookmarkId);
		const articleId = article?.id ?? 0;

		await saveAudio(db, USER_A, articleId, {
			kind: "summary",
			voice: "sage",
			storagePath: "p/summary-sage.mp3",
			byteSize: 10,
			charCount: 5,
			segmentCount: 1,
		});

		expect(
			(await getArticle(db, USER_A, bookmarkId, "sage"))?.audioKinds,
		).toEqual(["summary"]);
		// A different voice has no cached audio yet.
		expect(
			(await getArticle(db, USER_A, bookmarkId, "nova"))?.audioKinds,
		).toEqual([]);
	});
});

describe("isRunning", () => {
	const base = {
		id: 1,
		bookmarkId: 1,
		error: null,
		sourceUrl: null,
		title: null,
		transcript: null,
		summary: null,
		wordCount: null,
		createdAt: new Date(),
	};

	it("is true for a freshly-touched non-terminal status", () => {
		expect(
			isRunning({ ...base, status: "cleaning", updatedAt: new Date() }),
		).toBe(true);
	});

	it("is false once the run goes stale", () => {
		expect(
			isRunning({
				...base,
				status: "cleaning",
				updatedAt: new Date(Date.now() - STALE_RUN_MS - 1000),
			}),
		).toBe(false);
	});

	it("is false for terminal statuses regardless of recency", () => {
		for (const status of ["ready", "failed"] as const) {
			expect(isRunning({ ...base, status, updatedAt: new Date() })).toBe(false);
		}
	});
});

describe("audio rows", () => {
	async function seedArticle(): Promise<number> {
		const bookmarkId = await seedBookmark();
		const article = await claimArticleRun(db, USER_A, bookmarkId);
		return article?.id ?? 0;
	}

	it("round-trips a saved row", async () => {
		const articleId = await seedArticle();
		const saved = await saveAudio(db, USER_A, articleId, {
			kind: "transcript",
			voice: "sage",
			storagePath: "a/b/transcript-sage.mp3",
			byteSize: 4096,
			charCount: 1200,
			segmentCount: 2,
		});

		expect(saved.kind).toBe("transcript");
		expect(await getAudio(db, articleId, "transcript", "sage")).toMatchObject({
			storagePath: "a/b/transcript-sage.mp3",
			byteSize: 4096,
			segmentCount: 2,
		});
	});

	it("returns null for a kind or voice with no audio", async () => {
		const articleId = await seedArticle();
		expect(await getAudio(db, articleId, "summary", "sage")).toBeNull();
	});

	it("upserts on (article, kind, voice) rather than duplicating", async () => {
		const articleId = await seedArticle();
		const row = {
			kind: "summary" as const,
			voice: "sage",
			storagePath: "p/summary-sage.mp3",
			byteSize: 100,
			charCount: 50,
			segmentCount: 1,
		};
		await saveAudio(db, USER_A, articleId, row);
		await saveAudio(db, USER_A, articleId, { ...row, byteSize: 200 });

		const rows = await db
			.select()
			.from(articleAudio)
			.where(eq(articleAudio.articleId, articleId));
		expect(rows).toHaveLength(1);
		expect(rows[0].byteSize).toBe(200);
	});

	it("keeps separate rows per voice", async () => {
		const articleId = await seedArticle();
		const row = {
			kind: "summary" as const,
			storagePath: "p/summary.mp3",
			byteSize: 100,
			charCount: 50,
			segmentCount: 1,
		};
		await saveAudio(db, USER_A, articleId, { ...row, voice: "sage" });
		await saveAudio(db, USER_A, articleId, { ...row, voice: "nova" });

		const rows = await db
			.select()
			.from(articleAudio)
			.where(eq(articleAudio.articleId, articleId));
		expect(rows).toHaveLength(2);
	});
});
