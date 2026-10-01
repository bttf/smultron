CREATE TABLE "smultron"."snapshots" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "smultron"."snapshots_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" uuid NOT NULL,
	"bookmark_id" bigint NOT NULL,
	"url" text NOT NULL,
	"title" text NOT NULL,
	"adapter_id" text NOT NULL,
	"adapter_version" text NOT NULL,
	"markdown" text NOT NULL,
	"metadata" jsonb NOT NULL,
	"assets" jsonb NOT NULL,
	"status" text DEFAULT 'uploading' NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "smultron"."snapshots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "smultron"."snapshots" ADD CONSTRAINT "snapshots_bookmark_id_bookmarks_id_fk" FOREIGN KEY ("bookmark_id") REFERENCES "smultron"."bookmarks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "snapshots_user_id_bookmark_id_captured_at_idx" ON "smultron"."snapshots" USING btree ("user_id","bookmark_id","captured_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "snapshots_user_id_created_at_idx" ON "smultron"."snapshots" USING btree ("user_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);