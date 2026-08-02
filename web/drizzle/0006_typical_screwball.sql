CREATE TABLE "smultron"."article_audio" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "smultron"."article_audio_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" uuid NOT NULL,
	"article_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"voice" text NOT NULL,
	"storage_path" text NOT NULL,
	"byte_size" integer NOT NULL,
	"char_count" integer NOT NULL,
	"segment_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "article_audio_article_id_kind_voice_unique" UNIQUE("article_id","kind","voice")
);
--> statement-breakpoint
ALTER TABLE "smultron"."article_audio" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "smultron"."articles" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "smultron"."articles_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" uuid NOT NULL,
	"bookmark_id" bigint NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"error" text,
	"source_url" text,
	"title" text,
	"raw_markdown" text,
	"transcript" text,
	"summary" text,
	"word_count" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "articles_bookmark_id_unique" UNIQUE("bookmark_id")
);
--> statement-breakpoint
ALTER TABLE "smultron"."articles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "smultron"."article_audio" ADD CONSTRAINT "article_audio_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "smultron"."articles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "smultron"."articles" ADD CONSTRAINT "articles_bookmark_id_bookmarks_id_fk" FOREIGN KEY ("bookmark_id") REFERENCES "smultron"."bookmarks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "articles_user_id_bookmark_id_idx" ON "smultron"."articles" USING btree ("user_id","bookmark_id");