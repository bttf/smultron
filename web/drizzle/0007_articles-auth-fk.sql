-- Custom migration: FKs to auth.users for the article pipeline tables.
--
-- Not expressible via drizzle-kit generate from schema.ts: auth.users is
-- Supabase-managed and is intentionally not modeled as a Drizzle table
-- (drizzle-kit would try to CREATE it), so the FKs are hand-written here
-- instead (mirrors 0001_trgm-fk.sql and 0003_highlights-auth-fk.sql).
ALTER TABLE "smultron"."articles" ADD CONSTRAINT "articles_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");--> statement-breakpoint
ALTER TABLE "smultron"."article_audio" ADD CONSTRAINT "article_audio_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");
