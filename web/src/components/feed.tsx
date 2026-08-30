"use client";
// Feed v2 "log view" + search UI — SPEC §9, m9 (+ m10 notes & chip tag
// editing). Talks ONLY to /api/bookmarks* (Hard rule #2 — never the DB
// directly). SWR polls page 1 every 10s; deeper keyset pages append via an
// infinite-scroll sentinel. Row edits (title/tags/note/archive, highlight
// delete) PATCH/DELETE then reconcile local state — see the comments inside
// `Feed` for the reconciliation model.
import {
	type Announcements,
	closestCenter,
	DndContext,
	type DragEndEvent,
	KeyboardSensor,
	MouseSensor,
	type ScreenReaderInstructions,
	TouchSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	rectSortingStrategy,
	SortableContext,
	sortableKeyboardCoordinates,
	useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { moveItem, orderShelf } from "../lib/shelfOrder";
import { cn } from "../lib/utils";
import { type ApiBookmark, Favicon, hostOf, LogRow } from "./log-row";

// m9 contract: facets/total/matching are computed on page 1 of the current
// key. Kept optional so the UI degrades to 0 / [] against the pre-m9 API
// during integration instead of crashing.
type ListResponse = {
	bookmarks: ApiBookmark[];
	nextCursor: string | null;
	total?: number;
	matching?: number;
	facets?: Array<{ tag: string; count: number }>;
	// m13 pinned shelf: every pinned row. Since m21 the array is in the user's
	// hand-arranged order (`pin_position asc`, SPEC §8) — the order IS the
	// contract; `pin_position` itself is not serialized.
	// Optional for the same integration-window reason as the aggregates.
	pinned?: ApiBookmark[];
};

class FetchError extends Error {}

async function fetcher(url: string): Promise<ListResponse> {
	const res = await fetch(url);
	if (!res.ok) {
		throw new FetchError(`request failed (${res.status})`);
	}
	return res.json() as Promise<ListResponse>;
}

function buildUrl(
	q: string,
	archived: boolean,
	tags: string[],
	cursor?: string | null,
) {
	const params = new URLSearchParams();
	const trimmed = q.trim();
	if (trimmed) {
		params.set("q", trimmed);
	}
	if (archived) {
		params.set("archived", "1");
	}
	// Repeatable `tag` params — the filter is AND server-side.
	for (const tag of tags) {
		params.append("tag", tag);
	}
	if (cursor) {
		params.set("cursor", cursor);
	}
	const qs = params.toString();
	return `/api/bookmarks${qs ? `?${qs}` : ""}`;
}

const DEBOUNCE_MS = 150;

// m18 enriching state (SPEC §9): the fields whose change means the §5 fill
// landed. Compared against every later render of the row; `faviconUrl`/`note`
// are normalized to null so an absent key can't read as a change. `phase`
// drives the row's status chip: "loading" (spinner + fetching page info…)
// until the deadline, then "failed" (explicit fail notice) until its own
// timed clear.
type EnrichSnapshot = {
	id: number;
	title: string;
	faviconUrl: string | null;
	note: string | null;
	phase: "loading" | "failed";
};

// Hard ceiling on the loading phase (SPEC §9). A fill that fails leaves the
// hostname title forever — nothing would ever differ from the snapshot — so
// the affordance must give up on its own, comfortably past the fill's own
// timeout. The server keeps no fill status (deliberate, SPEC §5/§8), so this
// deadline is the only failure signal the client has.
const ENRICH_DEADLINE_MS = 30_000;
// How long the "couldn't fetch page info" notice stays on the row before the
// state clears entirely. The bookmark itself is fine — the notice is
// informative, not a call to action, so it must not squat in the log forever.
const ENRICH_FAIL_NOTICE_MS = 10_000;

export function Feed() {
	const [rawQuery, setRawQuery] = useState("");
	const [query, setQuery] = useState("");
	const [archived, setArchived] = useState(false);
	const [activeTags, setActiveTags] = useState<string[]>([]);
	// Sidebar tag filter (Datadog-style): client-side substring narrowing of
	// the facet LIST only — it never touches the SWR key or the log itself.
	const [facetFilter, setFacetFilter] = useState("");
	// Single expanded row at a time (mock semantics); null = all collapsed.
	const [expanded, setExpanded] = useState<number | null>(null);
	// m13 pinned shelf (mock `Feed with Pins`): collapsible card grid above
	// the log. Open/closed is per-load UI state, like the mock.
	const [pinsOpen, setPinsOpen] = useState(true);
	// m11 add composer (mock `Smultron Feed - Add Bookmark`): the toolbar's
	// "+ Add" toggles an inline URL bar pinned above the log.
	const [composerOpen, setComposerOpen] = useState(false);
	const [urlDraft, setUrlDraft] = useState("");
	const [addError, setAddError] = useState<string | null>(null);
	// m18 (SPEC §9): an add renders before the §5 metadata fill has run, so a
	// NEWLY added row carries an explicit status chip while the fill is out.
	// This snapshot starts from the optimistic temp row at submit and is
	// re-snapshotted from the POST's row at reconcile — the state clears when
	// a later response differs from it (the fill landed), when the user edits
	// the row's title/note, when the POST reports a duplicate, or (after the
	// deadline flips it to "failed") on the fail notice's own timer.
	const [enriching, setEnriching] = useState<EnrichSnapshot | null>(null);
	const enrichingId = enriching?.id ?? null;
	const enrichPhase = enriching?.phase ?? null;
	// Row to flash after an add (new or resurfaced duplicate)…
	const [flashId, setFlashId] = useState<number | null>(null);
	// …and, for a NEWLY created bookmark only, the row whose expanded panel
	// should focus its add-tag input (mock: `focusLater(tagRef)`). Set at
	// reconcile (never to a temp id): the panel needs the real row.
	const [justAddedId, setJustAddedId] = useState<number | null>(null);
	// m18 optimistic add (SPEC §9): rows rendered the moment Enter is pressed,
	// before the POST is in flight. A row carries a negative temp id until the
	// POST reconciles it to the server's row; it leaves the overlay when a
	// page-1 response carries its id (release effect below), on entering the
	// archived view, or on rollback after a failed POST.
	const [added, setAdded] = useState<ApiBookmark[]>([]);
	const tempIdRef = useRef(-1);
	// In-flight adds by temp id — a patch against a temp row awaits the real id.
	const pendingAddsRef = useRef(new Map<number, Promise<number | null>>());
	// Set when submitAdd itself changes the SWR key (archived → live): the
	// key-change reset must not clear the overlay row it was just handed.
	const keepAddedRef = useRef(false);
	const searchInputRef = useRef<HTMLInputElement>(null);
	const logRef = useRef<HTMLDivElement>(null);
	const sentinelRef = useRef<HTMLDivElement>(null);

	// Debounce the search box ~150ms before it feeds the SWR key.
	useEffect(() => {
		const id = setTimeout(() => setQuery(rawQuery), DEBOUNCE_MS);
		return () => clearTimeout(id);
	}, [rawQuery]);

	// `/` focuses search unless an input/textarea (or contenteditable) already
	// has focus.
	useEffect(() => {
		function onKeyDown(e: KeyboardEvent) {
			if (e.key !== "/") {
				return;
			}
			const active = document.activeElement as HTMLElement | null;
			const tag = active?.tagName;
			if (tag === "INPUT" || tag === "TEXTAREA" || active?.isContentEditable) {
				return;
			}
			e.preventDefault();
			searchInputRef.current?.focus();
		}
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);

	// Tags sort into the key so toggle order can't fork identical filters into
	// distinct SWR cache entries. Tags MUST be in the key — filtering happens
	// server-side.
	const sortedTags = useMemo(() => [...activeTags].sort(), [activeTags]);
	const key = buildUrl(query, archived, sortedTags);
	// keepPreviousData: a key change (tag toggle, search, view switch) keeps
	// the previous response rendered while the new page loads, instead of
	// blanking to `data === undefined`. Facets ignore the tag filter
	// server-side, so across tag toggles the sidebar content is IDENTICAL —
	// this is what keeps the tag list persistent while the log refetches.
	// `isLoading` stays true during such a fetch (SWR semantics: no data for
	// the CURRENT key yet) — used below to dim stale rows and park the
	// infinite-scroll sentinel; background polls don't set it.
	const { data, error, isLoading, mutate } = useSWR<ListResponse, Error>(
		key,
		fetcher,
		{ refreshInterval: 10_000, keepPreviousData: true },
	);

	// Deeper pages, loaded via the infinite-scroll sentinel. Only page 1 (the
	// SWR key above) polls every 10s; appended pages are a point-in-time
	// snapshot and don't auto-refresh — documented simplification (SPEC §9
	// asks for a minimal personal tool, not full pagination consistency).
	const [morePages, setMorePages] = useState<ApiBookmark[][]>([]);
	const [cursor, setCursor] = useState<string | null>(null);
	const [loadingMore, setLoadingMore] = useState(false);
	const loadingMoreRef = useRef(false);

	// Local overlays for row edits: `overrides` patches a row's fields after a
	// successful PATCH; `removed` drops a row that just left the current view
	// (archived here, or restored while looking at the archive).
	const [overrides, setOverrides] = useState<Map<number, Partial<ApiBookmark>>>(
		new Map(),
	);
	const [removed, setRemoved] = useState<Set<number>>(new Set());
	// Shelf overlays: a just-pinned row (PATCH response) shows in the shelf
	// immediately, a just-unpinned/archived one leaves it immediately. Unlike
	// overrides/removed they are RELEASED once the server confirms them (the
	// reconcile effect below) — a confirmed overlay left in place would mask
	// later pin state changes made from the extension popup.
	const [pinnedExtra, setPinnedExtra] = useState<ApiBookmark[]>([]);
	const [unpinned, setUnpinned] = useState<Set<number>>(new Set());
	// m21 shelf reordering (SPEC §9): the order a drop painted, laid over the
	// server's shelf by `orderShelf` until a response confirms it. Same
	// released-on-confirmation contract as the overlays above — and, like
	// them, NOT reset on an SWR key change: the shelf is query-independent, so
	// typing in the search box must not drop a reorder still in flight.
	const [orderOverride, setOrderOverride] = useState<number[] | null>(null);
	const [reorderError, setReorderError] = useState<string | null>(null);
	// Monotonic drop counter. A slow FIRST PUT must never paint its response
	// over a newer drop's override, so a stale response is dropped whole: no
	// `mutate`, no override release, no error.
	const reorderSeqRef = useRef(0);

	// Reset all paging/local-edit state whenever the query, tag filter, or the
	// feed/archive view changes (the SWR key, `key`, captures all of them).
	// This follows React's "adjusting state when a prop changes during render"
	// pattern rather than an effect, so the reset is visible in the very render
	// that changed `key` — no stale flash of the previous view's paging state.
	const prevKey = useRef(key);
	if (prevKey.current !== key) {
		prevKey.current = key;
		setMorePages([]);
		setCursor(null);
		setOverrides(new Map());
		setRemoved(new Set());
		setPinnedExtra([]);
		setUnpinned(new Set());
		if (keepAddedRef.current) {
			// This key change is submitAdd's own archived→live switch — the
			// optimistic row belongs to the view we're entering.
			keepAddedRef.current = false;
		} else {
			setAdded([]);
		}
	}

	// Only sync `cursor` from the polled page 1 while no deeper page has been
	// loaded yet — once the sentinel has advanced past page 1, a background
	// page-1 refresh must not clobber the further-along cursor.
	useEffect(() => {
		if (morePages.length === 0) {
			setCursor(data?.nextCursor ?? null);
		}
	}, [data, morePages.length]);

	// Release shelf overlays the server has confirmed. An overlay's job is
	// only to cover the window between a PATCH 2xx and the next revalidation;
	// holding it longer masks pin changes made from the OTHER surface (the
	// extension popup): a kept `pinnedExtra` snapshot would resurrect as a
	// stale card after a popup unpin, and a kept `unpinned` id would hide a
	// popup re-pin from the shelf (while the server hides it from the log) —
	// the row would vanish from the UI entirely. A response that still shows
	// the pre-PATCH state (a poll that raced the PATCH) confirms nothing and
	// leaves the overlays in place, so the optimistic UI never flickers back.
	useEffect(() => {
		const base = data?.pinned;
		if (!base) {
			return;
		}
		const baseIds = new Set(base.map((b) => b.id));
		// Confirmed pins: the server's shelf now carries the row itself. Scoped
		// to pinnedExtra members so the released `removed` ids are exactly the
		// PIN-time removals — an archive-time removal of an already-pinned row
		// must NOT be released just because stale data still lists the row as
		// pinned (that would flash the archived row back into the log).
		const confirmed = new Set(
			pinnedExtra.filter((p) => baseIds.has(p.id)).map((p) => p.id),
		);
		if (confirmed.size > 0) {
			setPinnedExtra((prev) => prev.filter((p) => !confirmed.has(p.id)));
			setRemoved((prev) => {
				if (![...prev].some((id) => confirmed.has(id))) {
					return prev;
				}
				return new Set([...prev].filter((id) => !confirmed.has(id)));
			});
		}
		// Confirmed unpins: the row has left the server's shelf.
		setUnpinned((prev) => {
			if (![...prev].some((id) => !baseIds.has(id))) {
				return prev;
			}
			return new Set([...prev].filter((id) => baseIds.has(id)));
		});
	}, [data, pinnedExtra]);

	// m21 (SPEC §9): release the drag order override once a response's own
	// `pinned` order already IS the order the override paints. Same reason as
	// the pin/unpin overlays above: a confirmed override held longer would
	// mask a reorder made on the other surface (the extension's new tab
	// shelf). A response that still shows the pre-drop order confirms nothing
	// and leaves the override standing, so the cards never flick back.
	useEffect(() => {
		const base = data?.pinned;
		if (!base || orderOverride === null) {
			return;
		}
		if (orderShelf(base, orderOverride).confirmed) {
			setOrderOverride(null);
		}
	}, [data, orderOverride]);

	const items = useMemo(() => {
		const base = [...(data?.bookmarks ?? []), ...morePages.flat()];
		return base
			.filter((b) => !removed.has(b.id))
			.map((b) => {
				const patch = overrides.get(b.id);
				return patch ? { ...b, ...patch } : b;
			});
	}, [data, morePages, overrides, removed]);

	// Release optimistic adds the server has confirmed into page 1 — same
	// contract as the shelf overlays above: once the polled page carries the
	// row, the overlay copy must go, or a later key change could resurrect a
	// stale version at the top of an unrelated view.
	useEffect(() => {
		const base = data?.bookmarks;
		if (!base) {
			return;
		}
		const ids = new Set(base.map((b) => b.id));
		setAdded((prev) =>
			prev.some((a) => ids.has(a.id))
				? prev.filter((a) => !ids.has(a.id))
				: prev,
		);
	}, [data]);

	// What the log actually renders: optimistic adds above the polled page.
	// An overlay row takes `overrides` patches like any other row and respects
	// `removed` (archiving a just-added row). The dataIds filter closes the
	// paint-before-effect gap of the release above; the id filter on `items`
	// covers the resurfaced-duplicate window, where the row's old copy may
	// still sit mid-list in stale data while the overlay shows it on top.
	const rows = useMemo(() => {
		if (added.length === 0) {
			return items;
		}
		const dataIds = new Set((data?.bookmarks ?? []).map((b) => b.id));
		const overlay = added
			.filter((a) => !dataIds.has(a.id) && !removed.has(a.id))
			.map((a) => {
				const patch = overrides.get(a.id);
				return patch ? { ...a, ...patch } : a;
			});
		const overlayIds = new Set(overlay.map((a) => a.id));
		return [...overlay, ...items.filter((b) => !overlayIds.has(b.id))];
	}, [added, data, items, overrides, removed]);

	// m18 clear #1 (SPEC §9): the fill has landed once ANY of the three
	// snapshotted fields differs on the row we now hold — whether it arrived on
	// a poll or in a PATCH response (`overrides`). A tag edit alone leaves all
	// three equal, so it can't end the chip early. Scans `rows` (not `items`)
	// so an overlay row is compared against what's actually rendered. Also
	// live in the "failed" phase: a fill landing late replaces the fail notice
	// with the metadata it announced was missing.
	useEffect(() => {
		if (!enriching) {
			return;
		}
		const row = rows.find((b) => b.id === enriching.id);
		if (!row) {
			return;
		}
		if (
			row.title !== enriching.title ||
			(row.faviconUrl ?? null) !== enriching.faviconUrl ||
			(row.note ?? null) !== enriching.note
		) {
			setEnriching(null);
		}
	}, [rows, enriching]);

	// m18 clear #2, stage one: the deadline flips a still-loading chip to the
	// explicit fail notice (SPEC §9). Re-armed per enriching row; cleared on
	// unmount and whenever the state clears some other way.
	useEffect(() => {
		if (enrichingId === null) {
			return;
		}
		const timer = setTimeout(
			() =>
				setEnriching((prev) =>
					prev?.id === enrichingId && prev.phase === "loading"
						? { ...prev, phase: "failed" }
						: prev,
				),
			ENRICH_DEADLINE_MS,
		);
		return () => clearTimeout(timer);
	}, [enrichingId]);

	// …stage two: the fail notice retires itself. The bookmark is saved and
	// usable — the notice only explains why the title is still a hostname.
	useEffect(() => {
		if (enrichPhase !== "failed" || enrichingId === null) {
			return;
		}
		const timer = setTimeout(
			() => setEnriching((prev) => (prev?.id === enrichingId ? null : prev)),
			ENRICH_FAIL_NOTICE_MS,
		);
		return () => clearTimeout(timer);
	}, [enrichPhase, enrichingId]);

	// m18 (SPEC §9): while the fill is still expected, revalidate page 1 on a
	// short interval so it shows up in seconds rather than on the next 10s
	// poll. Runs alongside `refreshInterval` — an occasional duplicate fetch
	// is harmless; a leaked interval is not, hence the scoped effect. Stops in
	// the "failed" phase: past the deadline the 10s poll is plenty for the
	// rare late fill.
	useEffect(() => {
		if (enrichingId === null || enrichPhase !== "loading") {
			return;
		}
		const timer = setInterval(() => {
			mutate();
		}, 2000);
		return () => clearInterval(timer);
	}, [enrichingId, enrichPhase, mutate]);

	async function loadMore() {
		// Ref (not state) guards double-fires: the observer can call again
		// before the setLoadingMore re-render lands.
		if (!cursor || loadingMoreRef.current) {
			return;
		}
		loadingMoreRef.current = true;
		setLoadingMore(true);
		const keyAtStart = key;
		try {
			const page = await fetcher(buildUrl(query, archived, sortedTags, cursor));
			if (prevKey.current !== keyAtStart) {
				// Key changed mid-flight (new search/filter/view) — the page
				// belongs to the old view; drop it rather than splice it in.
				return;
			}
			setMorePages((pages) => [...pages, page.bookmarks]);
			setCursor(page.nextCursor);
		} catch {
			// Transient failure — the sentinel refires on the next intersection
			// change, so this retries naturally on scroll.
		} finally {
			loadingMoreRef.current = false;
			setLoadingMore(false);
		}
	}
	// Latest-closure ref so the observer effect below doesn't have to depend on
	// every value `loadMore` captures.
	const loadMoreRef = useRef(loadMore);
	loadMoreRef.current = loadMore;

	const noQuery = query.trim().length === 0;

	// Infinite scroll: observe the sentinel row inside the log's own scroll
	// container. Recreated per `cursor` so a sentinel still visible after a
	// page lands chains straight into the next fetch (observe() fires an
	// initial callback with the current intersection state). Search results
	// (q present) are a single page with no cursor — no sentinel.
	useEffect(() => {
		// `isLoading` gate: while stale previous-key data is showing
		// (keepPreviousData), `cursor` still belongs to the OLD key — don't
		// let the sentinel page with it under the new filters. The sentinel
		// row isn't rendered then either; the dep re-arms the observer once
		// the new page lands and the sentinel mounts.
		if (!noQuery || cursor === null || isLoading) {
			return;
		}
		const el = sentinelRef.current;
		if (!el) {
			return;
		}
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((e) => e.isIntersecting)) {
					loadMoreRef.current();
				}
			},
			{ root: logRef.current, rootMargin: "200px" },
		);
		observer.observe(el);
		return () => observer.disconnect();
	}, [noQuery, cursor, isLoading]);

	async function patchRow(
		id: number,
		patch: {
			title?: string;
			tags?: string[];
			note?: string;
			archived?: boolean;
			pinned?: boolean;
		},
	) {
		// A patch against a still-optimistic row (negative temp id) waits for
		// its POST to deliver the real id — by then every id-keyed state has
		// been swapped, so the rest proceeds against the real row. A null
		// resolution means the add failed and was rolled back.
		if (id < 0) {
			const pending = pendingAddsRef.current.get(id);
			const realId = pending ? await pending : null;
			if (realId === null) {
				throw new Error("save failed");
			}
			return patchRow(realId, patch);
		}
		const res = await fetch(`/api/bookmarks/${id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(patch),
		});
		if (!res.ok) {
			throw new Error(`request failed (${res.status})`);
		}
		const updated = (await res.json()) as ApiBookmark;

		// m18 clear #3 (SPEC §9): the user just wrote the row's title or note,
		// so the field is theirs — drop the chip over it regardless of what
		// the fill does next (§5's mid-flight guard protects the write side).
		// Deliberately not other patches: tagging/pinning an enriching row is
		// expected and must leave the affordance alone.
		if (patch.title !== undefined || patch.note !== undefined) {
			setEnriching((prev) => (prev?.id === id ? null : prev));
		}

		if (patch.archived !== undefined) {
			// Archiving/restoring always moves the row out of whichever view
			// it's currently shown in — and its panel must not stay open.
			setRemoved((prev) => new Set(prev).add(id));
			setExpanded((prev) => (prev === id ? null : prev));
			if (patch.archived) {
				// The server unpins on archive — drop the row from the shelf too.
				setUnpinned((prev) => new Set(prev).add(id));
				setPinnedExtra((prev) => prev.filter((b) => b.id !== id));
			}
		} else if (patch.pinned !== undefined) {
			if (patch.pinned) {
				// Into the shelf, at the END (m21: `pin_position = max + 1`,
				// SPEC §8 — once the order is hand-arranged a new pin must not
				// shove every card over). The row also leaves the current list
				// when that list can no longer hold it: the feed log (the
				// server excludes pinned rows) and the archived view (pinning
				// unarchives, search or not). In a live search it stays listed
				// — pinned rows remain findable — so it just takes the
				// override.
				setPinnedExtra((prev) => [...prev.filter((b) => b.id !== id), updated]);
				setUnpinned((prev) => {
					const next = new Set(prev);
					next.delete(id);
					return next;
				});
				if (noQuery || archived) {
					setRemoved((prev) => new Set(prev).add(id));
					setExpanded((prev) => (prev === id ? null : prev));
				} else {
					setOverrides((prev) => new Map(prev).set(id, updated));
				}
			} else {
				// Out of the shelf immediately; the revalidated page puts the
				// row back into the feed log (clear any pin-time removal so
				// the overlay doesn't keep filtering it out).
				setUnpinned((prev) => new Set(prev).add(id));
				setPinnedExtra((prev) => prev.filter((b) => b.id !== id));
				setRemoved((prev) => {
					const next = new Set(prev);
					next.delete(id);
					return next;
				});
				setOverrides((prev) => new Map(prev).set(id, updated));
			}
		} else {
			setOverrides((prev) => new Map(prev).set(id, updated));
		}
		// Background revalidate page 1; the 10s poll would eventually do this
		// anyway, but this makes the edit visible immediately on refresh.
		mutate();
	}

	async function deleteHighlight(bookmarkId: number, highlightId: number) {
		const res = await fetch(`/api/highlights/${highlightId}`, {
			method: "DELETE",
		});
		if (!res.ok) {
			throw new Error(`request failed (${res.status})`);
		}

		// Local override: prune the deleted highlight from this bookmark's
		// nested list, merging onto any existing override (e.g. a pending
		// title/tags edit) rather than replacing it outright.
		setOverrides((prev) => {
			const current = items.find((b) => b.id === bookmarkId);
			const nextHighlights = (current?.highlights ?? []).filter(
				(h) => h.id !== highlightId,
			);
			const next = new Map(prev);
			next.set(bookmarkId, {
				...prev.get(bookmarkId),
				highlights: nextHighlights,
			});
			return next;
		});
		// Background revalidate page 1, same as patchRow above.
		mutate();
	}

	function toggleTag(tag: string) {
		setActiveTags((prev) =>
			prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
		);
	}

	function toggleArchived() {
		// Mock semantics: switching views clears the tag filter and collapses
		// the expanded row. Active tags that vanished from facets would
		// otherwise silently keep filtering the other view.
		setArchived((a) => !a);
		setActiveTags([]);
		setExpanded(null);
	}

	function toggleComposer() {
		// Both opening and closing reset the draft + error (mock semantics).
		setUrlDraft("");
		setAddError(null);
		setComposerOpen((open) => !open);
	}

	function closeComposer() {
		setUrlDraft("");
		setAddError(null);
		setComposerOpen(false);
	}

	// The POST behind an optimistic add failed: pull the temp row back out and
	// reopen the composer so the URL isn't lost and retry is one Enter away.
	// (The draft only refills an EMPTY composer — if the user is already
	// typing another URL there, their draft wins over the failed one.)
	function rollbackAdd(tempId: number, draft: string, message: string) {
		// (No expanded/justAdded cleanup: neither ever targets a temp id —
		// expansion and tag focus only happen at reconcile, with the real id.)
		setAdded((prev) => prev.filter((a) => a.id !== tempId));
		setFlashId((prev) => (prev === tempId ? null : prev));
		setEnriching((prev) => (prev?.id === tempId ? null : prev));
		setComposerOpen(true);
		setUrlDraft((prev) => (prev.trim() === "" ? draft : prev));
		setAddError(message);
	}

	function submitAdd() {
		let raw = urlDraft.trim();
		if (!raw) {
			return;
		}
		// Mock behavior: scheme-less input gets https:// prepended, then must
		// parse with a dotted hostname. The server re-validates identically.
		if (!/^https?:\/\//i.test(raw)) {
			raw = `https://${raw}`;
		}
		let parsedUrl: URL | null = null;
		try {
			parsedUrl = new URL(raw);
		} catch {
			parsedUrl = null;
		}
		if (!parsedUrl?.hostname.includes(".")) {
			setAddError("not a valid URL");
			return;
		}

		// m18 optimistic add (SPEC §9): the row renders NOW — a temp row with a
		// negative id, the same hostname title the server autofills (§5), and
		// the enriching status chip already on, at the top of the live view (search
		// and tag filters are kept), flashed. Nothing the user sees waits on
		// the network. Expansion + tag-input focus wait for the reconcile
		// below: the panel's editors and article section need a PATCHable id,
		// and a duplicate's real tags/note must be showing before the user can
		// edit them (a tag save computed against the temp row's empty arrays
		// would clobber the existing ones).
		const tempId = tempIdRef.current--;
		const nowIso = new Date().toISOString();
		const tempRow: ApiBookmark = {
			id: tempId,
			url: raw,
			urlNormalized: raw,
			title: parsedUrl.hostname.replace(/^www\./, ""),
			faviconUrl: null,
			tags: [],
			note: null,
			createdAt: nowIso,
			updatedAt: nowIso,
			archivedAt: null,
			pinnedAt: null,
			highlights: [],
		};
		closeComposer();
		if (archived) {
			// Leaving the archived view changes the SWR key — keep the overlay
			// row through that reset.
			keepAddedRef.current = true;
		}
		setArchived(false);
		setAdded((prev) => [tempRow, ...prev]);
		setEnriching({
			id: tempId,
			title: tempRow.title,
			faviconUrl: null,
			note: null,
			phase: "loading",
		});
		setFlashId(tempId);
		setTimeout(
			() => setFlashId((prev) => (prev === tempId ? null : prev)),
			2000,
		);

		// The POST reconciles the temp row when it lands. Registered in
		// pendingAddsRef so a patch fired at the temp row can await the real id.
		const send = (async (): Promise<number | null> => {
			try {
				const res = await fetch("/api/bookmarks", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ url: raw }),
				});
				if (!res.ok) {
					rollbackAdd(tempId, raw, `save failed (${res.status})`);
					return null;
				}
				const { bookmark, created } = (await res.json()) as {
					bookmark: Omit<ApiBookmark, "highlights">;
					created: boolean;
				};
				const id = bookmark.id;
				// A resurfaced duplicate that is PINNED lives in the shelf, not
				// the log (m13) — drop the overlay row and let the revalidation
				// refresh the shelf. Otherwise the server's row replaces the
				// temp row. The `a.id !== id` filter drops a stale overlay copy
				// of the SAME real row (re-adding a URL whose earlier reconcile
				// hasn't been released yet) — without it the log would render
				// two rows with one React key. (`highlights` is the one field
				// POST doesn't return; a duplicate's highlights arrive with the
				// revalidated page.)
				const pinned = bookmark.pinnedAt !== null;
				setAdded((prev) => {
					const rest = prev.filter((a) => a.id !== id);
					return pinned
						? rest.filter((a) => a.id !== tempId)
						: rest.map((a) =>
								a.id === tempId ? { ...bookmark, highlights: [] } : a,
							);
				});
				// Mock semantics (SPEC §9): the reconciled row auto-expands, and
				// a NEWLY created bookmark focuses the panel's add-tag input
				// (tagging is the expected next action). Deliberately not done
				// at submit — see the comment above the temp row.
				if (!pinned) {
					setExpanded(id);
				}
				setJustAddedId(created && !pinned ? id : null);
				setFlashId((prev) => (prev === tempId ? (pinned ? null : id) : prev));
				setTimeout(
					() => setFlashId((prev) => (prev === id ? null : prev)),
					2000,
				);
				// m18 (SPEC §9): only a fresh insert is waiting on a fill — a
				// resurfaced duplicate already carries whatever metadata it has,
				// so its chip ends here. Re-snapshot from the server's row
				// (identical to the temp row today, but the snapshot must match
				// what the row now shows).
				setEnriching((prev) =>
					prev?.id !== tempId
						? prev
						: created
							? {
									id,
									title: bookmark.title,
									faviconUrl: bookmark.faviconUrl ?? null,
									note: bookmark.note ?? null,
									phase: "loading",
								}
							: null,
				);
				// If we were in the archived view, the key change refetched
				// anyway and this bound mutate hits the old key — harmless.
				mutate();
				return id;
			} catch {
				rollbackAdd(tempId, raw, "save failed");
				return null;
			}
		})();
		// Entries are kept for the session (never deleted): a patch can race in
		// AFTER the promise settles but BEFORE the id-swap render commits, and
		// it must still resolve the real id instead of concluding the add died.
		// A handful of settled promises per session is free.
		pendingAddsRef.current.set(tempId, send);
	}

	const facets = data?.facets ?? [];
	const total = data?.total ?? 0;
	const matching = data?.matching ?? 0;

	// m14 tag autocomplete source: the current response's facet tags, already
	// ordered count desc / tag asc by the server. No extra fetch, no new SWR key.
	const tagSuggestions = useMemo(
		() => (data?.facets ?? []).map((f) => f.tag),
		[data],
	);

	// Shelf = server's pinned list + rows pinned since the last revalidation
	// (AFTER the server's rows — m21: a new pin joins the END of the shelf,
	// SPEC §8), minus rows unpinned/archived since. Once the revalidated page
	// lands the overlays dedupe into no-ops. `orderShelf` then lays a pending
	// drag order (m21) over the result; with no override it is the identity.
	const shelf = useMemo(() => {
		const base = data?.pinned ?? [];
		const extra = pinnedExtra.filter((p) => !base.some((b) => b.id === p.id));
		const composed = [...base, ...extra].filter((b) => !unpinned.has(b.id));
		return orderShelf(composed, orderOverride).items;
	}, [data, pinnedExtra, unpinned, orderOverride]);

	// m21 drop handler (SPEC §9): paint the new order at once through the
	// override, then send ONE `PUT /api/bookmarks/pinned` with the full id
	// list. The response's shelf goes straight into the SWR cache so the next
	// poll can't flash the old order back; a failure clears the override (the
	// cards snap back to the server's order) and shows the error line.
	async function reorderShelf(activeId: number, overId: number) {
		const from = shelf.findIndex((b) => b.id === activeId);
		const to = shelf.findIndex((b) => b.id === overId);
		if (from === -1 || to === -1) {
			return;
		}
		const next = moveItem(shelf, from, to);
		if (next === shelf) {
			return;
		}
		const ids = next.map((b) => b.id);
		setOrderOverride(ids);
		setReorderError(null);
		const seq = reorderSeqRef.current + 1;
		reorderSeqRef.current = seq;
		try {
			const res = await fetch("/api/bookmarks/pinned", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ ids }),
			});
			if (!res.ok) {
				throw new Error(`request failed (${res.status})`);
			}
			const { pinned } = (await res.json()) as { pinned: ApiBookmark[] };
			if (reorderSeqRef.current !== seq) {
				// A newer drop is already on screen and in flight — this
				// response is history. Don't paint it, don't release the newer
				// override, don't report anything.
				return;
			}
			// `revalidate: false`: the PUT's own response IS the confirmed
			// shelf (SPEC §8), so there is nothing to go and re-ask for. The
			// release effect above then drops the override on this `data`.
			mutate((current) => (current ? { ...current, pinned } : current), {
				revalidate: false,
			});
		} catch {
			if (reorderSeqRef.current !== seq) {
				return;
			}
			setOrderOverride(null);
			setReorderError("couldn't save order");
		}
	}

	const facetFilterTrimmed = facetFilter.trim().toLowerCase();
	const visibleFacets = facetFilterTrimmed
		? facets.filter((f) => f.tag.toLowerCase().includes(facetFilterTrimmed))
		: facets;

	return (
		<div className="flex min-h-0 flex-1 flex-col ">
			<div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2">
				<input
					ref={searchInputRef}
					type="search"
					value={rawQuery}
					onChange={(e) => setRawQuery(e.target.value)}
					placeholder="Search bookmarks…  ( / )"
					className="min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 py-[5px] font-mono text-[12.5px] outline-none focus:border-[var(--log-accent)]"
				/>
				<span className="whitespace-nowrap font-mono text-[11px] text-muted-foreground">
					{matching} of {total}
				</span>
				<button
					type="button"
					onClick={toggleArchived}
					className={cn(
						"shrink-0 rounded-md border border-border bg-background px-2.5 py-[5px] text-xs",
						archived &&
							"border-[var(--log-strong-border)] bg-[var(--log-soft)]",
					)}
				>
					{archived ? "Viewing archived" : "Archived"}
				</button>
				<button
					type="button"
					onClick={toggleComposer}
					className="flex shrink-0 items-center gap-[5px] rounded-md bg-[var(--log-accent-solid)] px-[11px] py-[5px] text-xs font-medium text-white hover:bg-[var(--log-accent-solid-hover)]"
				>
					<span aria-hidden className="font-mono text-xs leading-none">
						+
					</span>{" "}
					Add
				</button>
			</div>

			<div className="flex min-h-0 flex-1">
				<aside className="hidden w-[200px] shrink-0 overflow-y-auto border-r border-border px-2 py-3 md:block">
					<div className="flex items-center justify-between px-2 pb-1.5">
						<span className="font-mono text-[10px] tracking-[0.08em] text-muted-foreground">
							TAGS
						</span>
						{activeTags.length > 0 ? (
							<button
								type="button"
								onClick={() => setActiveTags([])}
								className="font-mono text-[10px] text-[var(--log-accent)]"
							>
								clear
							</button>
						) : null}
					</div>
					<div className="px-1 pb-1.5">
						<input
							type="search"
							value={facetFilter}
							onChange={(e) => setFacetFilter(e.target.value)}
							placeholder="filter…"
							className="w-full min-w-0 rounded-[5px] border border-border bg-background px-2 py-1 font-mono text-[11px] outline-none placeholder:text-muted-foreground focus:border-[var(--log-accent)]"
						/>
					</div>
					{facets.length > 0 && visibleFacets.length === 0 ? (
						<p className="px-2 py-1 font-mono text-[10.5px] text-muted-foreground">
							no matching tags
						</p>
					) : null}
					<div className="flex flex-col gap-px">
						{visibleFacets.map((f) => {
							const active = activeTags.includes(f.tag);
							return (
								<button
									key={f.tag}
									type="button"
									onClick={() => toggleTag(f.tag)}
									className={cn(
										"flex w-full items-center justify-between gap-2 rounded-[5px] px-2 py-1 text-left text-xs hover:bg-[var(--log-soft)]",
										active
											? "bg-[var(--log-facet-active)] font-semibold text-[var(--log-accent)]"
											: "text-[var(--log-fg)]",
									)}
								>
									<span className="truncate">{f.tag}</span>
									<span className="shrink-0 font-mono text-[10.5px] text-[var(--log-faint)]">
										{f.count}
									</span>
								</button>
							);
						})}
					</div>
				</aside>

				<div ref={logRef} className="min-w-0 flex-1 overflow-y-auto">
					{composerOpen ? (
						<div className="flex items-center gap-2.5 border-b border-[var(--log-rule)] bg-[var(--log-panel)] px-4 py-[7px]">
							<span
								aria-hidden
								className="w-2.5 shrink-0 font-mono text-xs text-[var(--log-accent)]"
							>
								+
							</span>
							<input
								// biome-ignore lint/a11y/noAutofocus: user just opened the composer to type a URL — focus is expected.
								autoFocus
								type="text"
								value={urlDraft}
								onChange={(e) => {
									setUrlDraft(e.target.value);
									setAddError(null);
								}}
								onKeyDown={(e) => {
									if (e.key === "Enter") {
										e.preventDefault();
										submitAdd();
									} else if (e.key === "Escape") {
										e.preventDefault();
										closeComposer();
									}
								}}
								placeholder="Paste a URL and press ⏎"
								spellCheck={false}
								className="min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 py-[5px] font-mono text-[12.5px] outline-none focus:border-[var(--log-accent)]"
							/>
							{/* m18: no pending state — submit closes the composer and
							    renders the row optimistically; a failed POST reopens it
							    with the draft. Invalid input keeps it open. */}
							{addError ? (
								<span className="shrink-0 font-mono text-[11px] text-destructive">
									{addError}
								</span>
							) : null}
							<button
								type="button"
								onClick={submitAdd}
								className="shrink-0 rounded-md bg-[var(--log-accent-solid)] px-3 py-[5px] text-[11.5px] font-medium text-white hover:bg-[var(--log-accent-solid-hover)]"
							>
								Save
							</button>
							<button
								type="button"
								onClick={closeComposer}
								className="shrink-0 px-1 py-0.5 text-[11px] text-[var(--log-faint)] hover:text-foreground"
							>
								esc
							</button>
						</div>
					) : null}

					{/* m13 pinned shelf — live view only (pinned rows are never
					    archived); stays visible during search, per the mock. */}
					{!archived && shelf.length > 0 ? (
						<PinnedShelf
							items={shelf}
							open={pinsOpen}
							onToggleOpen={() => setPinsOpen((open) => !open)}
							onUnpin={(id) => patchRow(id, { pinned: false })}
							onReorder={reorderShelf}
							error={reorderError}
						/>
					) : null}

					{error ? (
						<p className="px-4 py-3 font-mono text-xs text-destructive">
							Couldn&apos;t load bookmarks: {error.message}
						</p>
					) : null}

					{!data && isLoading ? (
						<p className="px-4 py-6 font-mono text-xs text-muted-foreground">
							Loading…
						</p>
					) : rows.length === 0 ? (
						<EmptyState
							archived={archived}
							noQuery={noQuery}
							hasPins={!archived && shelf.length > 0}
						/>
					) : (
						// Stale rows (previous key, kept by keepPreviousData) dim
						// while the new page is in flight.
						<div
							className={cn("transition-opacity", isLoading && "opacity-60")}
						>
							{rows.map((b) => (
								<LogRow
									key={b.id}
									bookmark={b}
									archivedView={archived}
									expanded={expanded === b.id}
									flash={flashId === b.id}
									enriching={
										enrichingId === b.id && enrichPhase !== null
											? enrichPhase
											: false
									}
									autoFocusTags={justAddedId === b.id}
									activeTags={activeTags}
									tagSuggestions={tagSuggestions}
									onToggleExpand={() => {
										// A still-optimistic row (temp id) can't
										// open: the panel's editors and article
										// section need a real, PATCHable id. The
										// reconcile expands it moments later.
										if (b.id < 0) {
											return;
										}
										// A manual toggle ends the just-added
										// affordance — re-expanding later must
										// not steal focus into the tag input.
										setJustAddedId(null);
										setExpanded((prev) => (prev === b.id ? null : b.id));
									}}
									onToggleTag={toggleTag}
									onPatch={patchRow}
									onDeleteHighlight={deleteHighlight}
								/>
							))}
						</div>
					)}

					{noQuery && cursor !== null && !isLoading ? (
						<div
							ref={sentinelRef}
							className="px-4 py-2 font-mono text-[11px] text-muted-foreground"
						>
							{loadingMore ? "loading…" : " "}
						</div>
					) : null}
				</div>
			</div>
		</div>
	);
}

