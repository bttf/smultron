# Smultronstället — Spec

> Lives at `docs/SPEC.md`. AGENTS.md points here. This is the source of truth for behavior.

## 1. Overview

Single-user-in-practice bookmarks app. A Chrome MV3 extension observes the user's bookmarks and syncs them (insert-only) to a Next.js site backed by Supabase Postgres. The site shows a live feed sorted by recency with fast search, and owns all edits after insert.

-   **Chrome is the source of truth via inserts only.** No updates or deletes propagate from Chrome. Once a bookmark is inserted, editing (title, tags) and deleting happen only on the site.
-   Auth is Supabase Google OAuth (multi-user capable), gated to `ALLOWED_EMAIL`.
-   Data model and API are multi-user shaped (`user_id` everywhere) even though one user is expected.

## 2. Architecture

```
Chrome bookmarks API
      │  onCreated (live) / getTree (backfill + startup sweep)
      ▼
MV3 service worker ──► outbox queue (chrome.storage.local)
      │  POST /api/sync  (Authorization: Bearer <api token>)
      ▼
Next.js API routes (Vercel) ── service-role ──► Supabase Postgres, schema `smultron`
      ▲
      │  GET /api/bookmarks (search/feed), PATCH /api/bookmarks/:id
Site UI (SWR polling ~10s)
```

## 3. Data model (schema `smultron`)

```sql
create table smultron.bookmarks (
  id             bigint generated always as identity primary key,
  user_id        uuid not null references auth.users(id),
  url            text not null,          -- original, as sent by Chrome
  url_normalized text not null,         -- dedupe key, computed server-side
  title          text not null default '',
  chrome_id      text,                   -- Chrome's bookmark node id (latest seen)
  tags           text[] not null default '{}',  -- first element = Chrome folder path at insert
  created_at     timestamptz not null,   -- first save (Chrome dateAdded when available)
  updated_at     timestamptz not null,   -- recency; feed sort key
  archived_at    timestamptz,            -- null = live; soft delete
  unique (user_id, url_normalized)
);

create table smultron.api_tokens (
  user_id     uuid primary key references auth.users(id),
  token_hash  text not null,             -- sha256 of the token; raw token never stored
  paired_at   timestamptz,               -- set on first /api/hello
  created_at  timestamptz not null default now()
);
```

Indexes:

-   `unique (user_id, url_normalized)` (above)
-   GIN on `to_tsvector('simple', title || ' ' || url_normalized)` for FTS
-   `gin (title gin_trgm_ops)` and `gin (url_normalized gin_trgm_ops)` via `pg_trgm` for fuzzy/substring
-   btree on `(user_id, updated_at desc) where archived_at is null` for the feed

Extensions required: `pg_trgm`. RLS: `alter table ... enable row level security` with **no policies** — the service role bypasses RLS; nothing else can read. Do not add the `smultron` schema to Supabase's "Exposed schemas" (PostgREST must not see it).

## 4. URL normalization (server-side only)

Applied to compute `url_normalized`; the original is stored untouched in `url`.

1. Parse; on failure, fall back to trimmed original.
2. Lowercase scheme and host.
3. Strip fragment (`#...`).
4. Remove tracking params: any `utm_*`, `fbclid`, `gclid`. **Keep all other query params** (often meaningful). Preserve remaining param order.
5. Strip a single trailing slash from the path (but keep root `/` as-is: `https://x.com/` → `https://x.com`).

One implementation in `web/src/lib/normalizeUrl.ts`, exhaustively unit-tested.

## 5. Sync semantics

Two write modes, distinguished by a `mode` field in the sync payload:

### `live` (from `chrome.bookmarks.onCreated`)

Upsert on `(user_id, url_normalized)`:

