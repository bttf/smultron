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
  note           text,                   -- user note (m10); null = none; one note per bookmark
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

Live captures — this path, web adds (below), and highlight inserts (below) — are the ONLY paths that bump `updated_at`.

### `web add` (site composer, via `POST /api/bookmarks`, m11)

A deliberate user save in the site's Add composer is a live capture. Session-authed upsert on `(user_id, url_normalized)` from a raw URL:

-   **Insert** if new: `created_at = updated_at = now()`, `title` autofilled server-side from the hostname (`www.` stripped), no tags, no `chrome_id`.
-   **On conflict**: `updated_at = now()`, `archived_at = null` — bump + unarchive ONLY. Title/tags/url/chrome_id/created_at stay untouched: unlike a Chrome live re-save, there is no fresher title or raw spelling to trust over what the site already owns.

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
-   **Popup (m10)**: browser-action popup (`entrypoints/popup/`, vanilla TS; manifest adds `activeTab` — not broad `tabs`). Looks up the active tab via `GET /api/bookmarks/by-url` and shows: unpaired → open-settings prompt; non-http(s) tab → "Nothing to bookmark here."; not bookmarked → auto-bookmarks on open (approved 2026-08-02): `chrome.bookmarks.search({url})` first, `chrome.bookmarks.create` only on a miss (default folder — the `onCreated` live-capture path syncs + bumps; the search guard keeps popup reopens from minting duplicate Chrome rows while sync lags), then polls by-url (~800ms, 12s cap) until the row lands and swaps to the editing card; a "Bookmark this page" retry CTA appears only if create or the poll fails; bookmarked/archived → editing card (title, tag chips, note textarea, `saved <relative>` line). Edits accumulate locally; **Save** sends ONE `PATCH /api/bookmarks/by-url {url, title, tags, note}` with "Saved ✓" feedback only on 2xx; Archive/Restore patches `archived`. All popup traffic is DIRECT fetch (never the outbox — the user is present; feedback must be truthful).
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
-   `GET /api/bookmarks?q=&cursor=&archived=&tag=` — session auth. No `q`: feed ordered `updated_at desc`, cursor-paginated (50/page), `archived_at is null` unless `archived=1` (`archived=1` returns ONLY archived rows — it is the archived view, not an "include archived" flag). With `q`: FTS (`websearch_to_tsquery('simple', q)`) OR trgm similarity/substring on title + url_normalized, ordered by rank then recency; search returns a single page of 50 with no cursor. (Recorded from implementation, 2026-08-01.) Since m10, `q` also matches note text via FTS + ILIKE substring (NOT trgm similarity — no trgm index on note; similarity over prose is noise). All bookmark responses carry `note: string | null`.
    -   `tag` is repeatable (`?tag=a&tag=b`), AND semantics (`tags @> ARRAY[...]`, exact string match — no trimming/case-folding); empty values are 400. Applies to feed and search alike, and composes with `cursor`. (m9, approved 2026-08-01.)
    -   Every response (cursor pages included — uniform shape) carries view aggregates: `total` (rows in the current view — user + archived state — ignoring `q`/`tag`), `matching` (view + `q` + `tag`, full uncapped count; equals `total` when neither filter is set), and `facets: Array<{tag, count}>` (view + `q`, IGNORING the active tag filter so a selected tag keeps its count; ordered count desc then tag asc; uncapped). Three aggregate queries per request over `unnest(tags)`; no new indexes — personal scale. (m9.)