function EmptyState({
	archived,
	noQuery,
	hasPins,
}: {
	archived: boolean;
	noQuery: boolean;
	/** m13: an empty LOG with a populated shelf isn't "no bookmarks". */
	hasPins: boolean;
}) {
	const message = !noQuery
		? "No matches."
		: archived
			? "No archived bookmarks yet."
			: hasPins
				? "Everything is pinned."
				: "No bookmarks yet — hit + Add above, or save one in Chrome (the extension backfills when it starts).";
	return (
		<p className="max-w-md px-4 py-6 font-mono text-xs text-muted-foreground">
			{message}
		</p>
	);
}

// m21 (SPEC §9): the keyboard path is the ⋮⋮ grip, so the instructions have
// to name it — dnd-kit's default text says "press the space bar" with no hint
// of what to focus first.
const SHELF_SR_INSTRUCTIONS: ScreenReaderInstructions = {
	draggable:
		"To reorder a pinned bookmark, focus its reorder grip and press space or enter. " +
		"While dragging, use the arrow keys to move the card one slot at a time. " +
		"Press space or enter again to drop it in its new position, or press escape to cancel.",
};

/**
 * m21: `prefers-reduced-motion`. Read once per shelf (not per card) and passed
 * down, so a shelf of 30 pins keeps ONE media-query listener. Starts `false`
 * and settles in an effect — SSR has no `matchMedia`, and the initial paint
 * carries no transform to animate anyway.
 */
