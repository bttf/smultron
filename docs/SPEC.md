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
  favicon_url    text,                   -- m17: page's own icon, filled from Firecrawl after a web add; null = never resolved
  chrome_id      text,                   -- Chrome's bookmark node id (latest seen)
  tags           text[] not null default '{}',  -- first element = leafmost Chrome folder name at insert (none for default root containers)
  note           text,                   -- user note (m10); null = none; one note per bookmark
  created_at     timestamptz not null,   -- first save (Chrome dateAdded when available)
  updated_at     timestamptz not null,   -- recency; feed sort key
  archived_at    timestamptz,            -- null = live; soft delete
  pinned_at      timestamptz,            -- m13: null = not pinned; shelf ordering key (most recent first)
  unique (user_id, url_normalized)
);

create table smultron.api_tokens (
  user_id     uuid primary key references auth.users(id),
  token_hash  text not null,             -- sha256 of the token; raw token never stored
  paired_at   timestamptz,               -- set on first /api/hello
  created_at  timestamptz not null default now()
);

-- m19: attention-tracking browse events (§13). Append-only telemetry;
-- COMPLETELY separate from bookmarks — nothing here references or touches
-- the bookmarks table.
create table smultron.browse_events (
  id                 bigint generated always as identity primary key,
  user_id            uuid not null references auth.users(id),  -- FK rides a hand-written migration (auth.users is unmodeled in Drizzle; 0001 pattern)
  client_event_id    text not null,       -- extension-minted uuid; idempotency key for at-least-once delivery
  boot_id            text not null,       -- capture-session uuid (§13); dwell intervals never span boot_ids
  kind               text not null,       -- 'nav' | 'tab_activated' | 'window_focus' | 'window_blur' | 'idle' | 'capture_start' | 'capture_stop'
  occurred_at        timestamptz not null, -- client clock at capture; the timeline key
  url                text,                -- raw, as captured (kind-dependent, §13)
  url_normalized     text,                -- server-derived (§4); null when url is null
  title              text,                -- tab title where known (§13)
  tab_id             integer,             -- Chrome tab id (kind-dependent)
  window_id          integer,             -- Chrome window id (kind-dependent)
  idle_state         text,                -- 'active' | 'idle' | 'locked'; only for kind='idle'
  transition         text,                -- nav only: transition type + qualifiers, '|'-joined
  document_lifecycle text,                -- nav only: webNavigation documentLifecycle verbatim when present ('prerender' navs are recorded, flagged, filtered retroactively)
  created_at         timestamptz not null default now(),  -- server receipt time (clock-skew diagnosis)
  unique (user_id, client_event_id)
);

create table smultron.highlights (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references auth.users(id),
  bookmark_id  bigint not null references smultron.bookmarks(id),
  text         text not null,            -- immutable snippet; no edit support
  created_at   timestamptz not null default now()
);

-- m12: scraped article + read-aloud pipeline (§10). One row per bookmark.
create table smultron.articles (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references auth.users(id),
  bookmark_id   bigint not null references smultron.bookmarks(id) unique,
  status        text not null default 'queued',  -- queued|scraping|cleaning|summarizing|ready|failed
  error         text,                    -- failure reason, shown verbatim in the UI
  source_url    text,                    -- Firecrawl's resolved URL (post-redirect)
  title         text,                    -- title Firecrawl extracted
  raw_markdown  text,                    -- Firecrawl output; kept so a re-run can skip the scrape
  transcript    text,                    -- cleaned spoken prose
  summary       text,                    -- LLM spoken summary of the transcript
  word_count    integer,                 -- words in `transcript`
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()  -- the ARTICLE's progress clock (§10)
);

