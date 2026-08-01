-- Custom migration: extension + trgm indexes + FKs to auth.users.
--
-- Not expressible via drizzle-kit generate from schema.ts:
--   * pg_trgm must be created before it can be used in an index definition.
--   * auth.users is Supabase-managed and is intentionally not modeled as a
--     Drizzle table (drizzle-kit would try to CREATE it), so the FKs are
--     hand-written here instead.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX "bookmarks_title_trgm_idx" ON "smultron"."bookmarks" USING gin ("title" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX "bookmarks_url_normalized_trgm_idx" ON "smultron"."bookmarks" USING gin ("url_normalized" gin_trgm_ops);
--> statement-breakpoint
ALTER TABLE "smultron"."bookmarks" ADD CONSTRAINT "bookmarks_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");
--> statement-breakpoint
ALTER TABLE "smultron"."api_tokens" ADD CONSTRAINT "api_tokens_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");
