DROP INDEX "smultron"."bookmarks_fts_idx";--> statement-breakpoint
ALTER TABLE "smultron"."bookmarks" ADD COLUMN "note" text;--> statement-breakpoint
CREATE INDEX "bookmarks_fts_idx" ON "smultron"."bookmarks" USING gin (to_tsvector('simple', "title" || ' ' || "url_normalized" || ' ' || coalesce("note", '')));