-- Synthesized audio, cached per (article, kind, voice).
create table smultron.article_audio (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references auth.users(id),
  article_id    bigint not null references smultron.articles(id),
  kind          text not null,           -- 'summary' | 'transcript'
  voice         text not null,           -- OpenAI voice id; part of the cache key
  storage_path  text not null,           -- object path within the audio bucket
  byte_size     integer not null,
  char_count    integer not null,
  segment_count integer not null,        -- TTS requests it took (4096-char cap, §10)
  created_at    timestamptz not null default now(),
  unique (article_id, kind, voice)
);
```

`articles.updated_at` is **not** a feed sort key and has nothing to do with `bookmarks.updated_at` — it is the article run's own progress clock, used only for stale-run detection (§10). The article pipeline never writes `bookmarks.updated_at` (Hard rule #1): scraping is a site-initiated enrichment, not a live capture, and must not resurface a bookmark.

`status` is plain `text`, not a pg enum — the status set is expected to evolve and that keeps it a code change rather than an `ALTER TYPE` migration. The TS union `ARTICLE_STATUSES` in `db/schema.ts` is the authority; an unrecognized value read back is treated as `failed`.

Highlights are **hard-deleted** (the soft-delete rule is scoped to bookmarks): a highlight is a low-stakes, easily-recreated capture, not deliberate curation. Duplicate texts per bookmark are allowed (no unique constraint).

Indexes:

-   `unique (bookmark_id)` on `articles` (one article per bookmark) and `btree (user_id, bookmark_id)` for the ownership-scoped lookup
-   `unique (article_id, kind, voice)` on `article_audio`
-   `unique (user_id, url_normalized)` (above)
-   GIN on `to_tsvector('simple', title || ' ' || url_normalized || ' ' || coalesce(note, ''))` for FTS (note included since m10 — the query expression in `bookmarks.ts` must stay byte-identical or the index goes unused)
-   `gin (title gin_trgm_ops)` and `gin (url_normalized gin_trgm_ops)` via `pg_trgm` for fuzzy/substring
-   btree on `(user_id, updated_at desc) where archived_at is null` for the feed
-   btree on `(user_id, pinned_at desc) where pinned_at is not null` for the pinned shelf (m13)
-   btree on `highlights (bookmark_id, created_at)` for fetching a bookmark's highlights in order
-   `unique (user_id, client_event_id)` on `browse_events` (idempotent batch inserts) and btree on `browse_events (user_id, occurred_at desc, id desc)` covering the log view's keyset + retroactive analysis (m19)

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
-   **On conflict (re-save)**: `updated_at = now()`, `archived_at = null` (unarchive), `title = excluded.title`, `chrome_id = excluded.chrome_id`, `url = excluded.url` (the raw form refreshes to the newest spelling; approved 2026-08-01). Tags are NOT touched on re-save (site-owned after insert); neither is `pinned_at` (pins are site-owned, m13 — a re-save keeps the row wherever it sat on the shelf).

Live captures — this path, web adds (below), and highlight inserts (below) — are the ONLY paths that bump `updated_at`.

### `web add` (site composer, via `POST /api/bookmarks`, m11)

A deliberate user save in the site's Add composer is a live capture. Session-authed upsert on `(user_id, url_normalized)` from a raw URL:

-   **Insert** if new: `created_at = updated_at = now()`, `title` autofilled server-side from the hostname (`www.` stripped), no tags, no `chrome_id`.
-   **On conflict**: `updated_at = now()`, `archived_at = null` — bump + unarchive ONLY. Title/tags/url/chrome_id/created_at stay untouched: unlike a Chrome live re-save, there is no fresher title or raw spelling to trust over what the site already owns.

#### Metadata fill (m17)

A Chrome capture arrives with the tab's real title; a URL typed into the Add composer (or shared from Android) arrives with nothing but its hostname. So every web add is followed by a Firecrawl fetch (`scrapePageMetadata`, `lib/firecrawl.ts` — `formats: ["summary"]`, the same client and error mapping as §10's scrape) that writes the page's `title` and `favicon_url` onto the row and seeds its `note` (`enrichBookmarkMetadata`, `lib/bookmarkMetadata.ts`). Title and favicon come from the response's `metadata` object — Firecrawl parses the page and resolves the favicon to an absolute URL itself (approved 2026-08-09, replacing the earlier rawHtml + hand-parsed `<title>`/`<link rel=icon>` design; no client-side HTML parsing remains). Our validation still applies before storing: `data:`/non-http(s)/oversized favicon URLs are dropped and no `/favicon.ico` is guessed — a stored URL that 404s is worse than none, since the UI falls back to a hostname-derived icon (§9). The summary format costs no extra Firecrawl credits over the old rawHtml scrape (1 credit either way) but adds LLM latency on cache misses (~5-15s) — acceptable because the deadline/`after()` path below already covers slow fills.

-   The fill is **not** a live capture: it NEVER bumps `bookmarks.updated_at` (Hard rule #1), exactly like the article pipeline. The add itself already bumped it.
-   It never overwrites a title the user owns: only a row whose title is empty or still the hostname placeholder is eligible, and the guard is re-checked in the UPDATE, so an edit made while the fetch was in flight wins. `favicon_url` is only ever filled when null.
-   It never fails the add and never throws — a failed scrape leaves the bookmark with its hostname title.
-   **Note seeding (approved 2026-08-09)**: the same scrape's `summary` is written to `note` — ONLY when `note` is NULL, with the guard re-checked in the UPDATE exactly like the title's (a note typed while the fetch was in flight wins). Trimmed; hard-capped at the note's 10 000-char limit. Seeding makes a web add immediately findable by content (m10 note search) and gives the log row its one-line preview.
-   It doesn't scrape at all when the row already has a real title and a favicon, so re-adding a known URL stays instant. A missing note alone NEVER triggers a scrape — note seeding is opportunistic on scrapes that happen anyway, which is what keeps a deleted seeded note deleted when the URL is re-added.
-   **Nothing waits on it (m18 — replaced m17's bounded 12s wait)**: `POST /api/bookmarks` returns the row IMMEDIATELY (hostname title, null favicon/note) and the fill ALWAYS completes in `after()`, reaching the feed on a subsequent poll. The Android share target (`GET /share`, m16) was always like this. The client owns the "still filling" affordance (§9) — the server keeps no fill-status state; a failed fill simply leaves the hostname title, indistinguishable from (and handled identically to) a slow one.

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
-   **Popup (m10)**: browser-action popup (`entrypoints/popup/`, vanilla TS; manifest adds `activeTab` — broad `tabs` arrived later with the m15 icon watcher, below). Looks up the active tab via `GET /api/bookmarks/by-url` and shows: unpaired → open-settings prompt; non-http(s) tab → "Nothing to bookmark here."; not bookmarked → a **"Bookmark this page" CTA** (auto-bookmark-on-open was approved 2026-08-02 and REVERTED in m15 — opening the popup must not mutate anything, in Chrome or the DB): clicking the CTA runs `chrome.bookmarks.search({url})` first, `chrome.bookmarks.create` only on a miss (default folder — the `onCreated` live-capture path syncs + bumps; the search guard keeps repeat clicks from minting duplicate Chrome rows while sync lags), then polls by-url (~800ms, 12s cap) until the row lands and swaps to the editing card; if create or the poll fails the CTA re-renders with the error; bookmarked/archived → editing card (title, tag chips, note textarea, `saved <relative>` line). Title and note edits accumulate locally; **Save** sends ONE `PATCH /api/bookmarks/by-url {url, title, tags, note}` with "Saved ✓" feedback only on 2xx; Archive/Restore patches `archived`. **Tag mutations save immediately (m15)**: every mutation (⏎ add, suggestion pick, ✕ remove, Backspace pop) repaints the chips at once and PATCHes the full tags array — a state toggle like pin/archive, matching the web panel's per-mutation semantics. Sends COALESCE: at most one PATCH in flight, a mutation during flight marks a trailing send that carries the latest full array (intermediate arrays may never be sent); the coalescing serializer is a pure helper in `extension/src/` (no Chrome imports), unit-tested. A failed tag PATCH surfaces in the error line and the local chips stand — the accumulated **Save** (which still sends `tags` too) is the retry path. The m13 `★ Pin`/`★ Pinned` toggle also patches immediately (`pinned` — a state toggle like Archive, not an accumulated edit), repainting in place so unsaved edits survive; if pinning unarchived the row (§8), the card re-renders from the response so the status header follows. All popup traffic is DIRECT fetch (never the outbox — the user is present; feedback must be truthful). **Tag autocomplete (m14)**: when the editing card renders, the popup fires one `GET /api/tags` (direct fetch, non-blocking — the card never waits on it; on failure suggestions are silently absent) and the add-tag input gets the shared suggestion-dropdown behavior specified in §9. **Header link (m15)**: the "Smultronstället" header text is a button that opens the site (the configured API base URL) in a new tab via `chrome.tabs.create` — available in every popup state, paired or not (unpaired falls back to the default base URL).
-   **Action-icon tracked state (m15)**: the toolbar icon shows the **full-color strawberry** when the ACTIVE tab's page is tracked — a live (non-archived) bookmark row exists for its URL — and a **grey (desaturated) strawberry** otherwise; archived, not bookmarked, unpaired, and non-http(s) are all grey (never color on uncertainty). The icon is always full size — the states differ ONLY in color (approved 2026-08-09, replacing the golden-glow/outline design). The background watches `tabs.onActivated` + `tabs.onUpdated` + `windows.onFocusChanged` (manifest gains broad `tabs` — required to read tab URLs passively; this deliberately supersedes the original activeTab-only stance and adds Chrome's "read browsing history" install warning). Tracked-state resolves via `GET /api/bookmarks/by-url` (raw URL — Hard rule #3) through a per-URL cache (~30s TTL; pure helper in `extension/src/`, unit-tested). Optimistic overrides keep the icon truthful ahead of the TTL: `bookmarks.onCreated` marks the URL tracked; the popup pings the background via `runtime.sendMessage` after archive (untracked), restore & pin-unarchive (tracked), and CTA create (tracked) — fire-and-forget, popup behavior never blocks on the ping. The tracked state is simply the packaged color icon (a `path` setIcon). The grey state renders at runtime from the base PNGs on an `OffscreenCanvas` — full size, per-pixel luma desaturation, per-size `ImageData` cached for the worker's life — applied per-tab via `action.setIcon`; no separate icon-state asset files. A grey-render failure falls back to the packaged color icon (rare, and equivalent to the pre-m15 toolbar).
-   **Attention tracking capture (m19)**: opt-in browse-event capture per §13. Manifest adds `idle` and `webNavigation` permissions ONLY — `history` waits for the backfill that actually uses it (its install warning is an escalation over `tabs`', and an unused permission is contrary to least-privilege). Listeners (registered top-level per MV3, gated INSIDE the handler on the §13 toggle): `webNavigation.onCommitted` + `onHistoryStateUpdated` (main frame only) → `nav`; `tabs.onActivated` → `tab_activated`; `windows.onFocusChanged` → `window_focus`/`window_blur`; `idle.onStateChanged` (detection interval 60s) → `idle`. Events append to a storage-backed buffer and drain into outbox `browse` entries of ≤500 — buffer discipline (single mutex over append AND drain, enqueue-before-clear, drop-oldest caps) per §13. Outbox `browse` entries POST to `/api/browse-events` and follow the HIGHLIGHT failure semantics (poison rule: definitive 4xx except 401 drops the entry and continues — telemetry must never wedge the queue ahead of bookmark syncs; 401/5xx/network halt). The popup owns the toggle (§13).
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
-   The gate is **skippable** (since m11 web adds work without the extension): a "Skip for now" CTA sets a long-lived `smultron_skip_pairing` cookie via a server action and `/` renders the feed while unpaired. Purely a per-browser UI preference — pairing state is untouched, token generation/pairing stays available in settings, and Bearer endpoints still 401 until a real pairing. (2026-08-03.)

### API auth

-   `/api/sync`, `/api/hello`, `POST /api/browse-events` (m19), and `POST /api/highlights`: `Authorization: Bearer <token>` → sha256 → lookup in `api_tokens` → resolve `user_id`. 401 otherwise. `/api/sync`, `/api/hello`, `/api/bookmarks/by-url`, and `/api/tags` are excluded from the proxy matcher; `/api/highlights` stays matched because the same path carries the session-authed DELETE, and `/api/browse-events` stays matched because the same path carries the session-authed GET (harmless — the proxy never redirects `/api/*`).
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
-   `GET /api/bookmarks?q=&cursor=&archived=&tag=` — session auth. No `q`: feed ordered `updated_at desc`, cursor-paginated (50/page), `archived_at is null` unless `archived=1` (`archived=1` returns ONLY archived rows — it is the archived view, not an "include archived" flag). Since m13 the feed (no-`q`) branch also excludes pinned rows — they ride in the response's `pinned` shelf instead. With `q`: FTS (`websearch_to_tsquery('simple', q)`) OR trgm similarity/substring on title + url_normalized, ordered by rank then recency; search returns a single page of 50 with no cursor, and INCLUDES pinned rows (they stay findable). (Recorded from implementation, 2026-08-01.) Since m10, `q` also matches note text via FTS + ILIKE substring (NOT trgm similarity — no trgm index on note; similarity over prose is noise). All bookmark responses carry `note: string | null`, `pinnedAt: string | null` (m13) and `faviconUrl: string | null` (m17).
    -   `tag` is repeatable (`?tag=a&tag=b`), AND semantics (`tags @> ARRAY[...]`, exact string match — no trimming/case-folding); empty values are 400. Applies to feed and search alike, and composes with `cursor`. (m9, approved 2026-08-01.)
    -   Every response (cursor pages included — uniform shape) carries view aggregates: `total` (rows in the current view — user + archived state — ignoring `q`/`tag`), `matching` (what the LOG query can reach, full uncapped count: view + `q` + `tag`, and since m13 the feed branch excludes pinned rows from it exactly as it does from the log — so on the plain live feed `matching = total − pins`), and `facets: Array<{tag, count}>` (view + `q`, IGNORING the active tag filter so a selected tag keeps its count — pinned rows still count here; ordered count desc then tag asc; uncapped). Aggregate queries per request over `unnest(tags)`; no new indexes — personal scale. (m9.)
    -   **Pinned shelf (m13)**: every response also carries `pinned: Bookmark[]` — ALL of the user's pinned rows (a pinned row is always live: archiving unpins), ordered `pinned_at desc` then `id desc`, independent of `q`/`tag`/`archived`. The client renders it as the shelf above the live feed's log.
-   `POST /api/bookmarks` (m11) — session auth; body `{ url: string }` (max 2048, unknown fields rejected). Server trims and requires a parseable http(s) URL with a dotted hostname (400 `invalid_url` otherwise — the UI prepends `https://` to scheme-less input before sending), then applies §5 web-add semantics. Returns `{ bookmark, created }` (bare row, no nested highlights); `201` when created, `200` when an existing row was bumped. The response returns immediately (m18 — m17's bounded 12s wait was removed): `bookmark` carries the hostname title and null `faviconUrl`/`note` on a fresh insert, and the metadata fill (§5) always completes in `after()`. `maxDuration = 60` (for the `after()` work).
-   `PATCH /api/bookmarks/:id` — session auth; body subset of `{ title, tags, note, archived, pinned }` (`archived: true|false` sets/clears `archived_at`; `note` max 10 000 chars, trimmed server-side, empty-after-trim stores NULL; `pinned: true` sets `pinned_at = now()` — re-pinning refreshes it, moving the row to the shelf front — and `false` clears it, m13). Pinned and archived are mutually exclusive: archiving unpins, pinning unarchives, and `{archived: true, pinned: true}` in one body is a 400. Site edits — notes and pins included — NEVER bump `updated_at`; only live captures do (§5).
-   `GET /api/bookmarks/by-url?url=` + `PATCH /api/bookmarks/by-url` (m10) — token auth (same Bearer scheme as `/api/sync`); the extension popup lives in URL-space: raw URL in, normalized server-side (§4), resolved by `(user_id, url_normalized)`. GET returns `{ bookmark: bare | null }` (200 even when null; bare = no nested highlights). PATCH body `{ url, title?, tags?, note?, archived?, pinned? }` (≥1 editable field, constraints — the pinned/archived exclusion included — mirror `:id`), 404 when no bookmark; same never-bump patch semantics. Excluded from the proxy matcher; `/api/highlights` deliberately is NOT (its prefix is shared with the session-authed DELETE `/api/highlights/:id`; matched `/api/*` is never redirected, so this is harmless — see `proxy.ts`).
-   `GET /api/tags` (m14) — token auth (same Bearer scheme as `/api/sync`); no parameters. Returns `{ tags: string[] }`: the caller's distinct tags across ALL bookmark rows (archived included — a previously used tag stays autocomplete-worthy), ordered by usage count desc then tag asc, uncapped (personal scale, like facets). Excluded from the proxy matcher like `by-url`.
-   `POST /api/browse-events` (m19) — token auth (same Bearer scheme as `/api/sync`); body `{ events: BrowseEventInput[] }`, max 500 events, unknown fields rejected at every level. Per-event shape, per-kind field requirements, and the validation bounds that guarantee a malformed payload is a 400 (never a DB-level 500 the outbox would retry forever) in §13. Server normalizes `url` (§4) into `url_normalized` and inserts append-only with `ON CONFLICT (user_id, client_event_id) DO NOTHING` — at-least-once outbox delivery makes duplicate batches routine, not errors. Returns `{inserted, deduped}`. NEVER touches the bookmarks table.
-   `GET /api/browse-events` (m19) — session auth; params `q` (optional; case-insensitive substring over `url` + `title` — plain ILIKE, no FTS/trgm at this scale), `kind` (repeatable, values from the §13 kind set, unknown values 400), `cursor` (opaque base64url keyset over `(occurred_at, id)`, same style as the feed's). Returns `{ events, nextCursor, total }`: 100/page ordered `occurred_at desc, id desc`; `total` is the full uncapped count for the current filter. Event JSON: `{id, kind, occurredAt, bootId, url, urlNormalized, title, tabId, windowId, idleState, transition, documentLifecycle, createdAt}` (absent fields null).
-   `POST /api/highlights` — token auth (same as `/api/sync`); body `{ url: string; text: string }` (`text`: `min(1).max(10000)`), unknown fields rejected. Applies §5 highlight semantics (insert + bump + unarchive); `409` when no bookmark matches the normalized URL. Returns the created highlight `{id, bookmarkId, text, createdAt}`.
-   `DELETE /api/highlights/:id` — session auth; ownership-checked hard delete; `404` when not found/not owned.
-   `GET /api/bookmarks` responses include each bookmark's `highlights: Array<{id, text, createdAt}>` ordered `created_at asc` (nested — no separate fetch; approved 2026-08-01).
-   `POST /api/bookmarks/:id/article` (m12) — session auth; body `{ refresh?: boolean }` (empty body allowed, unknown fields rejected). Claims a pipeline run and returns `202 { article, started }`; `started: false` means a run was already in flight and nothing new was scheduled. `refresh: true` discards cached scrape/transcript output and forces a full re-scrape. `404` when the bookmark isn't the caller's. `maxDuration = 300`; the work runs in `after()` (§10).
-   `GET /api/bookmarks/:id/article` (m12) — session auth; returns `200 { article: {...} | null }` (null = never scraped, a normal state). The article payload carries `status`, `error`, `sourceUrl`, `title`, `transcript`, `summary`, `wordCount`, `audioKinds` (kinds already synthesized for the current voice), and timestamps. `raw_markdown` is deliberately never serialized. `404` when the bookmark isn't the caller's — the endpoint can't be used to probe which ids exist.
-   `POST /api/bookmarks/:id/article/audio` (m12) — session auth; body `{ kind: 'summary' | 'transcript' }`, unknown fields rejected. Returns `{ kind, voice, url, expiresAt, byteSize, segmentCount, cached }` with a signed URL (§10). `409 not_ready` unless the article's status is `ready`; `409 no_text` when the requested form is empty; `404 no_article` when nothing has been scraped. Synthesis failures are `503` when retryable, `502` otherwise.

## 9. UI (site)

-   **Feed (v2 "log view", m9 — from the approved Claude Design mock `Feed v2 - Log View.dc.html`)**: dense reverse-chron log rows in a full-viewport shell (header + search toolbar fixed; the log pane and facets aside scroll internally). Each row: expand caret, `updated_at` timestamp (`Aug 1 09:14`; year instead of time outside the current year), favicon (the row's own `faviconUrl` when the m17 fill resolved one, else Google s2 by hostname — and s2 again if the stored icon fails to load, nothing if both do), host, title, `✱ N` highlight-count pill, a Gmail-style muted one-line note preview after the title (m10; whitespace-collapsed, title keeps space priority, preview truncates first — replaced the earlier `▤` pill), clickable tag chips (toggle that tag filter), Archive/Restore. Clicking a row expands an inline panel (single row expanded at a time): full URL link-out, `saved <created_at> · <relative>` line, inline title editing, chip-based tag editing (m10: ✕ removes, "add tag ⏎" input appends — each mutation is one PATCH of the full tags array), a NOTE section (m10: `SET NOTES` button → textarea editor, Enter saves / Shift+Enter newline / Esc cancels, trimmed-empty deletes; saved note renders as a click-to-edit card), highlight cards. SWR polling ~10s on page 1; deeper pages via an IntersectionObserver infinite-scroll sentinel (feed only — search is a single ranked page). Instant search via `/api/bookmarks?q=` (debounced ~150ms). Stale-while-revalidate on key changes (`keepPreviousData`): toggling tags/search/view keeps the previous response rendered (facet sidebar and counts stay stable — facets are tag-independent server-side) with the stale rows dimmed until the new page lands; the infinite-scroll sentinel is parked during the stale window so the old key's cursor is never paged under new filters.
-   **Tag facets (m9)**: left sidebar lists every tag in the current view+search with counts (from the API's `facets`), a Datadog-style filter input under the heading (client-side case-insensitive substring over the facet list only — never part of the API key), multi-select AND filtering (chips in rows toggle too), `clear` resets; toolbar shows `matching of total`. Switching the live/archived view clears the tag filter and collapses the expanded row. Fixed presentation defaults: compact density, facets visible (hidden below `md` along with the host column).
-   **Theming**: dark mode follows the SYSTEM preference (`prefers-color-scheme`, no toggle) on both the web client and the extension popup; palettes from the approved Claude Design dark variants. The whole log view + popup draw color from CSS variables (`--log-*` in `globals.css`; `:root` vars in the popup HTML) — never hardcode colors in components. Accent is strawberry raspberry-pink `oklch(0.51 0.2 8)` (≈`#bb0a50`), OKLCH depth-matched to the mock's indigo (its 0.23 chroma is out of sRGB gamut for reds — 0.2 is the max); dark-mode text/border accent brightens to `oklch(0.68 0.158 8)` while solid fills keep the deep value. `#4F46E5` in the design mocks maps to this accent at implementation time.
-   **Add composer (m11 — from the approved Claude Design mock `Smultron Feed - Add Bookmark.dc.html`)**: an accent-solid `+ Add` button at the toolbar's right edge toggles an inline composer bar pinned above the log (`+` glyph, autofocused URL input in mono, Save button, `esc` closer). Enter/Save: the client prepends `https://` to scheme-less input, validates (parseable, dotted hostname — inline mono "not a valid URL" error otherwise), then renders the bookmark IMMEDIATELY, before `POST /api/bookmarks` is in flight (m18 optimistic add — this replaced m17's blocking composer AND m18's first cut, which still waited on the POST plus a full revalidation before anything rendered): the composer closes at once, the view switches to the live feed (search/tag filters are kept), and an optimistic temp row (negative client-side id; the same hostname title the server autofills per §5; enriching status chip already on) lands at the top of the log, flashing (`rowflash` keyframe fading from `--log-facet-active`). Invalid input (inline mono "not a valid URL") still keeps the composer open. The temp row does NOT auto-expand and cannot be expanded manually: the panel's editors and article section need a real, PATCHable id, and a duplicate's actual tags/note must be showing before the user may edit them (a tag save computed against the temp row's empty state would clobber a resurfaced duplicate's existing tags). The POST reconciles the row when it returns (one round trip later): the server's row replaces the temp row (flash and the enriching snapshot follow the real id), the row auto-expands, and a NEWLY created bookmark focuses the panel's add-tag input (tagging is the expected next action); a PATCH issued against a temp id (collapsed-row affordances only) awaits the pending POST's real id; a resurfaced duplicate that is PINNED instead leaves the log for the shelf (m13: pinned rows are excluded from the log) without expanding; a failed POST rolls the temp row back and reopens the composer with the draft preserved and an inline error. Overlay rows are released once a page-1 response carries their id, and dropped on ANY SWR-key change (search text, tag toggle, view switch) except the submit's own archived→live switch. A duplicate URL resurfaces the existing row (bump + unarchive, §5) with the same flash+expand. Esc or `esc` closes and clears. **Enriching state (m18)**: while the §5 fill is out, a freshly added row shows an EXPLICIT status chip in the note-preview slot — an accent spinner plus `fetching page info…` in mono (colors from the `--log-*` vars / `text-destructive`). The title and favicon render normally (the hostname title and hostname-derived fallback icon are honest content; the note preview is suppressed while the chip is up), from the moment the optimistic row renders; a resurfaced duplicate drops the chip as soon as the POST identifies it (`created: false` — its metadata already exists, no fill is coming). The client snapshots the row's `{title, faviconUrl, note}` (re-snapshotted from the POST's row at reconcile) and clears the state when a poll delivers a row where ANY of the three differs from the snapshot. If nothing has changed by a 30s deadline (comfortably past the fill's own timeout — the server keeps no fill status by design, so the deadline is the client's only failure signal), the chip switches to a destructive `✗ couldn't fetch page info` notice that retires itself after ~10s: the bookmark is saved and fine, the notice explains the hostname title rather than demanding action, and a fill that lands late still replaces it via the snapshot diff. While the chip is in its loading phase the client revalidates on a short interval (~2s, page-1 key only) so the fill lands visibly fast (the interval stops in the failed phase); the row stays fully interactive (expand, tag, archive), and a USER edit of the row's title or note ends the chip immediately — they own the field now (§5's mid-flight guard already protects the write side).
-   **Tag autocomplete (m14)**: the expanded panel's add-tag input suggests existing tags while typing. Suggestions come from the current response's `facets` list (the same tags the sidebar shows — already in memory, no new session endpoint; ordered count desc / tag asc by the server). Shared behavior spec (web + popup): dropdown appears only when the trimmed draft is non-empty and ≥1 tag matches; matching is case-insensitive with prefix matches ranked before substring matches (stable within each group, source order); tags already on the bookmark are excluded; capped at 8. Keyboard: `↓`/`↑` move the highlight (`↓` from none → first, `↑` from none → last, wrapping), Enter adds the highlighted suggestion if one is highlighted else the raw draft (existing behavior), Escape closes an open dropdown first (draft kept), typing refilters and resets the highlight. With no dropdown open, Escape keeps each surface's pre-m14 behavior: on the web it clears the draft and blurs; in the popup it falls through to Chrome's default (which closes the popup — the extension does not intercept it). Pointer selection commits on `mousedown`/`pointerdown` (before the input blurs); blur closes the dropdown. After any add: input clears, dropdown closes, focus stays in the input. ARIA combobox pattern (`role="combobox"` + `aria-expanded`/`aria-activedescendant` on the input, `role="listbox"`/`role="option"` on the list). The filter is a pure helper `filterTagSuggestions(available, applied, draft, cap=8)` implemented per package (no shared workspace package — the ~15 duplicated lines are deliberate), unit-tested in both.
-   **Highlights (expanded panel)**: each highlight card has a hard-delete button (no confirmation — low stakes) and links out to the bookmark URL with a generated `#:~:text=` fragment (built at render time from the stored text by `web/src/lib/textFragment.ts`: exact match for short selections ≲150 chars, `textStart,textEnd` word-boundary split for longer ones, percent-encoding `-`/`&`/`,` per the text-fragment spec; unit-tested). Highlight text is NOT in feed search (v1).
-   **Read-aloud section (expanded panel, m12)**: a `READ ALOUD` block below the note section, mounted only for the open row so collapsed rows never fetch. States: never scraped → `scrape & prepare audio`; running → a pulsing dot and the step in the user's terms ("fetching the page", "cleaning up the text", "writing the summary"), polled every 2s until terminal; failed → the error verbatim plus `try again` (resumes) and `start over` (re-scrapes); ready → the summary as a card, `▸ listen to summary` / `▸ listen to full article` buttons, a native `<audio controls>` (seeking for free), a collapsible transcript, the word count, and a `re-scrape` link. The active kind's button takes the accent fill. A fresh signed URL is fetched per kind on demand and dropped whenever `updatedAt` changes (a re-scrape invalidates the audio behind it). Colors come from the `--log-*` CSS variables like the rest of the log view.
-   **Pinned shelf (m13 — from the approved Claude Design mocks `Feed with Pins.dc.html` + `Extension Popup.dc.html`)**: a quick-access shelf above the live feed's log. A `PINNED` strip (label, count, `hide ▴`/`show ▾` toggle — per-load UI state) over a collapsible `auto-fill minmax(180px,1fr)` card grid on the panel background; each card = favicon + domain line with an unpin `✕`, and a 2-line-clamped title; clicking a card opens the bookmark in a new tab. Pinned rows never appear in the feed log (server-side, §8) but DO appear in search results; the shelf stays visible during search and is live-view-only (pins are never archived). Pinning happens from the expanded row panel's `★ Pin` button (next to Archive; reads `Unpin` on a pinned row surfaced by search) or the extension popup's toggle; most recently pinned first. `matching of total` in the toolbar reflects the log, so pins subtract from `matching` on the plain feed. If every live bookmark is pinned the log's empty state says so ("Everything is pinned.") instead of claiming there are no bookmarks.
-   **Browse-events log view (m19)**: `/events`, session-authed like the feed. A dense Datadog-style event log — the mid-week sanity-check tool for the collection week (§13), not a product surface. Full-viewport shell like the feed: fixed toolbar (text filter input → the API's `q`, debounced ~150ms; kind filter chips toggling the repeatable `kind` param; `matching` count from `total`), internally scrolling log pane. One row per event: `occurred_at` time (`HH:MM:SS`, date dividers between days), compact kind badge (color per kind from the `--log-*` palette), host, title (URL fallback), detail column (`transition` for nav, `idle_state` for idle), tab id. SWR polling ~10s on page 1, `keepPreviousData` so the view is NEVER blank during refetch (stale rows dim exactly like the feed); cursor infinite scroll via the same IntersectionObserver sentinel pattern. A small `events` link in the feed header navigates there. No realtime (Hard rule #6).
-   **Empty state**: at 0 bookmarks the feed's empty message points at both capture paths (`+ Add` and saving in Chrome); pairing dialog if unpaired and not skipped (§7).
-   Dark-mode friendly, keyboard-first search (`/` focuses the box). Keep it minimal — this is a personal tool.

## 10. Read-aloud pipeline (m12)

Ad-hoc, per-bookmark: scrape the page into readable Markdown, clean it into spoken prose, summarize it, and synthesize audio for either form. Triggered from the feed row's expanded panel; nothing runs automatically on capture.

```
POST /api/bookmarks/:id/article        → 202, work runs in after()
   Firecrawl v2 /scrape  → raw_markdown
   Claude clean pass     → transcript      (per-chunk, rejoined)
   Claude summary pass   → summary
GET  /api/bookmarks/:id/article        → poll status until terminal
POST /api/bookmarks/:id/article/audio  → OpenAI TTS → Supabase Storage → signed URL
```

### Why three steps and not two

Firecrawl's `onlyMainContent` markdown is *readable*, not *speakable*. It still carries link syntax, image alt text, figure captions, "Share this", newsletter interstitials, footnote markers, code fences, and tables — all of which a TTS engine reads aloud verbatim as noise. The **clean pass** rewrites the article into continuous spoken prose: link text without URLs, headings as spoken transitions, lists as flowing sentences, tables stated in a sentence, numbers and abbreviations spelled as spoken. It is explicitly **not** a summary — every substantive claim, example, and quote survives, and the output is close in length to the article's prose. The summary is then generated **from the transcript**, never from the raw markdown, so it can't quote scrape cruft.

### Status machine

`queued → scraping → cleaning → summarizing → ready` (or `failed` from any step). `ready` and `failed` are terminal. `articles.updated_at` is refreshed on every transition.

### Execution and resume

The `POST` claims the row and returns `202` immediately; the pipeline runs in Next's `after()` within the same invocation (`maxDuration = 300`). The client polls `GET` every 2s while non-terminal.

Each step is **skipped when its output is already persisted** — so a run killed mid-flight (function timeout, deploy, crash) costs only the steps that hadn't finished:

-   `raw_markdown` present → skip the scrape
-   `transcript` present → skip the scrape and the clean pass
-   `POST {refresh: true}` clears all three and forces a genuine re-scrape

A failed run therefore keeps its completed work: a rate-limited summary step leaves the transcript intact, and "try again" resumes at the summary. **Stale-run detection**: a row in a non-terminal status whose `updated_at` is older than 10 minutes is assumed dead (its invocation will never write again) and can be re-claimed. Within that window a second `POST` is a no-op that reports current state (`started: false`) rather than starting a duplicate pipeline.

### Chunking

Two hard limits, one boundary-aware splitter (`lib/chunk.ts`, unit-tested):

-   **Clean pass** — an article can exceed one request's output budget, so markdown is split at heading/blank-line boundaries into ~24 000-char chunks, each cleaned separately and rejoined. Each chunk is told its position (so it writes no mid-article opening or sign-off) and receives the tail of the previous *cleaned* chunk for a continuous seam. Beyond 12 chunks the article is truncated and the transcript says so — a silently partial article would be worse.
-   **TTS** — OpenAI's `/v1/audio/speech` caps `input` at **4096 characters**, so the transcript is segmented at sentence/paragraph boundaries and the resulting mp3s concatenated (mp3 is a stream of self-contained frames, so byte concatenation needs no re-encode). Segments are synthesized with bounded concurrency and written **by index**: order is load-bearing. Any segment failing fails the whole synthesis — partial audio that looks complete is worse than a visible error.

### Models and providers

-   **Scrape**: Firecrawl `POST /v2/scrape`, `formats: ["markdown"]`, `onlyMainContent`, `maxAge` 24h (a same-day re-scrape reuses their cache). A page whose `statusCode` is non-2xx, or that yields under 200 chars, fails rather than being transcribed.
-   **Clean + summary**: Claude `claude-opus-5` via the Anthropic SDK, adaptive thinking, `effort: medium`, **streamed** (`.stream()` + `.finalMessage()`) — the clean pass emits article-length output and a non-streaming request at that size risks an SDK HTTP timeout. `stop_reason: "refusal"` is checked before reading content.
-   **TTS**: OpenAI `gpt-4o-mini-tts`, mp3, voice from `TTS_VOICE` (default `sage`, unrecognized values fall back rather than failing). The model's free-text `instructions` set a measured narration style — the reason for choosing it over `tts-1`.

### Audio storage

Private Supabase Storage bucket (`ARTICLE_AUDIO_BUCKET`, default `article-audio`), reached over the **Storage REST API with the service-role key** — not supabase-js, so Hard rule #5 needs no exception. The bucket is created idempotently on first upload — "already exists" is the steady state, and Supabase reports it inconsistently (a duplicate create comes back as HTTP `400` wrapping `{"statusCode":"409","code":"BucketAlreadyExists"}`), so the create's *body* is inspected and any unrecognized failure is settled by a bucket-existence check before the job is failed. Playback is via signed URLs (6h TTL); the key never reaches a browser. Objects are keyed `{user_id}/{article_id}/{kind}-{voice}.mp3`, so changing the voice writes a new object rather than shadowing the old one.

Audio synthesis is **synchronous** (unlike the article pipeline): a summary is one TTS call, and a transcript's segments are synthesized concurrently. First press shows "preparing…"; every later press hits the `article_audio` cache and re-signs the stored object.

### Failure reporting

Every external step throws `PipelineError` (`lib/pipelineError.ts`) carrying a step, a machine code, and a `retryable` flag. `runArticleJob` never rejects — it writes `failed` + `"{step}: {message}"` to the row, because it runs fire-and-forget in `after()` where a rejection would be swallowed and leave the row stuck. The audio route maps retryable causes to `503` and the rest to `502`.

## 11. Google OAuth setup (one-time, manual)

1. Google Cloud Console → create OAuth 2.0 Client ID (Web application).
    - Authorized redirect URI: `https://<project-ref>.supabase.co/auth/v1/callback`.
2. Supabase Dashboard → Authentication → Providers → Google → enable; paste client ID + secret.
3. Supabase Auth URL config: Site URL `https://smultron.redpine.software`; add `http://localhost:3000` to additional redirect URLs.
4. Vercel: add the domain `smultron.redpine.software`; add a CNAME for `smultron` at the DNS host for `redpine.software`.

## 12. Milestones

1. Scaffold monorepo (pnpm workspaces, web + extension via WXT, Biome, Vitest).
2. Drizzle schema + migrations for `smultron` (tables, indexes, `pg_trgm`), RLS enabled.
3. `normalizeUrl` + upsert semantics (`live`/`backfill`) with unit tests; `/api/sync`, `/api/hello`.
4. Extension: onCreated capture, outbox + alarm retry, startup reconciliation sweep, options page.
5. Auth: Google OAuth + `ALLOWED_EMAIL` gate; pairing dialog + token lifecycle.
6. Feed UI + search + edit/archive.
7. Deploy: Vercel + domain, load extension unpacked, run initial backfill, verify end-to-end.
8. Highlights: `highlights` schema + migrations; `/api/highlights` + §5 highlight semantics + nested feed highlights; extension context-menu capture + outbox kind-routing + poison rule; feed UI (expandable list, delete, `#:~:text=` link-out).
9. Feed v2 "log view": dense reverse-chron rows, tag filter + view aggregates on `GET /api/bookmarks`, facet sidebar with counts (§8, §9).
10. Notes: `note` column + patch semantics (never bumps `updated_at`), note-aware search, `/api/bookmarks/by-url` GET+PATCH, feed note UI + chip tag editing, extension popup (§3, §5, §6, §8, §9).
11. Web add composer: `POST /api/bookmarks` + §5 web-add semantics, inline composer bar with flash+expand (§5, §8, §9).
12. Read-aloud: `articles` + `article_audio` schema + migrations; Firecrawl scrape → Claude clean pass → Claude summary, resumable and polled; OpenAI TTS into a private Supabase Storage bucket with signed URLs; expanded-panel listen UI (§3, §8, §9, §10).
13. Pinned bookmarks: `pinned_at` column + shelf index; `pinned` on both PATCH routes (never bumps `updated_at`, mutually exclusive with archiving) and the `pinned` shelf on `GET /api/bookmarks` with feed-log exclusion; feed shelf UI + popup pin toggle (§3, §5, §6, §8, §9).
14. Tag autocomplete: `GET /api/tags` (token auth, distinct tags, usage order); suggestion dropdown on the feed panel's add-tag input (fed from `facets`) and the popup's add-tag input (fed from `/api/tags`), shared `filterTagSuggestions` behavior per package (§6, §8, §9).
15. Popup & icon refinements: immediate tag-mutation saves (coalesced PATCHes via a tested pure serializer), revert of auto-bookmark-on-open (the "Bookmark this page" CTA returns; opening the popup mutates nothing), header links out to the site, action-icon tracked state — grey vs full-color strawberry (`tabs` permission, TTL cache + optimistic overrides, runtime OffscreenCanvas grey render) (§6).
16. PWA: web app manifest (installable, standalone, icon set), a no-op service worker, and an Android share target (`GET /share`) that runs the §5 web add.
17. Web-add metadata fill: `favicon_url` column; `scrapePageMetadata` (Firecrawl `summary` format → response `metadata` title/favicon + page summary, no HTML parsing) and `enrichBookmarkMetadata` (never bumps `updated_at`, never clobbers an owned title or an existing note, seeds `note` from the summary only when NULL, never throws); `POST /api/bookmarks` waits on it (bounded, finishing in `after()`), `/share` fills in the background; composer pending state + stored-favicon rendering with the s2 fallback (§3, §5, §8, §9).
18. Instant web add: `POST /api/bookmarks` returns immediately (m17's bounded wait removed — the fill always completes in `after()`); the composer closes and an optimistic temp row (status chip already on) renders before the POST is in flight, reconciled to the server's row on return (temp-id swap, rollback + reopened composer on failure); client-owned enriching status chip on the new row (spinner `fetching page info…` → timed `couldn't fetch page info` fail notice at the 30s deadline) with snapshot-diff clearing and short-interval revalidation (§5, §8, §9).
19. Attention tracking, collection infrastructure: `browse_events` schema + migrations; `POST`/`GET /api/browse-events`; extension capture (nav + tab-activation + window-focus + idle edges, storage-backed buffer draining into outbox `browse` entries) behind the popup's opt-in toggle (default OFF, off = zero capture); `/events` log view (§3, §6, §8, §9, §13). Detectors, sessionization, history backfill, and toasts are RED-92/RED-93 — explicitly not this milestone.

## 13. Attention tracking: browse-event capture (m19)

Detect distraction patterns by first collecting a week of REAL browsing data, then calibrating categorizations against it retroactively (Linear project "Attention Tracking", RED-90–94). m19 is the collection infrastructure only: dumb, lossless capture of raw attention edges. No detectors, no sessionization, no scoring, no toasts — RED-92 decides how to slice the data after the week.

### Principles

-   **Raw edges, never precomputed durations.** Dwell time = the intervals where a tab is active AND its window focused AND the user non-idle. The capture stores only the EDGES of those three signals; slicing (idle thresholds, session boundaries) happens retroactively in RED-92. Edges cannot be backfilled after the fact, which is why window-focus and idle events must be in from day one.
-   **Opt-in, and off means OFF.** Capture is gated on an explicit toggle (default disabled). Off = no events observed, buffered, or sent — zero capture, not zero notifications. The single `capture_stop` edge emitted AT disable time is the capture's own final edge, not capture-while-off; already-captured events still drain (they were captured while on).
-   **Completely separate from bookmarks.** Browse events never read or write the bookmarks table; nothing in this feature can bump `bookmarks.updated_at` (Hard rule #1) because nothing in it touches bookmarks at all.

### Event kinds

Each event carries `clientEventId` (extension-minted UUID — the idempotency key), `bootId` (the capture session it belongs to, below), and `occurredAtMs` (client clock at capture; `webNavigation` events use the event's own `timeStamp`). Kind-specific fields:

| kind | required | optional | source |
| --- | --- | --- | --- |
| `nav` | `tabId`, `url` | `windowId`, `transition`, `documentLifecycle` | `webNavigation.onCommitted` + `onHistoryStateUpdated`, main frame only — filtered on `frameType === "outermost_frame"`, falling back to `frameId === 0` only when the event carries no `frameType` (pre-Chrome-106). NOT `frameId === 0` alone: a prerendered outermost frame commits with a NONZERO frameId (the reason `frameType`/`documentLifecycle` were added), and activation fires no second `onCommitted`, so the frameId test would drop the prerendered page's only nav edge — exactly the loss the `documentLifecycle` clause below exists to prevent. `onHistoryStateUpdated` is what catches SPA navigations (YouTube, Twitter). No `title`: at commit time the tab still has the previous page's. `documentLifecycle` is recorded verbatim when the event carries it — prerendered commits (Speculation Rules; routine on Google Search) are captured WITH the flag rather than dropped, because dropping risks losing the only nav for a later-activated page; RED-92 filters or joins on it. |
| `tab_activated` | `tabId`, `windowId` | `url`, `title` | `tabs.onActivated` (`activeInfo` always carries both ids), enriched via `tabs.get` (url/title omitted if the lookup fails — the activation is still recorded). `windowId` is REQUIRED: without it a slicer can't tell whether the activation happened in the focused window, breaking multi-window dwell. |
| `window_focus` | `windowId` | `tabId`, `url`, `title` | `windows.onFocusChanged` ≠ `WINDOW_ID_NONE`; enriched with that window's active tab. |
| `window_blur` | — | — | `windows.onFocusChanged` = `WINDOW_ID_NONE` (focus left Chrome entirely). |
| `idle` | `idleState` (`active`\|`idle`\|`locked`) | — | `idle.onStateChanged`, detection interval 60s — the floor for retroactive idle thresholds. |
| `capture_start` | — | — | Capture (re)starting: browser startup with the toggle on, or the toggle flipping on. Always the first event of a `bootId`. |
| `capture_stop` | — | — | The toggle flipping OFF — emitted (same `bootId`) as the capture's own final edge before capture ceases. This is an edge OF the capture, not capture-while-off. |

`transition` is `[transitionType, ...transitionQualifiers].join("|")` (e.g. `link`, `typed|from_address_bar`, `link|forward_back`) — back-button and address-bar signals are exactly what RED-92 wants and can't be reconstructed later.

### Capture sessions and boundaries

Dwell must not be computable ACROSS a gap the capture couldn't see (browser quit leaves no shutdown edge in MV3; an 11-hour overnight gap must never read as an 11-hour dwell). Every event therefore carries a **`bootId`**: a UUID minted at capture-session start and kept in `chrome.storage.session` (survives service-worker death, resets on browser restart — exactly the lifetime we want). A new `bootId` is minted, and `capture_start` emitted, on: browser startup with the toggle enabled (storage.session came up empty), and the toggle flipping to enabled. The toggle flipping off emits `capture_stop` under the current `bootId`, then capture ceases.

**The slicing rule this buys (RED-92):** dwell intervals are only valid BETWEEN events of the same `bootId`; a `bootId` change or `capture_stop` is a hard boundary — everything after the last event of a boot is unknown time, never dwell. This also disambiguates interleaved streams if a second Chrome profile were ever paired with the same token (tab/window id spaces collide across profiles); still, the recorded constraint for the collection week is ONE paired Chrome profile.

**Baseline**: immediately after `capture_start`, the extension emits a synthetic `tab_activated` for the active tab of the last-focused window, so the slicer has an initial dwell target (skipped when no Chrome window has focus — the stream then starts in the blurred state until a `window_focus` arrives). Service-worker death/revival mid-session needs no baseline and keeps its `bootId` — state didn't change while the worker was dead, and listeners re-fire.

### Capture pipeline (extension)

Listener → toggle gate → buffer append (`chrome.storage.local`) → drain into outbox `browse` entries (≤500 events each; triggers: buffer ≥50 after an append, a 1-minute alarm, startup) → `POST /api/browse-events` with the highlight-style poison rule (§6). At-least-once delivery end to end; the server dedupes on `(user_id, client_event_id)`.

**Buffer discipline (loss-proofing):** appends AND drains serialize through the SAME in-worker promise-chain mutex (pure helper in `src/`, unit-tested) — an append interleaving into a drain's read→clear window would otherwise be silently lost. A drain enqueues the outbox entry FIRST, then removes exactly the drained events from the buffer by id: worker death between the two steps yields a duplicate batch (safe — server dedupes), never a lost one. **Backlog caps (drop-oldest, telemetry only):** the buffer caps at 2000 events and the outbox at 20 `browse` entries; beyond either, the OLDEST browse data is dropped. Sync/highlight entries are never touched by the caps — a halted flush (broken pairing, long offline stretch) must degrade telemetry, not storage-quota-wedge bookmark capture.

The opt-in toggle lives in `chrome.storage.local` under its own key (`attention`, `{enabled: boolean}`; missing = disabled — NOT in the options-page config object, which is rewritten wholesale on save). The popup renders it in every paired state (it's a global setting, not per-tab): a switch labeled for attention tracking, plus a session-grade slot that shows a placeholder ("collecting data") until RED-92/93 detectors exist. The background reacts to the key via `storage.onChanged` (`capture_start`/baseline on enable, `capture_stop` on disable); the popup itself never captures anything.

### Server semantics

`applyBrowseEvents` (web `lib/browseEvents.ts`): normalize `url` → `url_normalized` (§4, same single implementation), insert append-only, `ON CONFLICT (user_id, client_event_id) DO NOTHING`, return `{inserted, deduped}`. The FK to `auth.users` rides a hand-written migration (the `0001_trgm-fk.sql` pattern — `auth.users` is deliberately unmodeled in Drizzle). `listBrowseEvents` powers the log view (§8, §9). Rows are never updated or deleted (append-only telemetry; retention is a future decision).

**Validation bounds (Zod, strict at every level):** a malformed batch must be a deterministic 400 — never a payload that passes Zod but dies in Postgres, because that 5xx would halt-and-retry the same batch forever, wedging the outbox behind it. Bounds: `clientEventId`/`bootId` UUID format; `kind` from the enum; `occurredAtMs` integer in `[0, 253_402_300_799_999]` (the last millisecond of year 9999 — the earlier `8_640_000_000_000_000` bound, JS's max representable Date, was unsound: from year 10000 on `toISOString()` emits expanded-year form (`+010000-…`) that Postgres rejects, so a value passing Zod would 5xx at INSERT. `/api/sync`'s `dateAddedMs` carries the same latent hazard and is a separate follow-up); `tabId`/`windowId` 32-bit integers; `idleState` from its enum; `url` ≤ 8192 chars, `title` ≤ 4096, `transition` ≤ 256, `documentLifecycle` ≤ 64, and none of those four free-text fields may contain a NUL byte (`\u0000`) — Postgres `text` cannot store one, so it is the same 400-not-500 concern; per-kind required/forbidden fields enforced per the table above (required means present; fields not listed for a kind are rejected). The same `[0, year 9999]` window bounds the timestamp inside a `GET` keyset cursor, so a forged-but-JS-parseable date is a 400 rather than a 500. The extension's own unit tests keep batches well-formed; the poison rule cleans up if they ever aren't.

## 14. Out of scope (v1)

Embeddings/semantic search, realtime, multi-user onboarding, mobile capture. The schema and API shapes should not preclude these.

Page-content fetching, transcript clean-up, and summaries **were** out of scope for v1 and shipped in m12 (§10) — deliberately ad-hoc and per-bookmark, never automatic on capture.
