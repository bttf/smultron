# Extension (WXT, MV3) — working notes

Vanilla TS only — no UI framework anywhere (root AGENTS.md). Read `docs/SPEC.md` §§5, 6, 8 before touching sync behavior.

## Structure

-   Pure logic lives in `src/` (`outbox.ts`, `tree.ts`, `types.ts`) with dependencies injected (storage, fetch, node getters) — **no Chrome API imports there**. Chrome wiring happens only in `entrypoints/`. This is what makes the Vitest suite possible; keep it that way.
-   Vitest picks up `{src,utils}/**/*.test.ts`. Outbox coverage is mandatory (root AGENTS.md).
-   `entrypoints/newtab/` is the new tab override (m20). WXT maps the reserved `newtab` entrypoint name to `chrome_url_overrides.newtab` — don't hand-write it into `wxt.config.ts`.

## Contracts

-   **Outbox** (`src/outbox.ts`): at-least-once, in-order FIFO. Flush is sequential, persists each deletion immediately after its 2xx. Duplicate delivery after a worker death is expected and safe (server tolerates it) — don't "fix" it. Entries route by `kind` (sync → `/api/sync`, highlight → `/api/highlights`; entries without `kind` are legacy sync entries). Failure handling per SPEC §6: sync entries halt the flush on any failure; highlight entries drop on definitive 4xx (except 401) and continue.
-   **Payload** (`src/types.ts`) mirrors SPEC §8 exactly: raw URLs, Chrome `dateAdded` ms as-is — never normalize client-side (Hard rule #3).
-   MV3: register every listener synchronously at the top level of `defineBackground` — no awaits before `addListener`, or Chrome won't re-deliver events after worker death.
-   `onChanged`/`onMoved`/`onRemoved` are intentionally not listened to (SPEC §5).
-   **Browse-event capture (m19, SPEC §13)**: listeners register top-level but gate INSIDE the handler on the `attention` storage key (missing = disabled; off = zero capture). Buffer appends AND drains serialize through ONE in-worker promise-chain mutex (pure helper in `src/`); a drain enqueues the outbox `browse` entry (≤500 events) BEFORE removing the drained events by id — duplicates are safe (server dedupes on `client_event_id`), loss is not. Drop-oldest caps (2000 buffered events, 20 `browse` entries) apply to telemetry only — never to sync/highlight entries. Every event carries the `bootId` from `chrome.storage.session` (fresh per browser boot / toggle-enable). `browse` entries route to `/api/browse-events` with the highlight-style poison rule — telemetry must never wedge the queue ahead of bookmark syncs.
-   **New tab page (m20, SPEC §6)**: one direct `GET /api/bookmarks` with the pairing token, never the outbox. Its ONLY write is the m21 shelf reorder — one direct `PUT /api/bookmarks/pinned` per drop (`src/pinOrder.ts`, fetch-injected + tested; `src/newtab.ts` stays read-only). Reordering is native HTML5 DnD (desktop Chrome only — no library); mid-drag the grid is reflowed by moving the EXISTING card nodes (rebuilding them would kill the native drag), a document-level `dragover`/`drop` guard keeps Chrome from navigating to a dropped card's URL, and a reorder's response outranks any listing fetch started before it (`shelfSeq`). Chrome gives no runtime switch for a new-tab override, so there is deliberately NO toggle; don't add one without re-reading §6. The `newtab` storage key is a RENDER CACHE (paint before the network, `offline` mark when a refresh fails) — never a sync input, and `readSnapshot` must stay total: any corrupt/legacy/missing value is simply "no cache". Search is latest-wins, and the page NEVER autofocuses its box (Chrome focuses the omnibox on a new tab; `/` focuses ours).

## Build

`pnpm --filter extension build` → `.output/chrome-mv3/` (load unpacked from there); `zip` for a distributable. `typecheck` runs `wxt prepare` first (generates `.wxt/tsconfig.json`).