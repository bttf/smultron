CREATE SCHEMA "smultron";
--> statement-breakpoint
CREATE TABLE "smultron"."api_tokens" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"paired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "smultron"."api_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "smultron"."bookmarks" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "smultron"."bookmarks_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" uuid NOT NULL,
	"url" text NOT NULL,
	"url_normalized" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"chrome_id" text,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "bookmarks_user_id_url_normalized_unique" UNIQUE("user_id","url_normalized")
);
--> statement-breakpoint
ALTER TABLE "smultron"."bookmarks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "bookmarks_fts_idx" ON "smultron"."bookmarks" USING gin (to_tsvector('simple', "title" || ' ' || "url_normalized"));--> statement-breakpoint
CREATE INDEX "bookmarks_feed_idx" ON "smultron"."bookmarks" USING btree ("user_id","updated_at" DESC NULLS LAST) WHERE "smultron"."bookmarks"."archived_at" is null;