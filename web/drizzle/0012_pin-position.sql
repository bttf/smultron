-- m21 (SPEC §3, §8): the pinned shelf gets a hand-arranged order.
--
-- `pin_position` is the row's slot on the shelf (0 = first) and is null iff
-- the row is not pinned — the CHECK below makes that an invariant, which is
-- why the backfill has to run BETWEEN the ADD COLUMN and the ADD CONSTRAINT.
--
-- The backfill seats every existing pin in the order the shelf ALREADY shows
-- it (m13's `pinned_at desc, id desc`), per user, so nothing moves visibly on
-- deploy. It is a data migration, not a live capture: it never touches
-- `updated_at` or `pinned_at` (Hard rule #1).
--
-- The shelf index moves from `(user_id, pinned_at desc)` to
-- `(user_id, pin_position)` — NOT unique: `PUT /api/bookmarks/pinned` rewrites
-- every pinned row's slot in one statement, and a non-deferrable unique index
-- would trip on the transient duplicates a permutation passes through.
ALTER TABLE "smultron"."bookmarks" ADD COLUMN "pin_position" integer;--> statement-breakpoint
UPDATE "smultron"."bookmarks" AS b
SET "pin_position" = ranked.pos
FROM (
  SELECT id, row_number() OVER (PARTITION BY user_id ORDER BY pinned_at DESC, id DESC) - 1 AS pos
  FROM "smultron"."bookmarks"
  WHERE pinned_at IS NOT NULL
) AS ranked
WHERE b.id = ranked.id;--> statement-breakpoint
ALTER TABLE "smultron"."bookmarks" ADD CONSTRAINT "bookmarks_pin_position_check" CHECK (("smultron"."bookmarks"."pinned_at" is null) = ("smultron"."bookmarks"."pin_position" is null));--> statement-breakpoint
DROP INDEX "smultron"."bookmarks_pinned_idx";--> statement-breakpoint
CREATE INDEX "bookmarks_pinned_idx" ON "smultron"."bookmarks" USING btree ("user_id","pin_position") WHERE "smultron"."bookmarks"."pinned_at" is not null;
