# Deploying Smultronstället

Manual steps that require credentials / dashboard access. Everything code-side
is done; nothing below changes code. Do them in order.

> **Status (2026-08-02):** this runbook has been executed — the app is live at
> `https://smultron.redpine.software` with Vercel auto-deploying every push to
> `main` (GitHub `bttf/smultron`). DB migrations run automatically: pushes to
> `main` that touch `web/drizzle/` trigger `.github/workflows/migrate.yml`,
> which runs `pnpm db:migrate` using the `MIGRATION_DATABASE_URL` repo secret
> (the Supavisor **session pooler** string, port 5432 — the direct
> `db.<ref>.supabase.co` host is IPv6-only and unreachable from GitHub
> runners). Note the migration job and the Vercel deploy run in parallel, so
> keep migrations backward-compatible with the previous deploy (additive
> changes; no drops/renames in the same push as the code that needs them).
> Manual fallback: `pnpm db:migrate` (reads `DIRECT_URL` from
> `web/.env.local`). The rest of this doc stays as the from-scratch runbook.

## 1. Supabase project

1. Create a Supabase project (or reuse one). Note the **project ref** (the
   `xyz` in `https://xyz.supabase.co`).
2. Run the DB migrations against it:
   - Fill `web/.env.local` → `DIRECT_URL` with the **direct** connection
     string (port `5432`, from Dashboard → Connect → Direct connection).
   - `pnpm db:migrate` (drizzle-kit reads `web/.env.local`).
   - This creates the `smultron` schema, tables, indexes, `pg_trgm`, and
     enables RLS (no policies — service role only, by design).
3. Dashboard → Settings → API: confirm the `smultron` schema is **NOT** in
   "Exposed schemas" (it isn't by default — leave it that way; PostgREST must
   not see it).

## 2. Google OAuth (SPEC §11)

1. Google Cloud Console → APIs & Services → Credentials → **Create OAuth 2.0
   Client ID** (type: Web application).
   - Authorized redirect URI: `https://<project-ref>.supabase.co/auth/v1/callback`
2. Supabase Dashboard → Authentication → Providers → **Google** → enable;
   paste the client ID + secret.
3. Supabase Dashboard → Authentication → URL Configuration:
   - Site URL: `https://smultron.redpine.software`
   - Additional redirect URLs: `http://localhost:3000/**` (local dev; using
     `/**` covers `/auth/callback`)

## 3. Environment variables

Fill `web/.env.local` (local dev) — same names go into Vercel later:

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://<project-ref>.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Dashboard → Settings → API (anon/public) |
| `SUPABASE_SERVICE_ROLE_KEY` | Dashboard → Settings → API (service_role) — server-only |
| `DATABASE_URL` | pooled connection, port **6543** (pgbouncer) |
| `DIRECT_URL` | direct connection, port **5432** (migrations only) |
| `ALLOWED_EMAIL` | optional — set: only this Google account may sign in; unset: any Google account (per-user data isolation) |
| `APP_URL` | `http://localhost:3000` locally / `https://smultron.redpine.software` in prod |

### Read-aloud pipeline (m12, SPEC §10) — optional

Leave these unset and the rest of the app works normally; the expanded row's
`scrape & prepare audio` button then fails with a "not configured" message.
All three are needed for the full scrape → transcript → audio flow.

| Variable | Value |
|---|---|
| `FIRECRAWL_API_KEY` | firecrawl.dev → Dashboard → API Keys |
| `ANTHROPIC_API_KEY` | platform.claude.com → API Keys (clean-up + summary passes) |
| `OPENAI_API_KEY` | platform.openai.com → API Keys (text-to-speech only) |
| `TTS_VOICE` | optional — OpenAI voice id, default `sage` |
| `ARTICLE_AUDIO_BUCKET` | optional — Storage bucket name, default `article-audio` |

The Storage bucket is created automatically (private) on the first successful
synthesis, using the service-role key — no manual Dashboard step. If you'd
rather pre-create it: Dashboard → Storage → New bucket, name `article-audio`,
**not** public.

**Vercel plan note:** both article routes declare `maxDuration = 300`, which
requires a paid plan. On Hobby (60s cap) long articles will be cut off
mid-run — this is safe, not corrupting: each completed step is persisted, so
pressing `try again` resumes from where it stopped (SPEC §10).

## 4. Vercel

1. Import the repo into Vercel. Framework: Next.js.
   **Root Directory: `web`** (Vercel detects the pnpm workspace and installs
   from the repo root automatically).
2. Add all the environment variables from §3 with production values
   (`APP_URL=https://smultron.redpine.software`).
3. Deploy, then Project → Settings → Domains → add
   `smultron.redpine.software`.
4. At the DNS host for `redpine.software`: add a **CNAME** record
   `smultron` → `cname.vercel-dns.com`.
5. Sanity check: visit `https://smultron.redpine.software` → redirected to
   `/login` → Google sign-in with `ALLOWED_EMAIL` works → pairing dialog
   appears. (A different Google account must land on `/not-allowed`.)

## 5. Chrome extension (unpacked) + pairing

1. Build: `pnpm --filter extension build` → output in
   `extension/.output/chrome-mv3/`.
   (For a dev build against localhost, `pnpm --filter extension dev` instead.)
2. `chrome://extensions` → enable Developer mode → **Load unpacked** → select
   `extension/.output/chrome-mv3/`.
3. On the site: sign in → pairing dialog → **Generate token** → copy.
4. Extension **options** page: paste the token; base URL
   `https://smultron.redpine.software` (or `http://localhost:3000` for dev);
   **Save** → expect "Paired ✓". The site dialog unlocks within ~3s.

## 6. Initial backfill + end-to-end verification

1. The install in step 5.2 already fired the reconciliation sweep
   (`onInstalled`) — but it ran **before pairing**, so the batches are queued
   in the outbox. They flush automatically within 5 minutes (retry alarm), or
   immediately: `chrome://extensions` → Smultronstället → "service worker" →
   restart it (toggle the extension off/on), which re-runs the sweep now that
   the token is saved.
2. Verify: the feed shows your Chrome bookmarks — foldered ones tagged with
   their leafmost folder name, top-level ones (default root containers)
   untagged; `inserted` count ≈ your bookmark count (duplicates by
   normalized URL collapse).
3. Live path: save a new bookmark in Chrome → appears in the feed within ~10s
   (SWR poll). Re-save an existing one → it jumps to the top (updated_at
   bump).
4. Site-owned edits: edit title/tags, archive/unarchive on the site; confirm
   a Chrome-side re-save un-archives but never overwrites tags; backfill
   (browser restart) never resurrects or bumps anything.

## Notes

- Regenerating the token (site → Settings) invalidates the old one AND
  un-pairs: paste the new token in the extension options and Save again.
- No realtime anywhere — the feed polls every ~10s by design.
- Soft deletes only for bookmarks: "archive" on the site; rows are never
  deleted. (Highlights are hard-delete by design.)
- Highlights: select text on any page → right-click → "Add highlight in
  Smultronstället". Verifiable the same way as §6: the page is
  auto-bookmarked if needed and the highlight appears on its feed card.
