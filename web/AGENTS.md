<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices. Known renames: middleware → `src/proxy.ts`; `cookies()`, `params`, `searchParams` are async.

## Invariants (root AGENTS.md Hard rules, localized)

-   **Extension bookmark writes go through `applySync` (`src/lib/sync.ts`)** — with `applyHighlight` (`src/lib/highlights.ts`) and `addBookmark` (web add, `src/lib/bookmarks.ts`), the only code paths that may bump `updated_at`. Site edits (`patchBookmark`) never bump it.
-   **The article pipeline (`src/lib/articles.ts`, SPEC §10) never bumps `bookmarks.updated_at`** — scraping is enrichment, not a live capture. `articles.updated_at` is a separate progress clock for stale-run detection. `runArticleJob` must never reject: it runs fire-and-forget in `after()`, so it writes failures onto the row instead. External steps (`firecrawl.ts`, `transcript.ts`, `tts.ts`, `storage.ts`) throw `PipelineError` and are injected into the job so the state machine tests offline.
-   Folder tags are derived SERVER-side by `folderTags` (`src/lib/sync.ts`): leafmost folder name only; single-segment paths matching Chrome's default root containers by name get no tag. The extension always sends the full raw path — never move this derivation client-side.
-   Auth helpers: session → `getAuthedUser()`/`getAuthState()` (`src/lib/auth.ts`); extension Bearer → `authenticateApiToken` (`src/lib/apiTokenAuth.ts`); token hashing → `hashToken` in `src/lib/pairing.ts` (hex sha256, single implementation).
-   `ALLOWED_EMAIL` is optional: unset/empty = gate disabled, any Google account may sign in (per-user data isolation still applies); set = only that account.
-   DB client (`src/db/index.ts`) is a lazy `server-only` singleton; API routes that use it declare `runtime = "nodejs"`.
-   DB-touching tests: PGlite applying the real `drizzle/` migrations in journal order with `auth.users` stubbed — copy the `src/lib/sync.test.ts` harness. Never mock SQL semantics.
-   `/api/sync`, `/api/hello` + `/api/bookmarks/by-url` are Bearer-token endpoints and are excluded from the proxy matcher — keep them out of session logic. (`POST /api/highlights` is Bearer-authed too but stays matched: it shares its path prefix with the session-authed `DELETE /api/highlights/:id`, and matched `/api/*` is never redirected.)
<!-- END:nextjs-agent-rules -->