-   `POST /api/bookmarks` (m11) — session auth; body `{ url: string }` (max 2048, unknown fields rejected). Server trims and requires a parseable http(s) URL with a dotted hostname (400 `invalid_url` otherwise — the UI prepends `https://` to scheme-less input before sending), then applies §5 web-add semantics. Returns `{ bookmark, created }` (bare row, no nested highlights); `201` when created, `200` when an existing row was bumped.
-   `PATCH /api/bookmarks/:id` — session auth; body subset of `{ title, tags, note, archived }` (`archived: true|false` sets/clears `archived_at`; `note` max 10 000 chars, trimmed server-side, empty-after-trim stores NULL). Site edits — notes included, m10 decision — NEVER bump `updated_at`; only live captures do (§5).
-   `GET /api/bookmarks/by-url?url=` + `PATCH /api/bookmarks/by-url` (m10) — token auth (same Bearer scheme as `/api/sync`); the extension popup lives in URL-space: raw URL in, normalized server-side (§4), resolved by `(user_id, url_normalized)`. GET returns `{ bookmark: bare | null }` (200 even when null; bare = no nested highlights). PATCH body `{ url, title?, tags?, note?, archived? }` (≥1 editable field, constraints mirror `:id`), 404 when no bookmark; same never-bump patch semantics. Excluded from the proxy matcher; `/api/highlights` deliberately is NOT (its prefix is shared with the session-authed DELETE `/api/highlights/:id`; matched `/api/*` is never redirected, so this is harmless — see `proxy.ts`).
-   `POST /api/highlights` — token auth (same as `/api/sync`); body `{ url: string; text: string }` (`text`: `min(1).max(10000)`), unknown fields rejected. Applies §5 highlight semantics (insert + bump + unarchive); `409` when no bookmark matches the normalized URL. Returns the created highlight `{id, bookmarkId, text, createdAt}`.
-   `DELETE /api/highlights/:id` — session auth; ownership-checked hard delete; `404` when not found/not owned.
-   `GET /api/bookmarks` responses include each bookmark's `highlights: Array<{id, text, createdAt}>` ordered `created_at asc` (nested — no separate fetch; approved 2026-08-01).
-   `POST /api/bookmarks/:id/article` (m12) — session auth; body `{ refresh?: boolean }` (empty body allowed, unknown fields rejected). Claims a pipeline run and returns `202 { article, started }`; `started: false` means a run was already in flight and nothing new was scheduled. `refresh: true` discards cached scrape/transcript output and forces a full re-scrape. `404` when the bookmark isn't the caller's. `maxDuration = 300`; the work runs in `after()` (§10).
-   `GET /api/bookmarks/:id/article` (m12) — session auth; returns `200 { article: {...} | null }` (null = never scraped, a normal state). The article payload carries `status`, `error`, `sourceUrl`, `title`, `transcript`, `summary`, `wordCount`, `audioKinds` (kinds already synthesized for the current voice), and timestamps. `raw_markdown` is deliberately never serialized. `404` when the bookmark isn't the caller's — the endpoint can't be used to probe which ids exist.
-   `POST /api/bookmarks/:id/article/audio` (m12) — session auth; body `{ kind: 'summary' | 'transcript' }`, unknown fields rejected. Returns `{ kind, voice, url, expiresAt, byteSize, segmentCount, cached }` with a signed URL (§10). `409 not_ready` unless the article's status is `ready`; `409 no_text` when the requested form is empty; `404 no_article` when nothing has been scraped. Synthesis failures are `503` when retryable, `502` otherwise.

## 9. UI (site)

