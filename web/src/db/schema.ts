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
