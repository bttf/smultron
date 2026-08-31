-- Custom DATA migration: recompute `url_normalized` under the m22 fragment
-- rule (SPEC §4, approved 2026-08-30). Rule 3 used to strip the whole
-- fragment; it now KEEPS it, minus any `:~:` text-fragment directive, with a
-- fragment left empty by that (or a bare trailing `#`) dropped entirely.
--
-- WHAT IT DOES. For every row whose stored `url_normalized` was produced by
-- the OLD rule, the new key is exactly the old key with the raw URL's kept
-- fragment appended — rules 1, 2, 4 and 5 (scheme/host canonicalization,
-- tracking-param removal, trailing-slash strip) are unchanged, so nothing
-- before the `#` moves. That is why this can be a pure append instead of a
-- re-parse: `smultron.m22_kept_fragment(url)` reproduces, in SQL, exactly the
-- fragment the WHATWG parser would hand `normalizeUrl`:
--   * tab/CR/LF are removed anywhere (the parser strips them pre-parse) and
--     surrounding whitespace is trimmed (`normalizeUrl` trims first);
--   * everything from the FIRST `#` to the end is the fragment;
--   * everything from the first `:~:` inside it is cut;
--   * what survives is re-encoded in the parser's canonical fragment
--     encoding — every character outside `!`..`~` (space and C0 controls
--     included), plus `"`, `<`, `>` and a backtick, becomes uppercase UTF-8
--     percent-escapes. `%` itself is NOT touched: the parser leaves existing
--     percent-sequences and a stray `%` alone;
--   * an empty result appends nothing.
-- Both `smultron.bookmarks` and `smultron.browse_events` (SPEC §13: the ONE
-- sanctioned update ever applied to that append-only table — a DERIVED column
-- only, never the captured payload) are recomputed.
--
-- WHY THE `#` GUARD. `normalizeUrl` falls back to the trimmed original when
-- `new URL()` throws, so a parse-failure row stores its raw URL verbatim —
-- fragment included. Appending to that would double the fragment. A `#` in
-- `url_normalized` can ONLY come from that fallback (on the success path the
-- old rule emitted scheme/host/path/query, none of which can contain a literal
-- `#`), so `position('#' in url_normalized) = 0` is an exact test for "this
-- key was computed, not fallen back to". It also makes the migration
-- re-runnable: a second pass skips every row it already rewrote.
--
-- WHY COLLISIONS ARE IMPOSSIBLE. `bookmarks` has a UNIQUE (user_id,
-- url_normalized). Every new key is its old key plus a suffix, so two rewritten
-- rows can only end up equal if their OLD keys were already equal — which the
-- unique index already forbade. Skipped (fallback) rows cannot collide with a
-- rewritten one either: a skipped row's key is a string `new URL()` REJECTED,
-- and every rewritten row's key is one it accepted. The index therefore never
-- trips, and nothing needs merging.
--
-- This is a data migration, not a live capture: it writes `url_normalized` and
-- nothing else — never `updated_at` (Hard rule #1).
--
-- The AUTHORITY for correctness is `src/lib/keepFragments.test.ts`, which runs
-- this file on PGlite over a corpus of old-style rows and asserts, per row,
-- that the resulting `url_normalized` is byte-identical to what the TypeScript
-- `normalizeUrl` returns. The helper below is dropped at the end of the
-- migration — it exists only to keep the two UPDATEs from drifting apart.
CREATE FUNCTION "smultron"."m22_kept_fragment"(raw text) RETURNS text
LANGUAGE sql STABLE AS $fn$
	WITH cleaned AS (
		SELECT btrim(translate(raw, E'\t\n\r', ''), E' \t\n\r\f\x0B') AS s
	),
	fragment AS (
		SELECT CASE
			WHEN position('#' in s) = 0 THEN NULL
			ELSE substring(s from position('#' in s) + 1)
		END AS f
		FROM cleaned
	),
	cut AS (
		SELECT CASE
			WHEN f IS NULL THEN NULL
			WHEN position(':~:' in f) = 0 THEN f
			ELSE substring(f from 1 for position(':~:' in f) - 1)
		END AS f
		FROM fragment
	)
	SELECT CASE
		WHEN cut.f IS NULL OR cut.f = '' THEN ''
		ELSE '#' || (
			SELECT string_agg(
				CASE
					WHEN ascii(ch) BETWEEN 33 AND 126
					     AND ch NOT IN ('"', '<', '>', '`')
					THEN ch
					ELSE upper(regexp_replace(encode(convert_to(ch, 'UTF8'), 'hex'), '(..)', '%\1', 'g'))
				END,
				'' ORDER BY ord
			)
			FROM regexp_split_to_table(cut.f, '') WITH ORDINALITY AS t(ch, ord)
		)
	END
	FROM cut;
$fn$;
--> statement-breakpoint
UPDATE "smultron"."bookmarks" AS b
SET "url_normalized" = b."url_normalized" || "smultron"."m22_kept_fragment"(b."url")
WHERE position('#' in b."url_normalized") = 0
  AND "smultron"."m22_kept_fragment"(b."url") <> '';
--> statement-breakpoint
UPDATE "smultron"."browse_events" AS e
SET "url_normalized" = e."url_normalized" || "smultron"."m22_kept_fragment"(e."url")
WHERE e."url" IS NOT NULL
  AND e."url_normalized" IS NOT NULL
  AND position('#' in e."url_normalized") = 0
  AND "smultron"."m22_kept_fragment"(e."url") <> '';
--> statement-breakpoint
DROP FUNCTION "smultron"."m22_kept_fragment"(text);
