# Extension (WXT, MV3) — working notes

Vanilla TS only — no UI framework anywhere (root AGENTS.md). Read `docs/SPEC.md` §§5, 6, 8 before touching sync behavior.

## Structure

-   Pure logic lives in `src/` (`outbox.ts`, `tree.ts`, `types.ts`) with dependencies injected (storage, fetch, node getters) — **no Chrome API imports there**. Chrome wiring happens only in `entrypoints/`. This is what makes the Vitest suite possible; keep it that way.
-   Vitest picks up `{src,utils}/**/*.test.ts`. Outbox coverage is mandatory (root AGENTS.md).

## Contracts

-   **Outbox** (`src/outbox.ts`): at-least-once, in-order FIFO. Flush is sequential, persists each deletion immediately after its 2xx. Duplicate delivery after a worker death is expected and safe (server tolerates it) — don't "fix" it. Entries route by `kind` (sync → `/api/sync`, highlight → `/api/highlights`; entries without `kind` are legacy sync entries). Failure handling per SPEC §6: sync entries halt the flush on any failure; highlight entries drop on definitive 4xx (except 401) and continue.
-   **Payload** (`src/types.ts`) mirrors SPEC §8 exactly: raw URLs, Chrome `dateAdded` ms as-is — never normalize client-side (Hard rule #3).
-   MV3: register every listener synchronously at the top level of `defineBackground` — no awaits before `addListener`, or Chrome won't re-deliver events after worker death.
-   `onChanged`/`onMoved`/`onRemoved` are intentionally not listened to (SPEC §5).

## Build

`pnpm --filter extension build` → `.output/chrome-mv3/` (load unpacked from there); `zip` for a distributable. `typecheck` runs `wxt prepare` first (generates `.wxt/tsconfig.json`).
