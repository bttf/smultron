"use client";
// Feed v2 "log view" + search UI — SPEC §9, m9 (+ m10 notes & chip tag
// editing). Talks ONLY to /api/bookmarks* (Hard rule #2 — never the DB
// directly). SWR polls page 1 every 10s; deeper keyset pages append via an
// infinite-scroll sentinel. Row edits (title/tags/note/archive, highlight
// delete) PATCH/DELETE then reconcile local state — see the comments inside
// `Feed` for the reconciliation model.
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { relativeTime } from "../lib/relativeTime";
import { textFragmentUrl } from "../lib/textFragment";
import { cn } from "../lib/utils";
import { ArticleSection } from "./article";
import { TagChips } from "./tag-chips";

type ApiHighlight = {
	id: number;
	text: string;
	createdAt: string;
};

type ApiBookmark = {
	id: number;
	url: string;
	urlNormalized: string;
	title: string;
	// m17: the page's own favicon, filled in from Firecrawl after a web add.
	// Optional (and nullable) — rows saved before m17, or pages that declare
	// no icon, fall back to the hostname-derived favicon service.
	faviconUrl?: string | null;
	tags: string[];
	// m10: PATCHing `note: ""` clears it — the server stores null and the
	// returned row (landing in `overrides`) reflects that.
	note: string | null;
	createdAt: string;
	updatedAt: string;
	archivedAt: string | null;
	// m13: null = not pinned. Pinned rows live in the response's `pinned`
	// shelf and are excluded from the feed log server-side.
	pinnedAt: string | null;
	highlights: ApiHighlight[];
};

// m9 contract: facets/total/matching are computed on page 1 of the current
// key. Kept optional so the UI degrades to 0 / [] against the pre-m9 API
// during integration instead of crashing.
type ListResponse = {
	bookmarks: ApiBookmark[];
	nextCursor: string | null;
	total?: number;
	matching?: number;
	facets?: Array<{ tag: string; count: number }>;
	// m13 pinned shelf: every pinned row, most recently pinned first.
	// Optional for the same integration-window reason as the aggregates.
	pinned?: ApiBookmark[];
};

type PatchFn = (
	id: number,
	patch: {
		title?: string;
		tags?: string[];
		note?: string;
		archived?: boolean;
		pinned?: boolean;
	},
) => Promise<void>;

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
// are normalized to null so an absent key can't read as a change.
type EnrichSnapshot = {
	id: number;
	title: string;
	faviconUrl: string | null;
	note: string | null;
};

// Hard ceiling on the shimmer (SPEC §9). A fill that fails leaves the hostname
// title forever — nothing would ever differ from the snapshot — so the
// affordance must expire on its own, comfortably past the fill's own timeout.
const ENRICH_DEADLINE_MS = 30_000;

const MONTHS = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];

// Log timestamp: "Aug 1 09:14" (24h, no year) inside the current year,
// "Jul 3 2025" outside it. Manual formatting keeps the shape byte-stable
// across locales; this only ever renders client-side (SWR data), so there
// are no hydration concerns.
function formatTimestamp(date: Date, now: Date = new Date()): string {
	const base = `${MONTHS[date.getMonth()]} ${date.getDate()}`;
	if (date.getFullYear() !== now.getFullYear()) {
		return `${base} ${date.getFullYear()}`;
	}
	const hh = String(date.getHours()).padStart(2, "0");
	const mm = String(date.getMinutes()).padStart(2, "0");
	return `${base} ${hh}:${mm}`;
}

