// Drizzle schema for the `smultron` Postgres schema.
// See docs/SPEC.md §3 (Data model) — this file must match it exactly.
//
// `auth.users` is NOT modeled here (drizzle-kit would try to CREATE it).
// user_id columns below are plain uuid; the real foreign keys to
// auth.users(id), plus the pg_trgm extension + trgm indexes, are added by
// the hand-written migration 0001 (see web/drizzle/0001_trgm-fk.sql).
import { sql } from "drizzle-orm";
import {
	bigint,
	index,
	integer,
	pgSchema,
	text,
	timestamp,
	unique,
	uuid,
} from "drizzle-orm/pg-core";

export const smultron = pgSchema("smultron");

export const bookmarks = smultron
	.table(
		"bookmarks",
		{
			id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
			userId: uuid("user_id").notNull(),
			// Original URL as sent by Chrome.
			url: text().notNull(),
			// Dedupe key, computed server-side (see normalizeUrl.ts).
			urlNormalized: text("url_normalized").notNull(),
			title: text().notNull().default(""),
			// Chrome's bookmark node id (latest seen).
			chromeId: text("chrome_id"),
			// First element = Chrome folder path at insert.
			tags: text().array().notNull().default([]),
			// User note (m10): one per bookmark; null = none. Site-owned
			// annotation — editing it NEVER bumps updated_at (Hard rule #1).
			note: text(),
			// First save (Chrome dateAdded when available).
			createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
			// Recency; feed sort key.
			updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
			// null = live; soft delete.
			archivedAt: timestamp("archived_at", { withTimezone: true }),
			// Pinned to the feed's quick-access shelf (m13); null = not pinned.
			// Ordering key for the shelf (most recently pinned first). A site
			// edit — setting/clearing it NEVER bumps updated_at (Hard rule #1) —
			// and mutually exclusive with archived_at: archiving unpins,
			// pinning unarchives.
			pinnedAt: timestamp("pinned_at", { withTimezone: true }),
		},
		(table) => [
			unique().on(table.userId, table.urlNormalized),
			// FTS over title + url_normalized + note. MUST stay identical to
			// the tsvector expression in lib/bookmarks.ts so the index is used.
			index("bookmarks_fts_idx").using(
				"gin",
				sql`to_tsvector('simple', ${table.title} || ' ' || ${table.urlNormalized} || ' ' || coalesce(${table.note}, ''))`,
			),
			// Feed: live bookmarks ordered by recency, per user.
			index("bookmarks_feed_idx")
				.on(table.userId, table.updatedAt.desc())
				.where(sql`${table.archivedAt} is null`),
			// Pinned shelf: a user's pinned rows, most recently pinned first.
			index("bookmarks_pinned_idx")
				.on(table.userId, table.pinnedAt.desc())
				.where(sql`${table.pinnedAt} is not null`),
		],
	)
	.enableRLS();

export const apiTokens = smultron
	.table("api_tokens", {
		userId: uuid("user_id").primaryKey(),
		// sha256 of the token; raw token never stored.
		tokenHash: text("token_hash").notNull(),
		// Set on first /api/hello.
		pairedAt: timestamp("paired_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.default(sql`now()`),
	})
	.enableRLS();

/**
 * Article pipeline status (SPEC §10). Terminal states are `ready` and
 * `failed`; everything else means a run is (or was) in flight.
 */
export const ARTICLE_STATUSES = [
	"queued",
	"scraping",
	"cleaning",
	"summarizing",
	"ready",
	"failed",
] as const;

export type ArticleStatus = (typeof ARTICLE_STATUSES)[number];

// Stored as plain `text` rather than a pg enum: the status set is expected to
// evolve, and a text column keeps that a code change instead of a migration
// with an ALTER TYPE. The TS union above is the authority.
export const articles = smultron
	.table(
		"articles",
		{
			id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
			userId: uuid("user_id").notNull(),
			// One article per bookmark (unique below) — re-scraping overwrites.
			bookmarkId: bigint("bookmark_id", { mode: "number" })
				.notNull()
				.references(() => bookmarks.id),
			status: text().notNull().default("queued"),
			// Human-readable failure reason; set only alongside status='failed'.
			error: text(),
			// Firecrawl's resolved sourceURL (may differ from the bookmark's
			// after redirects) and the article title it extracted.
			sourceUrl: text("source_url"),
			title: text(),
			// Raw Firecrawl markdown. Kept so a re-run can resume at the clean
			// pass without paying for another scrape (SPEC §10 resume rules).
			rawMarkdown: text("raw_markdown"),
			// Cleaned spoken prose — the read-aloud text and the summary's input.
			transcript: text(),
			// LLM-generated spoken summary of the transcript.
			summary: text(),
			// Word count of `transcript`; null until the clean pass completes.
			wordCount: integer("word_count"),
			createdAt: timestamp("created_at", { withTimezone: true })
				.notNull()
				.default(sql`now()`),
			// The ARTICLE's own progress clock — used for stale-run detection
			// (SPEC §10). Entirely separate from bookmarks.updated_at, which the
			// article pipeline must never touch (Hard rule #1).
			updatedAt: timestamp("updated_at", { withTimezone: true })
				.notNull()
				.default(sql`now()`),
		},
		(table) => [
			unique().on(table.bookmarkId),
			// Resolving a bookmark's article, ownership-scoped.
			index("articles_user_id_bookmark_id_idx").on(
				table.userId,
				table.bookmarkId,
			),
		],
	)
	.enableRLS();

// Synthesized audio for one article, per (kind, voice). Rows are a CACHE over
// Supabase Storage: `storage_path` points at the object, and the row exists
// only once the upload succeeded.
export const articleAudio = smultron
	.table(
		"article_audio",
		{
			id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
			userId: uuid("user_id").notNull(),
			articleId: bigint("article_id", { mode: "number" })
				.notNull()
				.references(() => articles.id),
			// 'summary' | 'transcript' — which text was spoken.
			kind: text().notNull(),
			// OpenAI voice id the audio was rendered with; part of the cache key
			// so changing the voice re-synthesizes instead of serving the old one.
			voice: text().notNull(),
			// Object path WITHIN the audio bucket (bucket name is env config).
			storagePath: text("storage_path").notNull(),
			byteSize: integer("byte_size").notNull(),
			// Characters spoken and how many TTS requests it took (the OpenAI
			// speech endpoint caps input at 4096 chars — see lib/tts.ts).
			charCount: integer("char_count").notNull(),
			segmentCount: integer("segment_count").notNull(),
			createdAt: timestamp("created_at", { withTimezone: true })
				.notNull()
				.default(sql`now()`),
		},
		(table) => [unique().on(table.articleId, table.kind, table.voice)],
	)
	.enableRLS();

export const highlights = smultron
	.table(
		"highlights",
		{
			id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
			userId: uuid("user_id").notNull(),
			bookmarkId: bigint("bookmark_id", { mode: "number" })
				.notNull()
				.references(() => bookmarks.id),
			// Immutable snippet; no edit support.
			text: text().notNull(),
			createdAt: timestamp("created_at", { withTimezone: true })
				.notNull()
				.default(sql`now()`),
		},
		(table) => [
			// Fetching a bookmark's highlights in order.
			index("highlights_bookmark_id_created_at_idx").on(
				table.bookmarkId,
				table.createdAt,
			),
		],
	)
	.enableRLS();
