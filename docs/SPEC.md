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
  tags           text[] not null default '{}',  -- first element = leafmost Chrome folder name at insert (none for default root containers)
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

create table smultron.highlights (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references auth.users(id),
  bookmark_id  bigint not null references smultron.bookmarks(id),
  text         text not null,            -- immutable snippet; no edit support
  created_at   timestamptz not null default now()
);
```

Highlights are **hard-deleted** (the soft-delete rule is scoped to bookmarks): a highlight is a low-stakes, easily-recreated capture, not deliberate curation. Duplicate texts per bookmark are allowed (no unique constraint).

Indexes:

-   `unique (user_id, url_normalized)` (above)
-   GIN on `to_tsvector('simple', title || ' ' || url_normalized)` for FTS
-   `gin (title gin_trgm_ops)` and `gin (url_normalized gin_trgm_ops)` via `pg_trgm` for fuzzy/substring
-   btree on `(user_id, updated_at desc) where archived_at is null` for the feed
-   btree on `highlights (bookmark_id, created_at)` for fetching a bookmark's highlights in order

Extensions required: `pg_trgm`. RLS: `alter table ... enable row level security` with **no policies** — the service role bypasses RLS; nothing else can read. Do not add the `smultron` schema to Supabase's "Exposed schemas" (PostgREST must not see it).

## 4. URL normalization (server-side only)

Applied to compute `url_normalized`; the original is stored untouched in `url`.

1. Parse; on failure, fall back to trimmed original.
2. Lowercase scheme and host.
3. Strip fragment (`#...`).
4. Remove tracking params: any `utm_*`, `fbclid`, `gclid`. **Keep all other query params** (often meaningful). Preserve remaining param order.
5. Strip a single trailing slash from the path (but keep root `/` as-is: `https://x.com/` → `https://x.com`). Strip only when the path ends in exactly one slash — a path ending in multiple slashes (`/a//`) is left untouched, keeping normalization idempotent (approved 2026-08-01).

One implementation in `web/src/lib/normalizeUrl.ts`, exhaustively unit-tested.

## 5. Sync semantics

Two write modes, distinguished by a `mode` field in the sync payload:

### `live` (from `chrome.bookmarks.onCreated`)

Upsert on `(user_id, url_normalized)`:

