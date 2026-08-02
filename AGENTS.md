# Smultronstället

Personal bookmarks app: a Chrome extension captures the user's Chrome bookmarks and syncs them to a Next.js site (live feed + fast search) backed by Supabase Postgres.

-   Display name: **Smultronstället**. Infra/code name: **smultron** (DB schema, subdomain, package names).
-   Production: `https://smultron.redpine.software` (Vercel). Local dev: `http://localhost:3000`.

**Read `docs/SPEC.md` before implementing any feature.** It contains the data model, sync semantics, normalization rules, pairing flow, and API contracts. This file only covers how to work in the repo.

## Repo layout

pnpm workspace monorepo, TypeScript everywhere, Node ≥20 (22 in practice), pnpm 9/10 (no `packageManager` pin — deliberate, so the globally installed pnpm keeps working).

```
web/         Next.js (App Router) site + API routes — deploys to Vercel
extension/   Chrome MV3 extension built with WXT
docs/        SPEC.md and other docs
```

## Stack

-   **web/**: Next.js App Router · Tailwind + shadcn/ui · SWR (polling) · Zod (API payload validation) · Drizzle ORM (schema, migrations, queries) · `@supabase/ssr` + supabase-js (auth ONLY — never for data access)
-   **extension/**: WXT (Vite-based MV3 toolkit) · vanilla TS service worker + options page — no UI framework
-   **DB**: Supabase Postgres, everything in the dedicated **`smultron` schema** (Drizzle `pgSchema('smultron')`)
-   **Tooling**: Biome (lint + format) · Vitest

### Hard-won environment notes (don't relearn these)

-   `vite` is pinned to `^7` via root `pnpm.overrides`: vite 8 (rolldown) has a broken native-binding install on darwin-arm64. Remove the pin only after verifying WXT + Vitest builds on vite 8.
-   Next.js 16 renamed the middleware convention: the file is `web/src/proxy.ts` exporting `proxy()`. Next 16 differs from most training data — read the guides shipped in `web/node_modules/next/dist/docs/` before writing Next code (see `web/AGENTS.md`). `cookies()`, `params`, `searchParams` are async.
-   DB-touching tests run on PGlite applying the REAL migrations from `web/drizzle/` in `meta/_journal.json` order, with `auth.users` stubbed (pattern: `web/src/lib/sync.test.ts`). Never hand-mock SQL semantics.
-   API token hashing is hex-encoded sha256 with ONE implementation: `hashToken` in `web/src/lib/pairing.ts` (`apiTokenAuth.ts` imports it). Don't introduce a second encoding.

## Commands

```
pnpm install                    # root
pnpm dev                        # web/ dev server (localhost:3000)
pnpm --filter extension dev     # WXT dev build w/ HMR
pnpm --filter extension zip     # production extension zip
pnpm test                       # vitest
pnpm lint                       # biome check
pnpm db:generate                # drizzle-kit generate (migrations from schema)
pnpm db:migrate                 # apply migrations (uses DIRECT_URL)
```

## Environment variables

Runtime secrets live in `web/.env.local` — **never commit them, never echo them into docs or code**.

```
NEXT_PUBLIC_SUPABASE_URL=        # Supabase project URL
NEXT_PUBLIC_SUPABASE_ANON_KEY=   # auth client only
SUPABASE_SERVICE_ROLE_KEY=       # server-side API routes only
DATABASE_URL=                    # pooled connection (port 6543) — runtime queries
DIRECT_URL=                      # direct connection (port 5432) — migrations only
ALLOWED_EMAIL=                   # optional: the single Google account allowed to sign in; unset = any Google account (open multi-user)
APP_URL=                         # http://localhost:3000 in dev; https://smultron.redpine.software in prod

# Read-aloud pipeline (m12, SPEC §10) — all three required for scrape + listen
FIRECRAWL_API_KEY=               # Firecrawl v2 /scrape
ANTHROPIC_API_KEY=               # transcript clean-up + summary passes (claude-opus-5)
OPENAI_API_KEY=                  # text-to-speech (gpt-4o-mini-tts)
TTS_VOICE=                       # optional: OpenAI voice id, default `sage`
ARTICLE_AUDIO_BUCKET=            # optional: Supabase Storage bucket, default `article-audio`
```

## Hard rules (do not violate)

1. **Backfill/reconciliation never bumps `updated_at`.** Only live captures bump: `chrome.bookmarks.onCreated` events, web adds (`POST /api/bookmarks`), and highlight inserts (`/api/highlights`). Backfill upserts are `ON CONFLICT DO NOTHING`. The article pipeline (SPEC §10) is NOT a live capture and must never touch `bookmarks.updated_at` — `articles.updated_at` is a separate progress clock. See SPEC §Sync semantics.
2. **All data access goes through API routes using the service-role connection.** The `smultron` schema is NOT exposed to PostgREST; RLS is enabled with no anon policies. Never query the DB from the client; never ship the service-role key client-side.
3. **URL normalization happens server-side only** — one implementation in `web/`, unit-tested. The extension always sends raw URLs.
4. **Soft deletes only (bookmarks).** Never `DELETE` a bookmark row; set/clear `archived_at`. Highlights are hard-delete by design (SPEC §3).
5. **supabase-js is for auth only.** All reads/writes go through Drizzle. Article audio blobs live in Supabase Storage, reached over the Storage REST API with the service-role key (`web/src/lib/storage.ts`) — deliberately not a second supabase-js client, so this rule needs no exception.
6. **No realtime.** The feed polls via SWR. Do not add Supabase Realtime.

## Coordination

-   **Linear is the cross-session task board.** Create a project if one doesn't exist. One issue per milestone, titled `m<N>: <name>`, assigned to the project. Keep statuses current as you work; when completing a milestone, leave a checkpoint comment: what shipped, test status, anything blocked on the human. A fresh session must be able to orient from Linear + `git log` + SPEC alone.
-   **Delegate well-scoped tasks to subagents**, matching model/effort to complexity — high effort for sync semantics, normalization, auth/pairing, and outbox logic; low effort for boilerplate, config, and lint/test loops. The orchestrating agent reviews all subagent output against SPEC before committing.

## Conventions

-   Zod-validate every API route input; reject unknown fields.
-   Keep migrations in `web/drizzle/` under version control; schema changes go through `db:generate`, never hand-edited SQL against prod.
-   Vitest coverage is required for: URL normalization, upsert/bump/unarchive semantics, folder-tag derivation (`folderTags`) incl. the 0004 data migration, outbox queue behavior (incl. kind-routing + poison rule), highlight insert/bump/unarchive/409 semantics, the `textFragment` helper, note patch semantics (trim→NULL, never bumps `updated_at`) + by-url lookup/patch user scoping, web-add semantics (`addBookmark`: hostname title autofill, bump+unarchive-only conflict, per-user dedupe), the boundary-aware chunker (`chunkText`: limit never exceeded, separator fallback order, losslessness, the 4096-char TTS cap), article job semantics (`claimArticleRun`/`runArticleJob`: status machine, resume-skips-completed-steps, reset, stale-run re-claim, user scoping, and that NOTHING in the pipeline bumps `bookmarks.updated_at`), and TTS segmentation (per-request cap, ordered concatenation under out-of-order responses, all-or-nothing failure).
-   Small PRs / commits scoped to one milestone step (see SPEC §Milestones).
