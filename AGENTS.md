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
FIRECRAWL_API_KEY=               # Firecrawl v2 /scrape — also the m17 web-add title/favicon/note fill (SPEC §5)
ANTHROPIC_API_KEY=               # transcript clean-up + summary passes (claude-opus-5)
OPENAI_API_KEY=                  # text-to-speech (gpt-4o-mini-tts)
TTS_VOICE=                       # optional: OpenAI voice id, default `sage`
ARTICLE_AUDIO_BUCKET=            # optional: Supabase Storage bucket, default `article-audio`
```

## Hard rules (do not violate)

1. **Backfill/reconciliation never bumps `updated_at`.** Only live captures bump: `chrome.bookmarks.onCreated` events, web adds (`POST /api/bookmarks`), and highlight inserts (`/api/highlights`). Backfill upserts are `ON CONFLICT DO NOTHING`. The article pipeline (SPEC §10) is NOT a live capture and must never touch `bookmarks.updated_at` — `articles.updated_at` is a separate progress clock. Neither is the m17 web-add metadata fill (`bookmarkMetadata.ts`, SPEC §5): it writes `title`/`favicon_url` only. Browse-event capture (m19, SPEC §13) never touches the bookmarks table at all. Pinning, unpinning and shelf reordering (m13/m21: `pinned` on the PATCH routes, `PUT /api/bookmarks/pinned`) write `pinned_at`/`pin_position` only — a reorder doesn't even touch `pinned_at`. A URL edit (m22: `url` on PATCH `:id`) writes `url` + `url_normalized` (nulling `favicon_url` on a host change) and nothing else. See SPEC §Sync semantics.
2. **All data access goes through API routes using the service-role connection.** The `smultron` schema is NOT exposed to PostgREST; RLS is enabled with no anon policies. Never query the DB from the client; never ship the service-role key client-side.
3. **URL normalization happens server-side only** — one implementation in `web/`, unit-tested. The extension always sends raw URLs.
4. **Soft deletes only (bookmarks).** Never `DELETE` a bookmark row; set/clear `archived_at`. Highlights are hard-delete by design (SPEC §3).
5. **supabase-js is for auth only.** All reads/writes go through Drizzle. Article audio blobs live in Supabase Storage, reached over the Storage REST API with the service-role key (`web/src/lib/storage.ts`) — deliberately not a second supabase-js client, so this rule needs no exception.
6. **No realtime.** The feed polls via SWR. Do not add Supabase Realtime.

## Coordination

-   **Linear is the cross-session task board.** Create a project if one doesn't exist. One issue per milestone, titled `m<N>: <name>`, assigned to the project. Keep statuses current as you work; when completing a milestone, leave a checkpoint comment: what shipped, test status, anything blocked on the human. A fresh session must be able to orient from Linear + `git log` + SPEC alone.
-   **Delegate well-scoped tasks to subagents**, matching model/effort to complexity — high effort for sync semantics, normalization, auth/pairing, and outbox logic; low effort for boilerplate, config, and lint/test loops. The orchestrating agent reviews all subagent output against SPEC before committing.
-   **Feature workflow: plan with Fable → implement with Opus → review with Fable.** The orchestrating session (Fable) does the planning itself: reads SPEC, makes the design decisions, and writes the SPEC/AGENTS updates BEFORE any implementation, so subagents build against a recorded contract. Implementation is delegated to **Opus** subagents with self-contained briefs (exact contract, files to touch, tests required, relevant hard rules — assume the subagent has read nothing). Before merge, a **fresh Fable subagent with no implementation context** reviews the full branch diff at high effort against SPEC and the hard rules; confirmed findings are fixed on the branch first, then merge.

## Conventions

-   Zod-validate every API route input; reject unknown fields.
-   Keep migrations in `web/drizzle/` under version control; schema changes go through `db:generate`, never hand-edited SQL against prod.
-   Vitest coverage is required for: URL normalization (incl. the m22 fragment rules: fragments KEPT — Gmail-style SPA routes stay distinct — with the `:~:` text-fragment directive stripped even mid-fragment (`#a:~:text=x` → `#a`), a bare/emptied `#` dropped, the same fragment rule on non-http(s) schemes, and idempotency), the `0013_keep-fragments` recompute data migration (bookmarks AND browse_events, tested against the REAL migration like 0004: seed old-style rows, apply 0013, assert the SQL result equals the TS `normalizeUrl(url)` over a corpus that includes parse-failure rows — `url_normalized` already containing `#` — which must be left alone), URL patch semantics (m22: `url` accepted on the `:id` route only — recomputes `url_normalized`, 409 `duplicate_url` mapping with the conflicting bare row on a unique collision, `favicon_url` nulled exactly on host change, never bumps `updated_at`, user scoping; the by-url PATCH treats `url` as selector only), upsert/bump/unarchive semantics, folder-tag derivation (`folderTags`) incl. the 0004 data migration, outbox queue behavior (incl. kind-routing + poison rule), highlight insert/bump/unarchive/409 semantics, the `textFragment` helper, note patch semantics (trim→NULL, never bumps `updated_at`) + by-url lookup/patch user scoping, pin semantics (m13/m22: pin/unpin never bumps `updated_at`, archive↔pin mutual exclusion, feed-log INCLUSION — m22 retired m13's exclusion, so the feed lists pinned rows and `matching` no longer subtracts them — shelf ordering + search findability, live re-save keeps `pinned_at`), shelf ordering (m21: `reorderPinned` — dense `0..k-1` slots in list order, ids not pinned or not the caller's ignored, pinned rows missing from the list keep their relative order after the listed ones, user scoping, `updated_at` AND `pinned_at` byte-identical; a new pin takes `max+1` (end of shelf), re-pin is a no-op on both columns, unpin/archive null `pin_position`; the shelf sorts by `pin_position`; the 0012 backfill seats pre-existing pins in the m13 `pinned_at desc, id desc` order — tested against the REAL migration like 0004), the `PUT /api/bookmarks/pinned` body validation (empty, duplicates, non-integers, unknown fields → 400), the web shelf order override (`orderShelf` in `web/src/lib/shelfOrder.ts`: override order applied over the server's shelf, unknown override ids dropped, unlisted server rows appended in server order, "confirmed" detection when the server already matches), the extension `moveItem` helper and `putPinnedOrder` fetch mapping (`extension/src/pinOrder.ts`: bounds, no-op moves, Bearer header + JSON body, 401 vs other statuses vs network failure), web-add semantics (`addBookmark`: hostname title autofill, bump+unarchive-only conflict, per-user dedupe), the web-add metadata fill (`enrichBookmarkMetadata`: never bumps `updated_at`, never overwrites an owned title or an existing note — including against mid-flight edits — fills `favicon_url` only when null, seeds `note` from the scrape summary only when null, skips the fetch when title+favicon are present — a missing note alone never scrapes — and never throws; plus the favicon-URL validation in `firecrawl.ts`), the boundary-aware chunker (`chunkText`: limit never exceeded, separator fallback order, losslessness, the 4096-char TTS cap), article job semantics (`claimArticleRun`/`runArticleJob`: status machine, resume-skips-completed-steps, reset, stale-run re-claim, user scoping, and that NOTHING in the pipeline bumps `bookmarks.updated_at`), TTS segmentation (per-request cap, ordered concatenation under out-of-order responses, all-or-nothing failure), audio-bucket bootstrap (`ensureBucket` in `storage.ts`: an existing bucket never fails an upload — plain 409, Supabase's 400-wrapped `BucketAlreadyExists` body, and the existence-check fallback for unrecognized failures — plus per-bucket-name memoization and 5xx retryability), tag-suggestion filtering (m14: `filterTagSuggestions` in BOTH web and extension — prefix-before-substring ranking, applied-tag exclusion, trim/empty-draft handling, cap), the `/api/tags` listing (`listTags`: user scoping, distinct across rows, archived rows included, count-desc/tag-asc ordering), the popup tag-save coalescer (m15: ≤1 send in flight, trailing send carries latest state, intermediate states skippable, failure propagation, in-order completion), the action-icon tracked cache (m15: TTL expiry, optimistic overrides win until expiry, invalidation, never-glow-on-uncertainty resolution), browse-event insert semantics (m19: `applyBrowseEvents` — user scoping, `client_event_id` dedupe via DO NOTHING, URL normalization applied, bookmarks table untouched), `listBrowseEvents` (kind/q filters, keyset cursor, `occurred_at desc, id desc` ordering, uncapped `total`), the `/api/browse-events` route validation (per-kind field requirements, 500-event cap, unknown-field rejection), the extension browse buffer (m19: append AND drain serialized through one mutex — no loss under interleaving, enqueue-before-clear so worker death duplicates rather than drops, drain batching ≤500 + drain triggers, drop-oldest caps that never touch sync/highlight entries), theme-preference resolution (`web/src/lib/theme.ts`: `resolveTheme` — `system` follows the media query, an explicit choice pins the palette in BOTH directions; `parseThemePreference` degrades corrupt/absent values to `system`; and the inlined `THEME_INIT_SCRIPT` resolves identically, including when `localStorage` throws), outbox `browse`-kind routing + its poison rule, capture-session boundaries (m19: fresh `bootId` + `capture_start` on startup/enable, `capture_stop` on disable, baseline `tab_activated` emission), capture gating (toggle off = ZERO events observed/buffered/sent), the new tab snapshot cache (m20: `readSnapshot` degrades corrupt/absent/legacy values to "no cache" and NEVER throws, `writeSnapshot` caps the stored recent rows, round-trip fidelity), the new tab fetch mapping (`fetchBookmarksPage`: Bearer header, `q` encoding, 401 vs other statuses vs network failure), the latest-wins search sequencer (out-of-order responses discarded), and the request-auth resolver (`requestAuth.ts`: an Authorization header takes the token path and NEVER falls back to the session, no header falls through to the session).
-   Small PRs / commits scoped to one milestone step (see SPEC §Milestones).