-   **Insert** if new: `created_at = updated_at = now()` (or event's `dateAdded` if present), tags derived from `folderPath` (approved 2026-08-02): the **leafmost folder name only** — and NO tag when the path is a single segment exactly matching one of Chrome's default root containers by name (`Bookmarks Bar`, `Other Bookmarks`, `Mobile Bookmarks` — name-matched, not structural, so a user's own top-level folder still tags; English names, localized Chrome would tag its containers). The extension keeps sending the full raw path (§6); the server derives (`folderTags` in `sync.ts`). Applies to backfill inserts identically. Existing rows were retagged by data migration `0004_leaf-folder-tags`.
-   **On conflict (re-save)**: `updated_at = now()`, `archived_at = null` (unarchive), `title = excluded.title`, `chrome_id = excluded.chrome_id`, `url = excluded.url` (the raw form refreshes to the newest spelling; approved 2026-08-01). Tags are NOT touched on re-save (site-owned after insert).

Live captures — this path and highlight inserts (below) — are the ONLY paths that bump `updated_at`.

### `backfill` (initial full import and startup reconciliation sweep)

Upsert on `(user_id, url_normalized)`:

-   **Insert** if new: `created_at = updated_at = dateAdded` when available, else `now()`.
-   **On conflict**: `DO NOTHING`. Never bump, never unarchive, never overwrite title/tags.

### `highlight` (from the context menu, via `POST /api/highlights`)

Server normalizes the URL and looks up `smultron.bookmarks` by `(user_id, url_normalized)`:

-   **Found**: insert the highlight row, and on the bookmark set `updated_at = now()`, `archived_at = null` — a highlight is a live capture in Chrome, so it resurfaces and unarchives the bookmark exactly like a live re-save (approved 2026-08-01). Title/tags/created_at untouched.
-   **Missing**: `409` — the extension drops the event (poison rule, §6) instead of retrying forever. Normally unreachable: the outbox's FIFO ordering guarantees the bookmark's insert is either acked or queued ahead of the highlight.

### Other Chrome events

`onChanged`, `onMoved`, `onRemoved`: **ignored** by design.

## 6. Extension (`extension/`, WXT, MV3)

-   `manifest`: permissions `bookmarks`, `storage`, `alarms`, `contextMenus`; `host_permissions` for `APP_URL`.
-   **Service worker**:
    -   `onCreated` listener → enqueue `{mode:'live', bookmark}` in outbox → flush.
    -   `chrome.runtime.onStartup` + `onInstalled` → reconciliation sweep: `chrome.bookmarks.getTree()`, flatten (skip folders; capture each bookmark's folder path), send in batches of ~500 as `{mode:'backfill', bookmarks:[...]}` → also flush outbox.
    -   Folder path = `/`-joined ancestor folder titles, e.g. `Bookmarks Bar/Dev/Postgres`.
-   **Highlights capture**: context-menu item ("Add highlight in Smultronstället", `contexts: ['selection']`, fixed id, re-created idempotently on `onInstalled`). `onClicked`:
    1.  Read `info.selectionText` (truncated to 10 000 chars) and `info.pageUrl`.
    2.  `chrome.bookmarks.search({url: pageUrl})`; if not bookmarked, `chrome.bookmarks.create(...)` (default folder, i.e. "Other Bookmarks") and enqueue its live entry DIRECTLY via the shared enqueue helper — don't rely on the `onCreated` listener's relative timing; its independent duplicate enqueue is harmless (live re-save is idempotent). A URL-variant miss in `search` creating a second Chrome bookmark is acceptable — the server dedupes by normalized URL.
    3.  Enqueue `{kind:'highlight', url: pageUrl, text}` after the bookmark entry, then flush. FIFO ordering guarantees the server sees the bookmark first.
-   **Outbox** (`chrome.storage.local`): append event → attempt POST → delete on 2xx. On failure keep queued; retry via `chrome.alarms` (e.g. every 5 min) with the queue flushed FIFO. Queue survives worker death and browser restarts. Entries route by kind: sync entries → `/api/sync`, highlight entries → `/api/highlights`. **Poison rule (highlight entries ONLY, approved 2026-08-01)**: a definitive 4xx (anything except 401) drops the entry and continues the flush; 401/5xx/network errors keep it queued. Sync entries keep the original halt-on-any-failure behavior. Pre-existing queued entries (no `kind` field) are treated as sync entries.
-   **Options page**: fields for API token and API base URL (default prod, overridable for dev). On save, send `POST /api/hello` with the token; show success/failure.
-   Extension sends **raw** URLs and Chrome's `dateAdded` (ms epoch) as-is.

## 7. Auth & pairing

### Site auth

-   Supabase Google OAuth via `@supabase/ssr` (PKCE, cookie sessions).
-   Post-login gate: if `session.user.email !== ALLOWED_EMAIL`, sign out and show a "not allowed" page. `ALLOWED_EMAIL` is optional (approved 2026-08-01): unset/empty disables the gate — any Google account may sign in, with per-user data isolation; set = single-user gate as above.

### Extension pairing

-   After first login, if the user's `api_tokens.paired_at` is null, the site blocks the happy path with a dialog:
    1. Server generates a random token (32 bytes, base64url), stores its sha256 in `smultron.api_tokens`, shows the raw token once with a copy button + extension install/options instructions.
    2. Dialog polls `GET /api/pairing-status` every few seconds.
    3. Extension options page saves the token and sends `POST /api/hello`; server verifies hash, sets `paired_at`.
    4. Dialog sees `paired: true` → unlocks the feed.
-   "Regenerate token" available in site settings — invalidates the old token, resets `paired_at` to null (the extension must save the new token and re-hello), and refreshes `api_tokens.created_at`. A user with no `api_tokens` row at all is treated as unpaired. (Recorded from implementation, 2026-08-01.)

### API auth

-   `/api/sync`, `/api/hello`, and `POST /api/highlights`: `Authorization: Bearer <token>` → sha256 → lookup in `api_tokens` → resolve `user_id`. 401 otherwise. Only `/api/sync` + `/api/hello` are excluded from the proxy matcher; `/api/highlights` stays matched because the same path carries the session-authed DELETE (harmless for the POST — the proxy never redirects `/api/*`).
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
-   `GET /api/bookmarks?q=&cursor=&archived=&tag=` — session auth. No `q`: feed ordered `updated_at desc`, cursor-paginated (50/page), `archived_at is null` unless `archived=1` (`archived=1` returns ONLY archived rows — it is the archived view, not an "include archived" flag). With `q`: FTS (`websearch_to_tsquery('simple', q)`) OR trgm similarity/substring on title + url_normalized, ordered by rank then recency; search returns a single page of 50 with no cursor. (Recorded from implementation, 2026-08-01.)
    -   `tag` is repeatable (`?tag=a&tag=b`), AND semantics (`tags @> ARRAY[...]`, exact string match — no trimming/case-folding); empty values are 400. Applies to feed and search alike, and composes with `cursor`. (m9, approved 2026-08-01.)
    -   Every response (cursor pages included — uniform shape) carries view aggregates: `total` (rows in the current view — user + archived state — ignoring `q`/`tag`), `matching` (view + `q` + `tag`, full uncapped count; equals `total` when neither filter is set), and `facets: Array<{tag, count}>` (view + `q`, IGNORING the active tag filter so a selected tag keeps its count; ordered count desc then tag asc; uncapped). Three aggregate queries per request over `unnest(tags)`; no new indexes — personal scale. (m9.)
-   `PATCH /api/bookmarks/:id` — session auth; body subset of `{ title, tags, archived }` (`archived: true|false` sets/clears `archived_at`). Site edits NEVER bump `updated_at` — only live captures do (§5).
-   `POST /api/highlights` — token auth (same as `/api/sync`); body `{ url: string; text: string }` (`text`: `min(1).max(10000)`), unknown fields rejected. Applies §5 highlight semantics (insert + bump + unarchive); `409` when no bookmark matches the normalized URL. Returns the created highlight `{id, bookmarkId, text, createdAt}`.
-   `DELETE /api/highlights/:id` — session auth; ownership-checked hard delete; `404` when not found/not owned.
-   `GET /api/bookmarks` responses include each bookmark's `highlights: Array<{id, text, createdAt}>` ordered `created_at asc` (nested — no separate fetch; approved 2026-08-01).

## 9. UI (site)

-   **Feed (v2 "log view", m9 — from the approved Claude Design mock `Feed v2 - Log View.dc.html`)**: dense reverse-chron log rows in a full-viewport shell (header + search toolbar fixed; the log pane and facets aside scroll internally). Each row: expand caret, `updated_at` timestamp (`Aug 1 09:14`; year instead of time outside the current year), favicon (Google s2), host, title, `✱ N` highlight-count pill, clickable tag chips (toggle that tag filter), Archive/Restore. Clicking a row expands an inline panel (single row expanded at a time): full URL link-out, `saved <created_at> · <relative>` line, inline title/tags editing, highlight cards. SWR polling ~10s on page 1; deeper pages via an IntersectionObserver infinite-scroll sentinel (feed only — search is a single ranked page). Instant search via `/api/bookmarks?q=` (debounced ~150ms).
-   **Tag facets (m9)**: left sidebar lists every tag in the current view+search with counts (from the API's `facets`), a Datadog-style filter input under the heading (client-side case-insensitive substring over the facet list only — never part of the API key), multi-select AND filtering (chips in rows toggle too), `clear` resets; toolbar shows `matching of total`. Switching the live/archived view clears the tag filter and collapses the expanded row. Fixed presentation defaults: compact density, facets visible (hidden below `md` along with the host column), accent `#4F46E5` via a scoped `--log-accent` CSS var.
-   **Row actions**: edit title, edit tags (in the expanded panel), archive/restore. Archived view toggle; restore from there.
-   **Highlights (expanded panel)**: each highlight card has a hard-delete button (no confirmation — low stakes) and links out to the bookmark URL with a generated `#:~:text=` fragment (built at render time from the stored text by `web/src/lib/textFragment.ts`: exact match for short selections ≲150 chars, `textStart,textEnd` word-boundary split for longer ones, percent-encoding `-`/`&`/`,` per the text-fragment spec; unit-tested). Highlight text is NOT in feed search (v1).
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
8. Highlights: `highlights` schema + migrations; `/api/highlights` + §5 highlight semantics + nested feed highlights; extension context-menu capture + outbox kind-routing + poison rule; feed UI (expandable list, delete, `#:~:text=` link-out).

## 12. Out of scope (v1)

Page-content fetching/enrichment, summaries, embeddings/semantic search, realtime, multi-user onboarding, mobile capture. The schema and API shapes should not preclude these.isCloseMatch
