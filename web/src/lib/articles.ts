// Article pipeline state — SPEC §10.
//
// Pure functions over an injected Drizzle db (PGlite-testable, same pattern
// as sync.ts / bookmarks.ts). This module owns the `articles` row and its
// status machine; the actual external calls live in firecrawl.ts /
// transcript.ts / tts.ts and are injected into `runArticleJob` so the state
// machine can be tested without a network.
//
// CRITICAL (AGENTS.md Hard rule #1): nothing here touches
// `bookmarks.updated_at`. Scraping is not a live capture — it is a
// site-initiated enrichment, and it must not resurface a bookmark in the
// feed. `articles.updated_at` is a SEPARATE clock, used only for stale-run
// detection.
import { and, eq, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type { ArticleStatus } from "../db/schema";
import {
	ARTICLE_STATUSES,
	articleAudio,
	articles,
	bookmarks,
} from "../db/schema";
import { countWords } from "./chunk";
import { asPipelineError, PipelineError } from "./pipelineError";

// biome-ignore lint/suspicious/noExplicitAny: variance of Drizzle's driver-specific generics requires it; the schema/relations generics are irrelevant here.
export type ArticlesDb = PgDatabase<PgQueryResultHKT, any, any>;

/** Statuses from which no further work happens without a new run. */
const TERMINAL: ReadonlySet<ArticleStatus> = new Set(["ready", "failed"]);

/**
 * A run in a non-terminal status whose `updated_at` is older than this is
 * assumed dead — the serverless invocation that owned it was killed (timeout,
 * deploy, crash) and will never write again. Generous, because a single clean
 * pass over a long chunk can legitimately take minutes with no DB write.
 */
export const STALE_RUN_MS = 10 * 60 * 1000;

export type Article = {
	id: number;
	bookmarkId: number;
	status: ArticleStatus;
	error: string | null;
	sourceUrl: string | null;
	title: string | null;
	transcript: string | null;
	summary: string | null;
	wordCount: number | null;
	createdAt: Date;
	updatedAt: Date;
};

// `raw_markdown` is deliberately absent: it can be hundreds of KB and no
// caller outside the pipeline needs it. `hasRawMarkdown` carries the only
// fact the UI/runner cares about (can a re-run skip the scrape?).
const ARTICLE_COLUMNS = {
	id: articles.id,
	bookmarkId: articles.bookmarkId,
	// Plain `text` in Postgres; narrowed to the ArticleStatus union by
	// `toArticle` below, which is the single place the cast happens.
	status: articles.status,
	error: articles.error,
	sourceUrl: articles.sourceUrl,
	title: articles.title,
	transcript: articles.transcript,
	summary: articles.summary,
	wordCount: articles.wordCount,
	createdAt: articles.createdAt,
	updatedAt: articles.updatedAt,
};

/** A selected row before its `status` text is narrowed to the union. */
type RawArticleRow = Omit<Article, "status"> & { status: string };

/**
 * Narrows a selected row's `status` to `ArticleStatus`. The column is `text`
 * and only this module ever writes it, so an unrecognized value would mean
 * hand-edited data — treated as `failed` rather than trusted.
 */
function toArticle(row: RawArticleRow): Article {
	const known = (ARTICLE_STATUSES as readonly string[]).includes(row.status);
	return { ...row, status: (known ? row.status : "failed") as ArticleStatus };
}

export type ArticleView = Article & {
	hasRawMarkdown: boolean;
	/** Kinds with synthesized audio already cached, for the current voice. */
	audioKinds: AudioKind[];
};

export type AudioKind = "summary" | "transcript";

/** True when the row is mid-run and something is plausibly still working. */
export function isRunning(article: Article, now: Date = new Date()): boolean {
	return (
		!TERMINAL.has(article.status) &&
		now.getTime() - article.updatedAt.getTime() < STALE_RUN_MS
	);
}

/**
 * Fetches the article for `bookmarkId`, scoped to `userId`, with the derived
 * fields the API returns. Null when the bookmark has never been scraped.
 */
export async function getArticle(
	db: ArticlesDb,
	userId: string,
	bookmarkId: number,
	voice?: string,
): Promise<ArticleView | null> {
	const rows = await db
		.select({
			...ARTICLE_COLUMNS,
			hasRawMarkdown: sql<boolean>`(${articles.rawMarkdown} is not null)`,
		})
		.from(articles)
		.where(
			and(eq(articles.userId, userId), eq(articles.bookmarkId, bookmarkId)),
		)
		.limit(1);

	const row = rows[0];
	if (!row) {
		return null;
	}
	const { hasRawMarkdown, ...rest } = row;
	const article = toArticle(rest);

	const audioConditions = [eq(articleAudio.articleId, article.id)];
	if (voice) {
		audioConditions.push(eq(articleAudio.voice, voice));
	}
	const audioRows = await db
		.select({ kind: articleAudio.kind })
		.from(articleAudio)
		.where(and(...audioConditions));

	return {
		...article,
		hasRawMarkdown,
		audioKinds: [...new Set(audioRows.map((a) => a.kind as AudioKind))],
	};
}

/** True when `bookmarkId` exists, belongs to `userId`, and gives its URL. */
export async function getBookmarkUrl(
	db: ArticlesDb,
	userId: string,
	bookmarkId: number,
): Promise<string | null> {
	const rows = await db
		.select({ url: bookmarks.url })
		.from(bookmarks)
		.where(and(eq(bookmarks.id, bookmarkId), eq(bookmarks.userId, userId)))
		.limit(1);
	return rows[0]?.url ?? null;
}

/**
 * Claims the article row for a new run, creating it if absent.
 *
 * Returns `null` when a run is already in flight (non-terminal and recently
 * touched) — the caller then just reports current state instead of starting a
 * duplicate pipeline. `reset: true` discards cached scrape/clean output so
 * the next run redoes everything from the network.
 *
 * The insert is an upsert on the `(bookmark_id)` unique constraint, so two
 * concurrent claims can't create two rows; the loser sees the winner's
 * `updated_at` and backs off via `isRunning`.
 */
export async function claimArticleRun(
	db: ArticlesDb,
	userId: string,
	bookmarkId: number,
	options: { reset?: boolean } = {},
): Promise<Article | null> {
	const existing = await db
		.select(ARTICLE_COLUMNS)
		.from(articles)
		.where(
			and(eq(articles.userId, userId), eq(articles.bookmarkId, bookmarkId)),
		)
		.limit(1);

	const current = existing[0] ? toArticle(existing[0]) : null;
	if (current && isRunning(current)) {
		return null;
	}

	const reset = options.reset ?? false;

	const rows = await db
		.insert(articles)
		.values({ userId, bookmarkId, status: "queued" })
		.onConflictDoUpdate({
			target: articles.bookmarkId,
			set: {
				status: "queued",
				error: null,
				updatedAt: sql`now()`,
				...(reset
					? {
							rawMarkdown: null,
							transcript: null,
							summary: null,
							wordCount: null,
						}
					: {}),
			},
			// Ownership guard on the conflict path: without it, a bookmark id
			// belonging to another user could be re-targeted. Callers already
			// verify ownership via getBookmarkUrl; this is defence in depth.
			setWhere: eq(articles.userId, userId),
		})
		.returning(ARTICLE_COLUMNS);

	return rows[0] ? toArticle(rows[0]) : null;
}

/** Moves the run to `status`, refreshing the article's own progress clock. */
export async function setArticleStatus(
	db: ArticlesDb,
	articleId: number,
	status: ArticleStatus,
): Promise<void> {
	await db
		.update(articles)
		.set({ status, updatedAt: sql`now()` })
		.where(eq(articles.id, articleId));
}

/** Records a terminal failure. `error` is rendered to the user verbatim. */
export async function failArticle(
	db: ArticlesDb,
	articleId: number,
	error: string,
): Promise<void> {
	await db
		.update(articles)
		.set({ status: "failed", error, updatedAt: sql`now()` })
		.where(eq(articles.id, articleId));
}

/** Persists scrape output so a later run can resume past the scrape. */
export async function saveScrape(
	db: ArticlesDb,
	articleId: number,
	scrape: { markdown: string; title: string | null; sourceUrl: string | null },
): Promise<void> {
	await db
		.update(articles)
		.set({
			rawMarkdown: scrape.markdown,
			title: scrape.title,
			sourceUrl: scrape.sourceUrl,
			updatedAt: sql`now()`,
		})
		.where(eq(articles.id, articleId));
}

/** Persists the cleaned transcript so a later run can resume past the clean. */
export async function saveTranscript(
	db: ArticlesDb,
	articleId: number,
	transcript: string,
): Promise<void> {
	await db
		.update(articles)
		.set({
			transcript,
			wordCount: countWords(transcript),
			updatedAt: sql`now()`,
		})
		.where(eq(articles.id, articleId));
}

/** Persists the summary and closes the run as `ready`. */
export async function saveSummary(
	db: ArticlesDb,
	articleId: number,
	summary: string,
): Promise<void> {
	await db
		.update(articles)
		.set({ summary, status: "ready", error: null, updatedAt: sql`now()` })
		.where(eq(articles.id, articleId));
}

/** Reads `raw_markdown` — the one place it leaves the DB (resume path). */
async function loadRawMarkdown(
	db: ArticlesDb,
	articleId: number,
): Promise<string | null> {
	const rows = await db
		.select({ rawMarkdown: articles.rawMarkdown })
		.from(articles)
		.where(eq(articles.id, articleId))
		.limit(1);
	return rows[0]?.rawMarkdown ?? null;
}

/** The external steps, injected so the state machine is testable offline. */
export type PipelineDeps = {
	scrape: (url: string) => Promise<{
		markdown: string;
		title: string | null;
		sourceUrl: string | null;
	}>;
	clean: (
		markdown: string,
		options: { title: string | null },
	) => Promise<{ transcript: string; truncated: boolean }>;
	summarize: (
		transcript: string,
		options: { title: string | null },
	) => Promise<string>;
};

/**
 * Runs the pipeline to completion for an already-claimed article.
 *
 * Resume semantics (SPEC §10): each step is skipped when its output is
 * already persisted, so a run killed mid-flight (function timeout, deploy)
 * costs only the steps that hadn't finished. `claimArticleRun({reset:true})`
 * is what forces a genuine re-scrape.
 *
 * Never throws: every failure is written to the row as `failed` + message,
 * because this is called from a fire-and-forget context (`after()`) where a
 * rejection would be swallowed and leave the row stuck mid-status forever.
 */
export async function runArticleJob(
	db: ArticlesDb,
	deps: PipelineDeps,
	input: { articleId: number; url: string },
): Promise<void> {
	const { articleId, url } = input;

	try {
		// --- 1. Scrape (skipped when raw markdown is already cached) --------
		let markdown = await loadRawMarkdown(db, articleId);
		let title: string | null = null;

		if (markdown === null) {
			await setArticleStatus(db, articleId, "scraping");
			const scraped = await withStep("scrape", () => deps.scrape(url));
			await saveScrape(db, articleId, scraped);
			markdown = scraped.markdown;
			title = scraped.title;
		}

		// The title may have come from an earlier run's scrape.
		if (title === null) {
			const rows = await db
				.select({ title: articles.title })
				.from(articles)
				.where(eq(articles.id, articleId))
				.limit(1);
			title = rows[0]?.title ?? null;
		}

		// --- 2. Clean (skipped when a transcript is already cached) ---------
		const currentRows = await db
			.select({ transcript: articles.transcript, summary: articles.summary })
			.from(articles)
			.where(eq(articles.id, articleId))
			.limit(1);

		let transcript = currentRows[0]?.transcript ?? null;

		if (transcript === null) {
			await setArticleStatus(db, articleId, "cleaning");
			const cleaned = await withStep("clean", () =>
				deps.clean(markdown, { title }),
			);
			transcript = cleaned.truncated
				? `${cleaned.transcript}\n\nThis article was long enough that only its earlier portion has been prepared for reading.`
				: cleaned.transcript;
			await saveTranscript(db, articleId, transcript);
		}

		// --- 3. Summarize ---------------------------------------------------
		await setArticleStatus(db, articleId, "summarizing");
		const summary = await withStep("summarize", () =>
			deps.summarize(transcript, { title }),
		);
		await saveSummary(db, articleId, summary);
	} catch (error) {
		const failure =
			error instanceof PipelineError ? error : asPipelineError("clean", error);
		try {
			await failArticle(db, articleId, failure.toDisplayString());
		} catch {
			// The DB itself is unreachable — nothing left to do but let the
			// stale-run window (STALE_RUN_MS) make the row re-runnable.
		}
	}
}

/** Runs `fn`, normalizing anything it throws into a PipelineError for `step`. */
async function withStep<T>(
	step: "scrape" | "clean" | "summarize",
	fn: () => Promise<T>,
): Promise<T> {
	try {
		return await fn();
	} catch (error) {
		throw asPipelineError(step, error);
	}
}

export type AudioRow = {
	id: number;
	kind: AudioKind;
	voice: string;
	storagePath: string;
	byteSize: number;
	charCount: number;
	segmentCount: number;
};

/** Cached audio for `(article, kind, voice)`, or null if not synthesized yet. */
export async function getAudio(
	db: ArticlesDb,
	articleId: number,
	kind: AudioKind,
	voice: string,
): Promise<AudioRow | null> {
	const rows = await db
		.select({
			id: articleAudio.id,
			kind: articleAudio.kind,
			voice: articleAudio.voice,
			storagePath: articleAudio.storagePath,
			byteSize: articleAudio.byteSize,
			charCount: articleAudio.charCount,
			segmentCount: articleAudio.segmentCount,
		})
		.from(articleAudio)
		.where(
			and(
				eq(articleAudio.articleId, articleId),
				eq(articleAudio.kind, kind),
				eq(articleAudio.voice, voice),
			),
		)
		.limit(1);
	const row = rows[0];
	return row ? { ...row, kind: row.kind as AudioKind } : null;
}

/**
 * Records synthesized audio. Upsert on `(article, kind, voice)` so a
 * re-synthesis (same object path, overwritten in storage) updates the row
 * instead of failing the unique constraint.
 */
export async function saveAudio(
	db: ArticlesDb,
	userId: string,
	articleId: number,
	audio: Omit<AudioRow, "id">,
): Promise<AudioRow> {
	const rows = await db
		.insert(articleAudio)
		.values({ userId, articleId, ...audio })
		.onConflictDoUpdate({
			target: [articleAudio.articleId, articleAudio.kind, articleAudio.voice],
			set: {
				storagePath: audio.storagePath,
				byteSize: audio.byteSize,
				charCount: audio.charCount,
				segmentCount: audio.segmentCount,
				createdAt: sql`now()`,
			},
		})
		.returning({
			id: articleAudio.id,
			kind: articleAudio.kind,
			voice: articleAudio.voice,
			storagePath: articleAudio.storagePath,
			byteSize: articleAudio.byteSize,
			charCount: articleAudio.charCount,
			segmentCount: articleAudio.segmentCount,
		});
	return { ...rows[0], kind: rows[0].kind as AudioKind };
}