// Date only, no time: "Aug 1" in-year, "Aug 1 2025" outside it. Used on the
// compact mobile row, which drops the time from `formatTimestamp` to save
// horizontal space.
function formatDate(date: Date, now: Date = new Date()): string {
	const base = `${MONTHS[date.getMonth()]} ${date.getDate()}`;
	return date.getFullYear() !== now.getFullYear()
		? `${base} ${date.getFullYear()}`
		: base;
}

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
	// m18 (SPEC §9): the add returns immediately, before the §5 metadata fill
	// has run, so a NEWLY created row shows its title/favicon as a shimmer.
	// This is the snapshot of the row as POST returned it — the state clears
	// when a later response differs from it (the fill landed), at
	// ENRICH_DEADLINE_MS, or when the user edits the row's title/note.
	const [enriching, setEnriching] = useState<EnrichSnapshot | null>(null);
	const enrichingId = enriching?.id ?? null;
	// Row to flash after an add (new or resurfaced duplicate)…
	const [flashId, setFlashId] = useState<number | null>(null);
	// …and, for a NEWLY created bookmark only, the row whose expanded panel
	// should focus its add-tag input (mock: `focusLater(tagRef)`).
	const [justAddedId, setJustAddedId] = useState<number | null>(null);
	const submittingRef = useRef(false);
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

	const items = useMemo(() => {
		const base = [...(data?.bookmarks ?? []), ...morePages.flat()];
		return base
			.filter((b) => !removed.has(b.id))
			.map((b) => {
				const patch = overrides.get(b.id);
				return patch ? { ...b, ...patch } : b;
			});
	}, [data, morePages, overrides, removed]);

	// m18 clear #1 (SPEC §9): the fill has landed once ANY of the three
	// snapshotted fields differs on the row we now hold — whether it arrived on
	// a poll or in a PATCH response (`overrides`). A tag edit alone leaves all
	// three equal, so it can't end the shimmer early.
	useEffect(() => {
		if (!enriching) {
			return;
		}
		const row = items.find((b) => b.id === enriching.id);
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
	}, [items, enriching]);

	// m18 clear #2: the deadline. Re-armed per enriching row; cleared on unmount
	// and whenever the state clears some other way.
	useEffect(() => {
		if (enrichingId === null) {
			return;
		}
		const timer = setTimeout(
			() => setEnriching((prev) => (prev?.id === enrichingId ? null : prev)),
			ENRICH_DEADLINE_MS,
		);
		return () => clearTimeout(timer);
	}, [enrichingId]);

	// m18 (SPEC §9): while enriching, revalidate page 1 on a short interval so
	// the fill shows up in seconds rather than on the next 10s poll. Runs
	// alongside `refreshInterval` — an occasional duplicate fetch is harmless;
	// a leaked interval is not, hence the id-scoped effect.
	useEffect(() => {
		if (enrichingId === null) {
			return;
		}
		const timer = setInterval(() => {
			mutate();
		}, 2000);
		return () => clearInterval(timer);
	}, [enrichingId, mutate]);

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
		// so the field is theirs — stop shimmering over it regardless of what
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
				// Into the shelf (front — most recently pinned first). The row
				// also leaves the current list when that list can no longer
				// hold it: the feed log (the server excludes pinned rows) and
				// the archived view (pinning unarchives, search or not). In a
				// live search it stays listed — pinned rows remain findable —
				// so it just takes the override.
				setPinnedExtra((prev) => [updated, ...prev.filter((b) => b.id !== id)]);
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

	async function submitAdd() {
		let raw = urlDraft.trim();
		if (!raw || submittingRef.current) {
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

		// Ref-only guard (no pending UI): m18's add returns in one round trip,
		// but Enter and the Save button can still both fire inside it.
		submittingRef.current = true;
		try {
			const res = await fetch("/api/bookmarks", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ url: raw }),
			});
			if (!res.ok) {
				setAddError(`save failed (${res.status})`);
				return;
			}
			const { bookmark, created } = (await res.json()) as {
				bookmark: Pick<ApiBookmark, "id" | "title" | "faviconUrl" | "note">;
				created: boolean;
			};

			// Mock semantics: close the composer, land in the live view (search
			// and tag filters are kept), flash the row and open its panel. The
			// revalidated page puts the row on top (its updated_at is now).
			closeComposer();
			setArchived(false);
			setExpanded(bookmark.id);
			setJustAddedId(created ? bookmark.id : null);
			// m18 (SPEC §9): only a fresh insert is waiting on a fill — a
			// resurfaced duplicate already carries whatever metadata it has.
			setEnriching(
				created
					? {
							id: bookmark.id,
							title: bookmark.title,
							faviconUrl: bookmark.faviconUrl ?? null,
							note: bookmark.note ?? null,
						}
					: null,
			);
			setFlashId(bookmark.id);
			setTimeout(
				() => setFlashId((prev) => (prev === bookmark.id ? null : prev)),
				2000,
			);
			// If we were in the archived view, the key change refetches anyway
			// and this bound mutate hits the old key — a harmless extra fetch.
			mutate();
		} catch {
			setAddError("save failed");
		} finally {
			submittingRef.current = false;
		}
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
	// (front — most recent first), minus rows unpinned/archived since. Once
	// the revalidated page lands the overlays dedupe into no-ops.
	const shelf = useMemo(() => {
		const base = data?.pinned ?? [];
		const extra = pinnedExtra.filter((p) => !base.some((b) => b.id === p.id));
		return [...extra, ...base].filter((b) => !unpinned.has(b.id));
	}, [data, pinnedExtra, unpinned]);

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
							{/* m18: no pending state — the add is one fast round trip and
							    the composer closes on success. Errors keep it open. */}
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
					) : items.length === 0 ? (
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
							{items.map((b) => (
								<LogRow
									key={b.id}
									bookmark={b}
									archivedView={archived}
									expanded={expanded === b.id}
									flash={flashId === b.id}
									enriching={enrichingId === b.id}
									autoFocusTags={justAddedId === b.id}
									activeTags={activeTags}
									tagSuggestions={tagSuggestions}
									onToggleExpand={() => {
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

// m13 pinned shelf (mock `Feed with Pins`): PINNED strip with count and a
// hide/show toggle, over a collapsible auto-fill card grid.
function PinnedShelf({
	items,
	open,
	onToggleOpen,
	onUnpin,
}: {
	items: ApiBookmark[];
	open: boolean;
	onToggleOpen: () => void;
	onUnpin: (id: number) => void;
}) {
	return (
		<Fragment>
			<div
				className={cn(
					"flex items-center gap-2 bg-[var(--log-panel)] px-4 pt-1.5",
					// Closed: the strip is the whole shelf, so it draws the rule
					// the grid would otherwise carry.
					!open && "border-b border-[var(--log-rule)] pb-1.5",
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
			{open ? (
				<div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2 border-b border-[var(--log-rule)] bg-[var(--log-panel)] px-4 pt-2.5 pb-3">
					{items.map((b) => (
						<PinnedCard key={b.id} bookmark={b} onUnpin={() => onUnpin(b.id)} />
					))}
				</div>
			) : null}
		</Fragment>
	);
}

function PinnedCard({
	bookmark,
	onUnpin,
}: {
	bookmark: ApiBookmark;
	onUnpin: () => void;
}) {
	const host = hostOf(bookmark.url);
	const openBookmark = () =>
		window.open(bookmark.url, "_blank", "noopener,noreferrer");

	return (
		// The card holds a nested unpin button, which rules out wrapping it in
		// an <a> (invalid nesting) — same trade-off as LogRow.
		// biome-ignore lint/a11y/useSemanticElements: see above — the nested unpin button forbids a native link/button wrapper.
		<div
			role="button"
			tabIndex={0}
			onClick={openBookmark}
			onKeyDown={(e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					openBookmark();
				}
			}}
			title={bookmark.url}
			className="flex cursor-pointer flex-col gap-1.5 rounded-md border border-[var(--log-card-border)] bg-card px-2.5 py-2 hover:border-[var(--log-strong-border)]"
		>
			<div className="flex items-center gap-1.5">
				{host ? <Favicon host={host} src={bookmark.faviconUrl} /> : null}
				<span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground">
					{host ?? bookmark.url}
				</span>
				<button
					type="button"
					aria-label={`Unpin ${bookmark.title || bookmark.url}`}
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

function hostOf(url: string): string | null {
	try {
		return new URL(url).hostname;
	} catch {
		return null;
	}
}

/**
 * The row's icon: the favicon the page itself declared (m17, stored on the
 * bookmark) when we have one, otherwise Google's hostname-derived service —
 * which is also the fallback when the stored URL fails to load (gone, blocked
 * as mixed content, no longer served). Both failing renders nothing.
 *
 * Failures are tracked by URL rather than by index so a favicon that arrives
 * later (the fill landing on a poll) is tried without any state to reset.
 */
function Favicon({ host, src }: { host: string; src?: string | null }) {
	const [broken, setBroken] = useState<string[]>([]);
	const sources = [
		...(src ? [src] : []),
		`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`,
	];
	const current = sources.find((url) => !broken.includes(url));
	if (!current) {
		return null;
	}
	return (
		// biome-ignore lint/performance/noImgElement: a tiny 32px favicon icon doesn't warrant next/image's overhead here.
		<img
			// Keyed so a swap to the fallback remounts instead of reusing the
			// errored <img> (which wouldn't re-fire onError for the next source).
			key={current}
			src={current}
			alt=""
			width={14}
			height={14}
			className="shrink-0 rounded-[2px]"
			onError={() =>
				setBroken((prev) =>
					prev.includes(current) ? prev : [...prev, current],
				)
			}
		/>
	);
}

function LogRow({
	bookmark,
	archivedView,
	expanded,
	flash,
	enriching,
	autoFocusTags,
	activeTags,
	tagSuggestions,
	onToggleExpand,
	onToggleTag,
	onPatch,
	onDeleteHighlight,
}: {
	bookmark: ApiBookmark;
	archivedView: boolean;
	expanded: boolean;
	/** Play the rowflash animation (just added / resurfaced via the composer). */
	flash: boolean;
	/**
	 * m18 (SPEC §9): the §5 metadata fill is still running for this freshly
	 * added row, so its title/favicon are placeholders — shimmer them and drop
	 * the note preview. The row stays fully interactive; the expanded panel
	 * shows no shimmer at all (this row IS the affordance).
	 */
	enriching: boolean;
	/** Focus the expanded panel's add-tag input (newly created via the composer). */
	autoFocusTags: boolean;
	activeTags: string[];
	/** m14: existing tags in usage order, fed to the panel's add-tag input. */
	tagSuggestions: string[];
	onToggleExpand: () => void;
	onToggleTag: (tag: string) => void;
	onPatch: PatchFn;
	onDeleteHighlight: (bookmarkId: number, highlightId: number) => Promise<void>;
}) {
	const host = hostOf(bookmark.url);

	return (
		<Fragment>
			{/* The row contains nested interactive controls (tag chips, archive),
			    which rules out a real <button> (invalid nesting) — hence the
			    role="button" div with its own key handling. */}
			{/* biome-ignore lint/a11y/useSemanticElements: see above — nested buttons forbid a native <button> row. */}
			<div
				role="button"
				tabIndex={0}
				onClick={onToggleExpand}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						onToggleExpand();
					}
				}}
				aria-expanded={expanded}
				className={cn(
					"flex cursor-pointer items-center gap-2.5 border-b border-[var(--log-rule)] px-4 py-[5px] hover:bg-[var(--log-hover)]",
					expanded && "bg-[var(--log-hover)]",
					// Keyframes in globals.css; the animation's background wins
					// over the classes above for its 1.4s, then hands back.
					flash && "animate-[rowflash_1.4s_ease-out]",
				)}
			>
				<span
					aria-hidden
					className="w-2.5 shrink-0 font-mono text-[9px] text-[var(--log-faint)]"
				>
					{expanded ? "▾" : "▸"}
				</span>
				{/* Compact mobile row shows the date only; desktop keeps the full
				    timestamp with time. */}
				<span className="w-[52px] shrink-0 whitespace-nowrap font-mono text-[11px] text-muted-foreground md:hidden">
					{formatDate(new Date(bookmark.updatedAt))}
				</span>
				<span className="hidden w-[88px] shrink-0 whitespace-nowrap font-mono text-[11px] text-muted-foreground md:inline">
					{formatTimestamp(new Date(bookmark.updatedAt))}
				</span>
				{host ? (
					enriching ? (
						<span
							aria-hidden
							className="h-[14px] w-[14px] shrink-0 animate-[logshimmer_1.4s_ease-in-out_infinite] rounded-[2px] bg-[var(--log-chip-bg)]"
						/>
					) : (
						<Favicon host={host} src={bookmark.faviconUrl} />
					)
				) : null}
				{host ? (
					<span className="hidden w-[148px] shrink-0 truncate font-mono text-[11px] text-muted-foreground md:block">
						{host}
					</span>
				) : null}
				{/* Gmail-style: title keeps space priority (basis auto, shrinkable),
				    the muted note preview fills ONLY the leftover (basis 0) and
				    truncates first. `?? null` guards the window where page 1
				    predates the m10 backend and rows arrive without a `note` key. */}
				<span className="flex min-w-0 flex-1 items-baseline gap-1.5">
					{/* Enriching (m18): the hostname placeholder isn't worth reading,
					    so the title becomes a shimmer block and the note preview is
					    suppressed — but the text stays in the accessibility tree so
					    the row never goes nameless. */}
					{enriching ? (
						<Fragment>
							<span className="sr-only">{bookmark.title}</span>
							<span
								aria-hidden
								className="h-[11px] w-[180px] max-w-full shrink animate-[logshimmer_1.4s_ease-in-out_infinite] rounded-[3px] bg-[var(--log-soft)]"
							/>
						</Fragment>
					) : (
						<Fragment>
							<span className="min-w-0 shrink truncate text-[13px] font-medium">
								{bookmark.title || "(untitled)"}
							</span>
							{(bookmark.note ?? null) !== null ? (
								<span className="min-w-0 flex-1 basis-0 truncate text-[12.5px] text-muted-foreground">
									— {(bookmark.note as string).replace(/\s+/g, " ")}
								</span>
							) : null}
						</Fragment>
					)}
				</span>
				{bookmark.highlights.length > 0 ? (
					<span className="shrink-0 rounded-full bg-[var(--log-soft)] px-[7px] py-px font-mono text-[10.5px] text-[var(--log-accent)]">
						✱ {bookmark.highlights.length}
					</span>
				) : null}
				{bookmark.tags.length > 0 ? (
					<span className="flex shrink-0 items-center gap-1">
						{bookmark.tags.map((tag) => {
							const active = activeTags.includes(tag);
							return (
								<button
									key={tag}
									type="button"
									onClick={(e) => {
										e.stopPropagation();
										onToggleTag(tag);
									}}
									className={cn(
										"whitespace-nowrap rounded px-[7px] py-px font-mono text-[10.5px]",
										active
											? "bg-[var(--log-accent-solid)] text-white"
											: "bg-[var(--log-chip-bg)] text-[var(--log-chip-fg)]",
									)}
								>
									{tag}
								</button>
							);
						})}
					</span>
				) : null}
			</div>
			{expanded ? (
				<ExpandedPanel
					bookmark={bookmark}
					archivedView={archivedView}
					autoFocusTags={autoFocusTags}
					tagSuggestions={tagSuggestions}
					onPatch={onPatch}
					onDeleteHighlight={onDeleteHighlight}
				/>
			) : null}
		</Fragment>
	);
}

function ExpandedPanel({
	bookmark,
	archivedView,
	autoFocusTags,
	tagSuggestions,
	onPatch,
	onDeleteHighlight,
}: {
	bookmark: ApiBookmark;
	archivedView: boolean;
	autoFocusTags: boolean;
	tagSuggestions: string[];
	onPatch: PatchFn;
	onDeleteHighlight: (bookmarkId: number, highlightId: number) => Promise<void>;
}) {
	return (
		// The row above already draws the 1px rule (its border-b), so the panel
		// only draws its own bottom rule — a border-t here would double up.
		<div className="flex flex-col gap-2 border-b border-[var(--log-rule)] bg-[var(--log-panel)] pt-2.5 pr-4 pb-3.5 pl-11">
			<div className="flex max-w-[720px] items-center gap-1.5">
				<a
					href={bookmark.url}
					target="_blank"
					rel="noreferrer"
					className="min-w-0 truncate font-mono text-[11.5px] text-[var(--log-accent)] hover:underline"
				>
					{bookmark.url}
				</a>
				<CopyUrlButton url={bookmark.url} />
			</div>
			<span className="font-mono text-[11px] text-muted-foreground">
				saved {formatTimestamp(new Date(bookmark.createdAt))} ·{" "}
				{relativeTime(new Date(bookmark.createdAt))}
			</span>
			<div className="flex max-w-[720px] items-baseline gap-2">
				<span className="shrink-0 font-mono text-[10px] tracking-[0.08em] text-muted-foreground">
					TITLE
				</span>
				<EditableTitle
					title={bookmark.title}
					onSave={(title) => onPatch(bookmark.id, { title })}
				/>
			</div>
			<div className="flex max-w-[720px] items-center gap-2">
				<span className="shrink-0 font-mono text-[10px] tracking-[0.08em] text-muted-foreground">
					TAGS
				</span>
				<TagChips
					tags={bookmark.tags}
					autoFocusInput={autoFocusTags}
					suggestions={tagSuggestions}
					onSave={(tags) => onPatch(bookmark.id, { tags })}
				/>
			</div>
			<NoteSection
				note={bookmark.note ?? null}
				onSave={(note) => onPatch(bookmark.id, { note })}
			/>
			{/* Mounted only for the open row, so collapsed rows never fetch. */}
			<ArticleSection bookmarkId={bookmark.id} />
			{bookmark.highlights.length > 0 ? (
				<Fragment>
					<span className="font-mono text-[10px] tracking-[0.08em] text-muted-foreground">
						HIGHLIGHTS ({bookmark.highlights.length})
					</span>
					<div className="flex flex-col gap-1.5">
						{bookmark.highlights.map((h) => (
							<HighlightCard
								key={h.id}
								highlight={h}
								pageUrl={bookmark.url}
								onDelete={() => onDeleteHighlight(bookmark.id, h.id)}
							/>
						))}
					</div>
				</Fragment>
			) : null}
			{/* Pin + archive/restore live only in the expanded panel — the row
			    omits them to stay compact across all viewports. In the feed the
			    log never holds pinned rows, so the button reads "★ Pin" there;
			    a pinned row surfaced by search reads "Unpin". */}
			<div className="flex gap-1.5">
				<button
					type="button"
					onClick={() =>
						// `?? null` guards rows served before the m13 backend
						// landed (same as the note preview above).
						onPatch(bookmark.id, {
							pinned: (bookmark.pinnedAt ?? null) === null,
						})
					}
					className="rounded-md border border-border bg-card px-3 py-1 text-[11.5px] text-[var(--log-chip-fg)] hover:bg-[var(--log-soft)]"
				>
					{(bookmark.pinnedAt ?? null) === null ? "★ Pin" : "Unpin"}
				</button>
				<button
					type="button"
					onClick={() => onPatch(bookmark.id, { archived: !archivedView })}
					className="rounded-md border border-border bg-card px-3 py-1 text-[11.5px] text-[var(--log-chip-fg)] hover:bg-[var(--log-soft)]"
				>
					{archivedView ? "Restore" : "Archive"}
				</button>
			</div>
		</div>
	);
}

function CopyUrlButton({ url }: { url: string }) {
	const [copied, setCopied] = useState(false);
	const resetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const unmountedRef = useRef(false);

	useEffect(() => {
		unmountedRef.current = false;
		return () => {
			unmountedRef.current = true;
			if (resetRef.current) {
				clearTimeout(resetRef.current);
			}
		};
	}, []);

	async function copy() {
		try {
			await navigator.clipboard.writeText(url);
		} catch {
			// Clipboard unavailable (permissions/insecure context) — leave the
			// button in its idle state rather than lie with a checkmark.
			return;
		}
		if (unmountedRef.current) {
			// Panel collapsed while the clipboard promise was in flight — don't
			// schedule a reset timer nothing will clear.
			return;
		}
		setCopied(true);
		if (resetRef.current) {
			clearTimeout(resetRef.current);
		}
		resetRef.current = setTimeout(() => setCopied(false), 1500);
	}

	return (
		<button
			type="button"
			onClick={copy}
			// State-dependent label: a static one would mask the visible text
			// change in the accessible name, leaving screen readers with no
			// success confirmation.
			aria-label={copied ? "Copied" : "Copy URL to clipboard"}
			title="Copy URL"
			className={cn(
				"shrink-0 font-mono text-[11px] leading-none",
				copied
					? "text-[var(--log-accent)]"
					: "text-[var(--log-faint)] hover:text-[var(--log-accent)]",
			)}
		>
			{copied ? "✓ copied" : "⧉"}
		</button>
	);
}

function HighlightCard({
	highlight,
	pageUrl,
	onDelete,
}: {
	highlight: ApiHighlight;
	pageUrl: string;
	onDelete: () => void;
}) {
	return (
		<div className="flex max-w-[720px] items-start gap-2 rounded-md border border-[var(--log-card-border)] bg-card px-2.5 py-[7px]">
			<span
				aria-hidden
				className="text-[11px] leading-[1.55] text-[var(--log-accent)]"
			>
				✱
			</span>
			<a
				href={textFragmentUrl(pageUrl, highlight.text)}
				target="_blank"
				rel="noreferrer"
				title={highlight.text}
				className="min-w-0 flex-1 text-[12.5px] leading-[1.55] text-[var(--log-fg)] hover:underline"
			>
				{highlight.text}
			</a>
			<button
				type="button"
				onClick={onDelete}
				className="shrink-0 font-mono text-[10px] text-muted-foreground hover:text-destructive"
			>
				delete
			</button>
		</div>
	);
}

function EditableTitle({
	title,
	onSave,
}: {
	title: string;
	onSave: (next: string) => void;
}) {
	const [editing, setEditing] = useState(false);
	const [value, setValue] = useState(title);

	useEffect(() => {
		setValue(title);
	}, [title]);

	if (editing) {
		return (
			<input
				// biome-ignore lint/a11y/noAutofocus: user just clicked the title to edit — focus is expected.
				autoFocus
				value={value}
				onChange={(e) => setValue(e.target.value)}
				onBlur={() => setEditing(false)}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						setEditing(false);
						if (value.trim() !== title) {
							onSave(value.trim());
						}
					} else if (e.key === "Escape") {
						e.preventDefault();
						setValue(title);
						setEditing(false);
					}
				}}
				className="w-full min-w-0 rounded border border-border bg-background px-1.5 py-0.5 text-[12.5px] font-medium outline-none focus:border-[var(--log-accent)]"
			/>
		);
	}

	return (
		<button
			type="button"
			onClick={() => setEditing(true)}
			className="min-w-0 truncate text-left text-[12.5px] font-medium hover:underline"
			title="Click to edit title"
		>
			{title || "(untitled)"}
		</button>
	);
}

// m10 NOTE section. The editor state lives here in the panel — only one row
// expands at a time, so collapsing/switching rows unmounts (and discards) any
// in-progress draft by construction. Save always PATCHes the trimmed draft;
// trimmed-empty means delete (server nulls the note, and the returned row in
// `overrides` flips this back to the SET NOTES state).
function NoteSection({
	note,
	onSave,
}: {
	note: string | null;
	onSave: (next: string) => void;
}) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState("");

	function open() {
		setDraft(note ?? "");
		setEditing(true);
	}

	function save() {
		setEditing(false);
		onSave(draft.trim());
	}

	if (editing) {
		return (
			<div className="flex max-w-[720px] flex-col gap-1.5">
				<textarea
					// biome-ignore lint/a11y/noAutofocus: user just clicked to edit the note — focus is expected.
					autoFocus
					rows={3}
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter" && !e.shiftKey) {
							e.preventDefault();
							save();
						} else if (e.key === "Escape") {
							e.preventDefault();
							setEditing(false);
						}
					}}
					placeholder="Write a note… (Enter to save, Esc to cancel)"
					className="resize-y rounded-md border border-border bg-card px-2.5 py-[7px] text-[12.5px] leading-[1.55] text-[var(--log-note-fg)] outline-none [font-family:inherit] focus:border-[var(--log-accent)]"
				/>
				<div className="flex gap-1.5">
					<button
						type="button"
						onClick={save}
						className="rounded-md bg-[var(--log-btn)] px-3 py-1 text-[11.5px] font-medium text-white hover:bg-[var(--log-btn-hover)]"
					>
						Save
					</button>
					<button
						type="button"
						onClick={() => setEditing(false)}
						className="rounded-md border border-border bg-card px-3 py-1 text-[11.5px] text-[var(--log-chip-fg)] hover:bg-[var(--log-soft)]"
					>
						Cancel
					</button>
				</div>
			</div>
		);
	}

	if (note === null) {
		return (
			<button
				type="button"
				onClick={open}
				className="self-start font-mono text-[10px] tracking-[0.08em] text-muted-foreground hover:text-foreground"
			>
				SET NOTES
			</button>
		);
	}

	return (
		<Fragment>
			<span className="font-mono text-[10px] tracking-[0.08em] text-muted-foreground">
				NOTE
			</span>
			<button
				type="button"
				onClick={open}
				title="Click to edit note"
				className="max-w-[720px] cursor-text whitespace-pre-wrap rounded-md border border-[var(--log-card-border)] bg-card px-2.5 py-[7px] text-left text-[12.5px] leading-[1.55] text-[var(--log-fg)] hover:border-[var(--log-strong-border)]"
			>
				{note}
			</button>
		</Fragment>
	);
}