-   **Insert** if new: `created_at = updated_at = now()` (or event's `dateAdded` if present), tags = `[folderPath]`.
-   **On conflict (re-save)**: `updated_at = now()`, `archived_at = null` (unarchive), `title = excluded.title`, `chrome_id = excluded.chrome_id`. Tags are NOT touched on re-save (site-owned after insert).

This is the ONLY path that bumps `updated_at`.

### `backfill` (initial full import and startup reconciliation sweep)

Upsert on `(user_id, url_normalized)`:

-   **Insert** if new: `created_at = updated_at = dateAdded` when available, else `now()`.
-   **On conflict**: `DO NOTHING`. Never bump, never unarchive, never overwrite title/tags.

### Other Chrome events

`onChanged`, `onMoved`, `onRemoved`: **ignored** by design.

## 6. Extension (`extension/`, WXT, MV3)

-   `manifest`: permissions `bookmarks`, `storage`, `alarms`; `host_permissions` for `APP_URL`.
-   **Service worker**:
    -   `onCreated` listener → enqueue `{mode:'live', bookmark}` in outbox → flush.
    -   `chrome.runtime.onStartup` + `onInstalled` → reconciliation sweep: `chrome.bookmarks.getTree()`, flatten (skip folders; capture each bookmark's folder path), send in batches of ~500 as `{mode:'backfill', bookmarks:[...]}` → also flush outbox.
    -   Folder path = `/`-joined ancestor folder titles, e.g. `Bookmarks Bar/Dev/Postgres`.
-   **Outbox** (`chrome.storage.local`): append event → attempt POST → delete on 2xx. On failure keep queued; retry via `chrome.alarms` (e.g. every 5 min) with the queue flushed FIFO. Queue survives worker death and browser restarts.
-   **Options page**: fields for API token and API base URL (default prod, overridable for dev). On save, send `POST /api/hello` with the token; show success/failure.
-   Extension sends **raw** URLs and Chrome's `dateAdded` (ms epoch) as-is.

## 7. Auth & pairing

### Site auth

-   Supabase Google OAuth via `@supabase/ssr` (PKCE, cookie sessions).
-   Post-login gate: if `session.user.email !== ALLOWED_EMAIL`, sign out and show a "not allowed" page. (Multi-user later = replace this check.)

### Extension pairing

-   After first login, if the user's `api_tokens.paired_at` is null, the site blocks the happy path with a dialog:
    1. Server generates a random token (32 bytes, base64url), stores its sha256 in `smultron.api_tokens`, shows the raw token once with a copy button + extension install/options instructions.
    2. Dialog polls `GET /api/pairing-status` every few seconds.
    3. Extension options page saves the token and sends `POST /api/hello`; server verifies hash, sets `paired_at`.
    4. Dialog sees `paired: true` → unlocks the feed.
-   "Regenerate token" available in site settings (invalidates old token).

### API auth

-   `/api/sync` and `/api/hello`: `Authorization: Bearer <token>` → sha256 → lookup in `api_tokens` → resolve `user_id`. 401 otherwise.
-   `/api/bookmarks*`: Supabase session cookie (site user).

## 8. API

All inputs Zod-validated; unknown fields rejected.

-   `POST /api/hello` — body `{}`; token auth; sets `paired_at`; returns `{ok:true}`.
-   `POST /api/sync` — token auth; body:
    ```ts
    { mode: 'live' | 'backfill',
      bookmarks: Array<{ url: string; title: string; chromeId: string;
                         dateAddedMs?: number; folderPath?: string }> }  // max 500
    ```
    Server normalizes URLs and applies §5 semantics. Returns `{inserted, bumped, skipped}`.
-   `GET /api/bookmarks?q=&cursor=&archived=` — session auth. No `q`: feed ordered `updated_at desc`, cursor-paginated (50/page), `archived_at is null` unless `archived=1`. With `q`: FTS (`websearch_to_tsquery('simple', q)`) OR trgm similarity/substring on title + url_normalized, ordered by rank then recency.
-   `PATCH /api/bookmarks/:id` — session auth; body subset of `{ title, tags, archived }` (`archived: true|false` sets/clears `archived_at`).

## 9. UI (site)

-   **Feed**: reverse-chron cards (favicon via Google s2, title, host, relative time, tag chips). SWR polling ~10s. Instant search box filtering via `/api/bookmarks?q=` (debounced ~150ms).
-   **Row actions**: edit title, edit tags, archive. Archived view toggle; unarchive from there.
-   **Empty state**: "Install the extension" with pairing instructions if paired but 0 bookmarks; pairing dialog if unpaired (§7).
-   Dark-mode friendly, keyboard-first search (`/` focuses the box). Keep it minimal — this is a personal tool.

## 10. Google OAuth setup (one-time, manual)

1. Google Cloud Console → create OAuth 2.0 Client ID (Web application).
    - Authorized redirect URI: `https://<project-ref>.supabase.co/auth/v1/callback`.
2. Supabase Dashboard → Authentication → Providers → Google → enable; paste client ID + secret.
3. Supabase Auth URL config: Site URL `https://smultron.redpine.software`; add `http://localhost:3000` to additional redirect URLs.
4. Vercel: add the domain `smultron.redpine.software`; add a CNAME for `smultron` at the DNS host for `redpine.software`.

## 11. Milestones

1. Scaffold monorepo (pnpm workspaces, web + extension via WXT, Biome, Vitest).
2. Drizzle schema + migrations for `smultron` (tables, indexes, `pg_trgm`), RLS enabled.
3. `normalizeUrl` + upsert semantics (`live`/`backfill`) with unit tests; `/api/sync`, `/api/hello`.
4. Extension: onCreated capture, outbox + alarm retry, startup reconciliation sweep, options page.
5. Auth: Google OAuth + `ALLOWED_EMAIL` gate; pairing dialog + token lifecycle.
6. Feed UI + search + edit/archive.
7. Deploy: Vercel + domain, load extension unpacked, run initial backfill, verify end-to-end.

## 12. Out of scope (v1)

Page-content fetching/enrichment, summaries, embeddings/semantic search, realtime, multi-user onboarding, mobile capture. The schema and API shapes should not preclude these.isCloseMatch
