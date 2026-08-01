<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices. Known renames: middleware → `src/proxy.ts`; `cookies()`, `params`, `searchParams` are async.

## Invariants (root AGENTS.md Hard rules, localized)

-   **All bookmark writes go through `applySync` (`src/lib/sync.ts`)** — the only code path that may bump `updated_at` (live mode only). Site edits (`patchBookmark`) never bump it.
-   Auth helpers: session → `getAuthedUser()`/`getAuthState()` (`src/lib/auth.ts`); extension Bearer → `authenticateApiToken` (`src/lib/apiTokenAuth.ts`); token hashing → `hashToken` in `src/lib/pairing.ts` (hex sha256, single implementation).
-   `ALLOWED_EMAIL` is optional: unset/empty = gate disabled, any Google account may sign in (per-user data isolation still applies); set = only that account.
-   DB client (`src/db/index.ts`) is a lazy `server-only` singleton; API routes that use it declare `runtime = "nodejs"`.
-   DB-touching tests: PGlite applying the real `drizzle/` migrations in journal order with `auth.users` stubbed — copy the `src/lib/sync.test.ts` harness. Never mock SQL semantics.
-   `/api/sync` + `/api/hello` are Bearer-token endpoints and are excluded from the proxy matcher — keep them out of session logic.
<!-- END:nextjs-agent-rules -->
