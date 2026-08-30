// Wire schema for PUT /api/bookmarks/pinned (m21, SPEC §8). Lives here, not in
// the route file, so it can be unit-tested (the `browseEventsBodySchema`
// pattern).
import { z } from "zod";

// 1000 is a sanity bound far above any real shelf; duplicates are a client
// bug (a drag can't produce them), so they are rejected rather than silently
// collapsed — unlike ids the server merely doesn't recognize, which are a
// legitimate mid-drag race and stay lenient in `reorderPinned`.
export const pinnedOrderBodySchema = z
	.strictObject({
		ids: z.array(z.number().int().positive()).min(1).max(1000),
	})
	.refine((data) => new Set(data.ids).size === data.ids.length, {
		message: "ids must be unique",
	});

export type PinnedOrderBody = z.infer<typeof pinnedOrderBodySchema>;
