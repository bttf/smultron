-- Custom DATA migration: retag existing bookmarks per the leaf-folder rule
-- (SPEC §5, approved 2026-08-02). The first tag element was previously the
-- FULL '/'-joined Chrome folder path; now it is the leafmost folder name,
-- and bookmarks sitting directly in one of Chrome's default root containers
-- carry no folder tag at all.
--
-- Heuristic (site-edited tags are left alone by construction):
--   * first tag exactly a default container name  -> drop the first tag
--   * first tag containing '/'                    -> replace with its leaf
--
-- ORDER MATTERS: the bare-container drop runs FIRST. If leaf-replacement ran
-- first, a real folder path like 'Bookmarks Bar/Other Bookmarks' would first
-- become 'Other Bookmarks' and then be wrongly dropped by the second step.
UPDATE "smultron"."bookmarks"
SET "tags" = "tags"[2:]
WHERE array_length("tags", 1) >= 1
  AND "tags"[1] IN ('Bookmarks Bar', 'Other Bookmarks', 'Mobile Bookmarks');
--> statement-breakpoint
UPDATE "smultron"."bookmarks"
SET "tags" = ARRAY[(string_to_array("tags"[1], '/'))[array_length(string_to_array("tags"[1], '/'), 1)]] || "tags"[2:]
WHERE array_length("tags", 1) >= 1
  AND position('/' in "tags"[1]) > 0;
