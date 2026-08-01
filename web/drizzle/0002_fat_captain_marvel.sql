CREATE TABLE "smultron"."highlights" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "smultron"."highlights_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" uuid NOT NULL,
	"bookmark_id" bigint NOT NULL,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "smultron"."highlights" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "smultron"."highlights" ADD CONSTRAINT "highlights_bookmark_id_bookmarks_id_fk" FOREIGN KEY ("bookmark_id") REFERENCES "smultron"."bookmarks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "highlights_bookmark_id_created_at_idx" ON "smultron"."highlights" USING btree ("bookmark_id","created_at");