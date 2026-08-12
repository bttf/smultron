CREATE TABLE "smultron"."browse_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "smultron"."browse_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" uuid NOT NULL,
	"client_event_id" text NOT NULL,
	"boot_id" text NOT NULL,
	"kind" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"url" text,
	"url_normalized" text,
	"title" text,
	"tab_id" integer,
	"window_id" integer,
	"idle_state" text,
	"transition" text,
	"document_lifecycle" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "browse_events_user_id_client_event_id_unique" UNIQUE("user_id","client_event_id")
);
--> statement-breakpoint
ALTER TABLE "smultron"."browse_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "browse_events_user_id_occurred_at_idx" ON "smultron"."browse_events" USING btree ("user_id","occurred_at" DESC NULLS LAST,"id" DESC NULLS LAST);