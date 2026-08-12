-- Custom migration: FK to auth.users for the m19 browse_events table.
--
-- Not expressible via drizzle-kit generate from schema.ts: auth.users is
-- Supabase-managed and is intentionally not modeled as a Drizzle table
-- (drizzle-kit would try to CREATE it), so the FK is hand-written here
-- instead (mirrors 0001_trgm-fk.sql, 0003_highlights-auth-fk.sql and
-- 0007_articles-auth-fk.sql).
ALTER TABLE "smultron"."browse_events" ADD CONSTRAINT "browse_events_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");
