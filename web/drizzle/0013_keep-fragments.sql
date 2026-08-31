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
--     the edges are stripped in the TS order — JS `trim()` first, then the
--     parser's C0-control-or-space strip (see the `cleaned` CTE);
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
		-- Two-stage edge strip, in the TS order: `normalizeUrl` first runs
		-- JS `trim()` (whose whitespace reaches past ASCII: NBSP, U+1680,
		-- the U+2000 block, LS/PS, U+202F/U+205F, ideographic space, BOM),
		-- THEN the WHATWG parser strips leading/trailing C0 controls or
		-- spaces. The stages must stay NESTED, not merged into one set: in
		-- `...#b<NBSP><C0>` the trim cannot reach the NBSP (a C0 ends the
		-- string) and the parser strip stops AT it — that NBSP survives
		-- into the fragment as %C2%A0, which a single union-set btrim
		-- would wrongly eat. tab/CR/LF go first and globally (the parser
		-- removes them anywhere in the URL).
		SELECT btrim(
			btrim(
				translate(raw, E'\t\n\r', ''),
				E' \t\n\r\f\x0B'
					|| E'\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A'
					|| E'\u2028\u2029\u202F\u205F\u3000\uFEFF'
			),
			E' \x01\x02\x03\x04\x05\x06\x07\x08\x09\x0A\x0B\x0C\x0D\x0E\x0F'
				|| E'\x10\x11\x12\x13\x14\x15\x16\x17\x18\x19\x1A\x1B\x1C\x1D\x1E\x1F'
		) AS s
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