function usePrefersReducedMotion() {
	const [reduced, setReduced] = useState(false);
	useEffect(() => {
		if (typeof window === "undefined" || !window.matchMedia) {
			return;
		}
		const query = window.matchMedia("(prefers-reduced-motion: reduce)");
		setReduced(query.matches);
		const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
		query.addEventListener("change", onChange);
		return () => query.removeEventListener("change", onChange);
	}, []);
	return reduced;
}

// m13 pinned shelf (mock `Feed with Pins`): PINNED strip with count and a
// hide/show toggle, over a collapsible auto-fill card grid.
// m21 (SPEC §9): the grid is drag-and-drop sortable — pointer (8px activation,
// so a plain click still opens the bookmark), touch (200ms hold, so a swipe
// still scrolls) and keyboard (through each card's ⋮⋮ grip). A COLLAPSED shelf
// has nothing to drag, so it renders no DndContext at all.
function PinnedShelf({
	items,
	open,
	onToggleOpen,
	onUnpin,
	onReorder,
	error,
}: {
	items: ApiBookmark[];
	open: boolean;
	onToggleOpen: () => void;
	onUnpin: (id: number) => void;
	onReorder: (activeId: number, overId: number) => void;
	/** m21: `couldn't save order` after a failed PUT; null once one succeeds. */
	error?: string | null;
}) {
	const reduceMotion = usePrefersReducedMotion();
	const sensors = useSensors(
		// Mouse: an 8px slop so a click on the card body is still a click. (Mouse,
		// not Pointer: dnd-kit pairs Mouse+Touch so the touch hold below is never
		// out-raced by the pointer distance constraint on a touch swipe.)
		useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
		// Touch: hold to lift, so a vertical swipe scrolls the feed instead.
		useSensor(TouchSensor, {
			activationConstraint: { delay: 200, tolerance: 5 },
		}),
		useSensor(KeyboardSensor, {
			coordinateGetter: sortableKeyboardCoordinates,
		}),
	);

	const ids = useMemo(() => items.map((b) => b.id), [items]);
	// dnd-kit's live region only knows ids; announcements have to name cards
	// the way the user sees them (SPEC §9).
	const labels = useMemo(
		() =>
			new Map(
				items.map((b) => [b.id, b.title || hostOf(b.url) || b.url] as const),
			),
		[items],
	);

	const announcements: Announcements = useMemo(() => {
		const nameOf = (id: string | number) =>
			labels.get(Number(id)) ?? `pinned bookmark ${id}`;
		const slotOf = (id: string | number) => ids.indexOf(Number(id)) + 1;
		const total = ids.length;
		return {
			onDragStart: ({ active }) =>
				`Picked up ${nameOf(active.id)}. It is pinned in position ${slotOf(active.id)} of ${total}.`,
			onDragOver: ({ active, over }) =>
				over
					? `${nameOf(active.id)} was moved to position ${slotOf(over.id)} of ${total}.`
					: `${nameOf(active.id)} is no longer over a shelf position.`,
			onDragEnd: ({ active, over }) =>
				over
					? `${nameOf(active.id)} was dropped in position ${slotOf(over.id)} of ${total}.`
					: `${nameOf(active.id)} was dropped. The shelf order is unchanged.`,
			onDragCancel: ({ active }) =>
				`Reordering cancelled. ${nameOf(active.id)} stays in position ${slotOf(active.id)} of ${total}.`,
		};
	}, [ids, labels]);

	function handleDragEnd(event: DragEndEvent) {
		const { active, over } = event;
		if (!over || active.id === over.id) {
			return;
		}
		onReorder(Number(active.id), Number(over.id));
	}

	const strip = (
		<div
			className={cn(
				"flex items-center gap-2 bg-[var(--log-panel)] px-4 pt-1.5",
				// Closed: the strip is the whole shelf, so it draws the rule
				// the grid would otherwise carry — unless the error line below
				// is showing, in which case that carries it instead.
				!open && !error && "border-b border-[var(--log-rule)] pb-1.5",
			)}
		>
			<span className="font-mono text-[10px] tracking-[0.08em] text-muted-foreground">
				PINNED
			</span>
			<span className="font-mono text-[10.5px] text-[var(--log-faint)]">
				{items.length}
			</span>
			<button
				type="button"
				onClick={onToggleOpen}
				className="ml-auto font-mono text-[10px] text-[var(--log-faint)] hover:text-[var(--log-fg)]"
			>
				{open ? "hide ▴" : "show ▾"}
			</button>
		</div>
	);

	const errorLine = error ? (
		<p
			className={cn(
				"bg-[var(--log-panel)] px-4 pt-1 font-mono text-[10.5px] text-destructive",
				!open && "border-b border-[var(--log-rule)] pb-1.5",
			)}
		>
			{error}
		</p>
	) : null;

	if (!open) {
		return (
			<Fragment>
				{strip}
				{errorLine}
			</Fragment>
		);
	}

	return (
		<Fragment>
			{strip}
			{errorLine}
			<DndContext
				sensors={sensors}
				collisionDetection={closestCenter}
				onDragEnd={handleDragEnd}
				accessibility={{
					announcements,
					screenReaderInstructions: SHELF_SR_INSTRUCTIONS,
				}}
			>
				<SortableContext items={ids} strategy={rectSortingStrategy}>
					<div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2 border-b border-[var(--log-rule)] bg-[var(--log-panel)] px-4 pt-2.5 pb-3">
						{items.map((b) => (
							<PinnedCard
								key={b.id}
								bookmark={b}
								onUnpin={() => onUnpin(b.id)}
								reduceMotion={reduceMotion}
							/>
						))}
					</div>
				</SortableContext>
			</DndContext>
		</Fragment>
	);
}

