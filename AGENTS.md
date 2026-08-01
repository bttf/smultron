# Smultronstället

Personal bookmarks app: a Chrome extension captures the user's Chrome bookmarks and syncs them to a Next.js site (live feed + fast search) backed by Supabase Postgres.

-   Display name: **Smultronstället**. Infra/code name: **smultron** (DB schema, subdomain, package names).
-   Production: `https://smultron.redpine.software` (Vercel). Local dev: `http://localhost:3000`.

**Read `docs/SPEC.md` before implementing any feature.** It contains the data model, sync semantics, normalization rules, pairing flow, and API contracts. This file only covers how to work in the repo.

## Repo layout

pnpm workspace monorepo, TypeScript everywhere, Node 20, pnpm 9.

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
ALLOWED_EMAIL=                   # the single Google account allowed to sign in
APP_URL=                         # http://localhost:3000 in dev; https://smultron.redpine.software in prod
```

## Hard rules (do not violate)

1. **Backfill/reconciliation never bumps `updated_at`.** Only live `chrome.bookmarks.onCreated` events bump. Backfill upserts are `ON CONFLICT DO NOTHING`. See SPEC §Sync semantics.
2. **All data access goes through API routes using the service-role connection.** The `smultron` schema is NOT exposed to PostgREST; RLS is enabled with no anon policies. Never query the DB from the client; never ship the service-role key client-side.
3. **URL normalization happens server-side only** — one implementation in `web/`, unit-tested. The extension always sends raw URLs.
4. **Soft deletes only.** Never `DELETE` a bookmark row; set/clear `archived_at`.
5. **supabase-js is for auth only.** All reads/writes go through Drizzle.
6. **No realtime.** The feed polls via SWR. Do not add Supabase Realtime.

## Coordination

-   **Linear is the cross-session task board.** Create a project if one doesn't exist. One issue per milestone, titled `m<N>: <name>`, assigned to the project. Keep statuses current as you work; when completing a milestone, leave a checkpoint comment: what shipped, test status, anything blocked on the human. A fresh session must be able to orient from Linear + `git log` + SPEC alone.
-   **Delegate well-scoped tasks to subagents**, matching model/effort to complexity — high effort for sync semantics, normalization, auth/pairing, and outbox logic; low effort for boilerplate, config, and lint/test loops. The orchestrating agent reviews all subagent output against SPEC before committing.

## Conventions

-   Zod-validate every API route input; reject unknown fields.
-   Keep migrations in `web/drizzle/` under version control; schema changes go through `db:generate`, never hand-edited SQL against prod.
-   Vitest coverage is required for: URL normalization, upsert/bump/unarchive semantics, outbox queue behavior.
-   Small PRs / commits scoped to one milestone step (see SPEC §Milestones).
