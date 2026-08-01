# Smultronstället — Roadmap

> Lives at `docs/ROADMAP.md`. Captures features under consideration that are **not yet** part of `docs/SPEC.md`. When a feature is scheduled for implementation, fold its finalized design into SPEC.md (data model §3, sync/API sections, milestones §11) and remove the entry here, resolving any open questions first. Linear remains the source of truth for active work status — this doc is the idea backlog, not a task tracker.

## Highlights (capture selected text via right-click)

### Summary

Add a Chrome context-menu entry ("Add highlight in Smultron") on selected text. Clicking it:

1. Ensures the current page is bookmarked (creates one if it isn't already).
2. Stores the selected text as a "highlight" snippet associated with that bookmark.
3. The highlight is persisted server-side and shown in the site UI attached to its bookmark.

### Motivation

Sometimes the interesting thing about a page is a specific passage, not just the URL. Bookmarking alone loses that context — highlights let a saved page carry the "why."

### Design

#### Data model (extends SPEC §3)

```sql
create table smultron.highlights (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references auth.users(id),
  bookmark_id  bigint not null references smultron.bookmarks(id),
  text         text not null,
  created_at   timestamptz not null default now()
);
```

- Index: `btree (bookmark_id, created_at)` for fetching a bookmark's highlights in order.
- No `updated_at` / edit support — highlights are immutable snippets. **Hard delete** (not soft), unlike bookmarks: a highlight is a low-stakes, easily-recreated capture, not deliberate curation, so hard rule 4 (soft deletes only) is scoped to `bookmarks` and does not extend to `highlights`.

#### Extension (`extension/entrypoints/background.ts`)

- New permission: `contextMenus`.
- On install, register a context menu item with `contexts: ['selection']`.
- Factor bookmark-outbox-enqueuing out of the `onCreated` listener into a shared helper, e.g. `enqueueLiveBookmark(node)`, so it can be called from more than one place.
- `chrome.contextMenus.onClicked`:
  1. Read `info.selectionText` and the active tab's `url`/`title`.
  2. Check whether the page is already bookmarked via `chrome.bookmarks.search({url})`.
  3. If not bookmarked: `await chrome.bookmarks.create(...)`, then `await enqueueLiveBookmark(node)` directly with the returned node — **don't** rely on the separate `onCreated` listener firing (and completing its own enqueue) before this handler proceeds; that relative ordering isn't part of the extension API's contract. `onCreated` will still fire independently and enqueue its own copy — harmless, since the sync upsert is idempotent (SPEC §5: re-save just bumps `updated_at`/unarchives).
  4. `await enqueueOutboxEvent({mode:'highlight', url, text})`, then flush.
- **Hardening the outbox contract** (applies beyond this feature, but this feature depends on it): flush must process the queue strictly FIFO, sequentially — await each entry's terminal resolution (2xx, or requeue on failure) before advancing to the next. *Status: the shipped outbox (`extension/src/outbox.ts`, m4) already satisfies this — sequential FIFO, stop-on-first-failure, deletion persisted per ack. Two things WILL need changes here: flush currently posts every entry to `/api/sync` (a `highlight` mode needs per-entry endpoint routing), and non-2xx currently always retries (a 409/422 poison-entry drop rule is needed per the API section below).* Given that, and given step 3/4 append order above, a highlight can never reach the server before its bookmark's insert has either succeeded or is still queued ahead of it. No server-side "wait for the bookmark to exist" logic is needed to close the race.

#### API

- `POST /api/highlights` — token auth (same as `/api/sync`). Body `{ url: string; text: string }`, Zod-validated (`text`: `min(1).max(10000)`), unknown fields rejected.
  - Server normalizes `url` (reuse `normalizeUrl.ts`) and looks up `smultron.bookmarks` by `(user_id, url_normalized)`, inserts the highlight row against that `bookmark_id`, **and clears `archived_at` on the bookmark if set** — mirrors the "re-save unarchives" semantics in SPEC §5. (Covers the case where a bookmark was archived on the site but still exists in Chrome, so step 3 above is skipped and the only signal the bookmark is "active again" is the highlight itself.)
  - If no matching bookmark row exists at all (shouldn't happen given the outbox ordering above, but guards against edge cases like a manually-cleared queue): 409/422, extension drops the event rather than retrying forever.
- `DELETE /api/highlights/:id` — session auth, hard delete.
- Extend `GET /api/bookmarks` to include highlights per bookmark (either nested `highlights[]` or a `highlightCount` plus a dedicated `GET /api/bookmarks/:id/highlights`).

#### UI (site)

- Show highlight count / expandable list on each feed card (SPEC §9), each with a delete button (hard delete, no confirmation dialog needed given the low stakes — consistent with the "recreate it if you didn't mean to" model).
- Each highlight links out to its bookmark's URL with a generated `#:~:text=` fragment built from the stored `text` at render time (no schema change) — clicking a highlight jumps back to the passage on the source page.
- Highlights don't need their own feed/search entry point in v1 — surfaced through their parent bookmark.

### Remaining open questions

1. Cap on highlights per page — leaving uncapped for v1 (single-user tool, not worth the complexity); revisit if it becomes noisy in practice.
2. Text-fragment generation (`#:~:text=`) needs the right escaping/truncation rules for long or punctuation-heavy selections — worth a small isolated helper + unit tests when this is built, similar to `normalizeUrl.ts`.
