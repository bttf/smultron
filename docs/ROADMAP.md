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

### Proposed design

#### Data model (extends SPEC §3)

```sql
create table smultron.highlights (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references auth.users(id),
  bookmark_id  bigint not null references smultron.bookmarks(id),
  text         text not null,
  created_at   timestamptz not null default now(),
  archived_at  timestamptz             -- soft delete, consistent with hard rule 4
);
```

- Index: `btree (bookmark_id, created_at)` for fetching a bookmark's highlights in order.
- No `updated_at` / edit support in v1 — highlights are immutable snippets; only archive.

#### Extension (`extension/entrypoints/background.ts`)

- New permission: `contextMenus`.
- On install, register a context menu item with `contexts: ['selection']`.
- `chrome.contextMenus.onClicked`:
  1. Read `info.selectionText` and the active tab's `url`/`title`.
  2. Check whether the page is already bookmarked via `chrome.bookmarks.search({url})`.
  3. If not bookmarked, `chrome.bookmarks.create(...)`. This fires the existing `onCreated` listener, which enqueues the normal `{mode:'live', bookmark}` outbox event — no new sync path needed for the bookmark insert itself.
  4. Enqueue a new outbox event `{mode:'highlight', url, text}` and flush. Reuses the existing outbox/retry infrastructure (queued in `chrome.storage.local`, retried via the existing alarm).

#### API

- `POST /api/highlights` — token auth (same as `/api/sync`). Body `{ url: string; text: string }`, Zod-validated, unknown fields rejected.
  - Server normalizes `url` (reuse `normalizeUrl.ts`) and looks up `smultron.bookmarks` by `(user_id, url_normalized)`, then inserts the highlight row against that `bookmark_id`.
- Extend `GET /api/bookmarks` to include highlights per bookmark (either nested `highlights[]` or a `highlightCount` plus a dedicated `GET /api/bookmarks/:id/highlights`).
- Likely an archive endpoint for a highlight, mirroring `PATCH /api/bookmarks/:id`'s `archived` semantics.

#### UI (site)

- Show highlight count / expandable list on each feed card (SPEC §9).
- Highlights don't need their own feed/search entry point in v1 — surfaced through their parent bookmark.

### Open questions

1. **Ordering race**: the bookmark-create (step 3) and the highlight event (step 4) both flow through the async outbox independently, so the highlight POST can reach the server before the bookmark row exists. Options: (a) extension only enqueues the highlight after the bookmark's own outbox entry confirms success; (b) `/api/highlights` upserts a bookmark row itself when missing — arguably still consistent with "Chrome inserts only" since it's driven by a real Chrome-side bookmark action, just deferred; (c) server queues/retries the highlight write until the bookmark exists.
2. Cap on highlights per page, or unlimited?
3. Any length limit on `text`?
4. Should a highlight support jumping back to the passage on the page (e.g. constructing a `#:~:text=` fragment from the stored text at link-out time)? Could be pure UI, no schema change needed.
5. Delete UX on the site — hard delete vs. archive (leaning archive, for consistency with bookmarks)?
6. Confirm the context menu is scoped to `contexts: ['selection']` only, so it doesn't show up where there's nothing selected (PDFs, images, etc.).