-   **Feed (v2 "log view", m9 — from the approved Claude Design mock `Feed v2 - Log View.dc.html`)**: dense reverse-chron log rows in a full-viewport shell (header + search toolbar fixed; the log pane and facets aside scroll internally). Each row: expand caret, `updated_at` timestamp (`Aug 1 09:14`; year instead of time outside the current year), favicon (Google s2), host, title, `✱ N` highlight-count pill, a Gmail-style muted one-line note preview after the title (m10; whitespace-collapsed, title keeps space priority, preview truncates first — replaced the earlier `▤` pill), clickable tag chips (toggle that tag filter), Archive/Restore. Clicking a row expands an inline panel (single row expanded at a time): full URL link-out, `saved <created_at> · <relative>` line, inline title editing, chip-based tag editing (m10: ✕ removes, "add tag ⏎" input appends — each mutation is one PATCH of the full tags array), a NOTE section (m10: `SET NOTES` button → textarea editor, Enter saves / Shift+Enter newline / Esc cancels, trimmed-empty deletes; saved note renders as a click-to-edit card), highlight cards. SWR polling ~10s on page 1; deeper pages via an IntersectionObserver infinite-scroll sentinel (feed only — search is a single ranked page). Instant search via `/api/bookmarks?q=` (debounced ~150ms). Stale-while-revalidate on key changes (`keepPreviousData`): toggling tags/search/view keeps the previous response rendered (facet sidebar and counts stay stable — facets are tag-independent server-side) with the stale rows dimmed until the new page lands; the infinite-scroll sentinel is parked during the stale window so the old key's cursor is never paged under new filters.
-   **Tag facets (m9)**: left sidebar lists every tag in the current view+search with counts (from the API's `facets`), a Datadog-style filter input under the heading (client-side case-insensitive substring over the facet list only — never part of the API key), multi-select AND filtering (chips in rows toggle too), `clear` resets; toolbar shows `matching of total`. Switching the live/archived view clears the tag filter and collapses the expanded row. Fixed presentation defaults: compact density, facets visible (hidden below `md` along with the host column).
-   **Theming**: dark mode follows the SYSTEM preference (`prefers-color-scheme`, no toggle) on both the web client and the extension popup; palettes from the approved Claude Design dark variants. The whole log view + popup draw color from CSS variables (`--log-*` in `globals.css`; `:root` vars in the popup HTML) — never hardcode colors in components. Accent is strawberry raspberry-pink `oklch(0.51 0.2 8)` (≈`#bb0a50`), OKLCH depth-matched to the mock's indigo (its 0.23 chroma is out of sRGB gamut for reds — 0.2 is the max); dark-mode text/border accent brightens to `oklch(0.68 0.158 8)` while solid fills keep the deep value. `#4F46E5` in the design mocks maps to this accent at implementation time.
-   **Add composer (m11 — from the approved Claude Design mock `Smultron Feed - Add Bookmark.dc.html`)**: an accent-solid `+ Add` button at the toolbar's right edge toggles an inline composer bar pinned above the log (`+` glyph, autofocused URL input in mono, Save button, `esc` closer). Enter/Save: the client prepends `https://` to scheme-less input, validates (parseable, dotted hostname — inline mono "not a valid URL" error otherwise), then `POST /api/bookmarks`. On success the composer closes, the view switches to the live feed (search/tag filters are kept), the row flashes (`rowflash` keyframe fading from `--log-facet-active`) and auto-expands; a NEWLY created bookmark also focuses the panel's add-tag input (tagging is the expected next action). A duplicate URL resurfaces the existing row instead (bump + unarchive, §5) with the same flash+expand. Esc or `esc` closes and clears; errors keep the composer open.
-   **Highlights (expanded panel)**: each highlight card has a hard-delete button (no confirmation — low stakes) and links out to the bookmark URL with a generated `#:~:text=` fragment (built at render time from the stored text by `web/src/lib/textFragment.ts`: exact match for short selections ≲150 chars, `textStart,textEnd` word-boundary split for longer ones, percent-encoding `-`/`&`/`,` per the text-fragment spec; unit-tested). Highlight text is NOT in feed search (v1).
-   **Read-aloud section (expanded panel, m12)**: a `READ ALOUD` block below the note section, mounted only for the open row so collapsed rows never fetch. States: never scraped → `scrape & prepare audio`; running → a pulsing dot and the step in the user's terms ("fetching the page", "cleaning up the text", "writing the summary"), polled every 2s until terminal; failed → the error verbatim plus `try again` (resumes) and `start over` (re-scrapes); ready → the summary as a card, `▸ listen to summary` / `▸ listen to full article` buttons, a native `<audio controls>` (seeking for free), a collapsible transcript, the word count, and a `re-scrape` link. The active kind's button takes the accent fill. A fresh signed URL is fetched per kind on demand and dropped whenever `updatedAt` changes (a re-scrape invalidates the audio behind it). Colors come from the `--log-*` CSS variables like the rest of the log view.
-   **Empty state**: "Install the extension" with pairing instructions if paired but 0 bookmarks; pairing dialog if unpaired (§7).
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

Private Supabase Storage bucket (`ARTICLE_AUDIO_BUCKET`, default `article-audio`), reached over the **Storage REST API with the service-role key** — not supabase-js, so Hard rule #5 needs no exception. The bucket is created idempotently on first upload. Playback is via signed URLs (6h TTL); the key never reaches a browser. Objects are keyed `{user_id}/{article_id}/{kind}-{voice}.mp3`, so changing the voice writes a new object rather than shadowing the old one.

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

## 13. Out of scope (v1)

Embeddings/semantic search, realtime, multi-user onboarding, mobile capture. The schema and API shapes should not preclude these.

Page-content fetching, transcript clean-up, and summaries **were** out of scope for v1 and shipped in m12 (§10) — deliberately ad-hoc and per-bookmark, never automatic on capture.