function PinnedCard({
	bookmark,
	onUnpin,
	reduceMotion,
}: {
	bookmark: ApiBookmark;
	onUnpin: () => void;
	reduceMotion: boolean;
}) {
	const {
		attributes,
		listeners,
		setNodeRef,
		setActivatorNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id: bookmark.id });
	const host = hostOf(bookmark.url);
	const label = bookmark.title || bookmark.url;
	const openBookmark = () =>
		window.open(bookmark.url, "_blank", "noopener,noreferrer");

	// m21: a COMPLETED drag must never open the bookmark — the pointerup that
	// ends a lift still fires a trailing click on the card. The flag is armed
	// the moment the card starts dragging and disarmed by whichever comes
	// first: the click it was meant to swallow, or the next fresh pointerdown
	// (which is what keeps a KEYBOARD reorder — no trailing click at all —
	// from eating the user's next real click).
	const draggedRef = useRef(false);
	useEffect(() => {
		if (isDragging) {
			draggedRef.current = true;
		}
	}, [isDragging]);

	// The grip is a real <button>, so dnd-kit's role="button" would be
	// redundant; everything else in `attributes` (tabIndex, aria-describedby
	// pointing at the instructions, aria-roledescription) is what the keyboard
	// sensor needs.
	const { role: _dragRole, ...gripAttributes } = attributes;

	return (
		// The card holds nested unpin/reorder buttons, which rules out wrapping
		// it in an <a> (invalid nesting) — same trade-off as LogRow.
		// biome-ignore lint/a11y/useSemanticElements: see above — the nested unpin and reorder buttons forbid a native link/button wrapper.
		<div
			ref={setNodeRef}
			role="button"
			tabIndex={0}
			title={bookmark.url}
			style={{
				transform: CSS.Transform.toString(transform),
				// Reduced motion: the cards jump to their new slots instead of
				// sliding. The drag itself still tracks the pointer.
				transition: reduceMotion ? undefined : transition,
			}}
			// Pointer/touch lift from anywhere on the card (m21, SPEC §9)…
			{...listeners}
			onPointerDown={(e) => {
				draggedRef.current = false;
				listeners?.onPointerDown?.(e);
			}}
			// …but NOT the keyboard: the card's own Enter/Space stay "open the
			// bookmark", and the ⋮⋮ grip below is the keyboard drag affordance.
			// This override deliberately replaces the KeyboardSensor's
			// activator spread just above.
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					openBookmark();
				}
			}}
			onClick={() => {
				if (draggedRef.current) {
					draggedRef.current = false;
					return;
				}
				openBookmark();
			}}
			className={cn(
				"flex cursor-pointer flex-col gap-1.5 rounded-md border border-[var(--log-card-border)] bg-card px-2.5 py-2 hover:border-[var(--log-strong-border)]",
				// Grid items honour z-index without positioning; the lifted
				// card rides over the ones sliding past it.
				isDragging && "z-10 opacity-50",
			)}
		>
			<div className="flex items-center gap-1.5">
				{host ? <Favicon host={host} src={bookmark.faviconUrl} /> : null}
				<span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground">
					{host ?? bookmark.url}
				</span>
				<button
					type="button"
					ref={setActivatorNodeRef}
					aria-label={`Reorder ${label}`}
					{...gripAttributes}
					{...listeners}
					// The grip drags; it never opens the bookmark.
					onClick={(e) => e.stopPropagation()}
					className="shrink-0 cursor-grab touch-none font-mono text-[10px] text-[var(--log-ghost)] hover:text-[var(--log-fg)] active:cursor-grabbing"
				>
					⋮⋮
				</button>
				<button
					type="button"
					aria-label={`Unpin ${label}`}
					// m21: a button inside a sortable card is not a drag
					// surface — swallow the pointerdown so hovering over ✕ and
					// clicking it can't start a lift.
					onPointerDown={(e) => e.stopPropagation()}
					onClick={(e) => {
						e.stopPropagation();
						onUnpin();
					}}
					className="shrink-0 font-mono text-[10px] text-[var(--log-ghost)] hover:text-[var(--log-accent)]"
				>
					✕
				</button>
			</div>
			<span className="line-clamp-2 text-[12.5px] font-medium leading-[1.4]">
				{bookmark.title || "(untitled)"}
			</span>
		</div>
	);
}
