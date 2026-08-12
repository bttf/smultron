"use client";
// Browse-event log view — SPEC §9 ("Browse-events log view (m19)"), kinds and
// per-kind fields per §13. The mid-week sanity check for the collection week:
// a dense, read-only Datadog-style log over raw attention edges, not a product
// surface. Talks ONLY to GET /api/browse-events (Hard rule #2 — never the DB
// directly), polls page 1 every 10s via SWR, and pages deeper with the feed's
// IntersectionObserver sentinel. No realtime (Hard rule #6).
//
// Behaviorally this is feed.tsx minus every write path: there are no row edits,
// no optimistic overlays and no expanded panels — browse events are append-only
// telemetry, so the only local state is the filter, the cursor, and the pages
// already fetched.
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import {
	BROWSE_EVENT_KINDS,
	type BrowseEventKind,
	formatEventDetail,
	formatEventTime,
	kindBadgeStyle,
	withDayDividers,
} from "../lib/eventLog";
import { cn } from "../lib/utils";
import { hostOf } from "./log-row";

// SPEC §8, GET /api/browse-events. Typed locally (the route and its lib land
// on their own branch): absent per-kind fields arrive as null, never omitted.
type ApiBrowseEvent = {
	id: number;
	kind: string;
	occurredAt: string;
	bootId: string;
	url: string | null;
	urlNormalized: string | null;
	title: string | null;
	tabId: number | null;
	windowId: number | null;
	idleState: string | null;
	transition: string | null;
	documentLifecycle: string | null;
	createdAt: string;
};

// `total` is the uncapped count for the current filter. Kept optional so the
// toolbar degrades to 0 instead of crashing if a response ever omits it.
type ListResponse = {
	events: ApiBrowseEvent[];
	nextCursor: string | null;
	total?: number;
};

class FetchError extends Error {}

async function fetcher(url: string): Promise<ListResponse> {
	const res = await fetch(url);
	if (!res.ok) {
		throw new FetchError(`request failed (${res.status})`);
	}
	return res.json() as Promise<ListResponse>;
}

function buildUrl(q: string, kinds: BrowseEventKind[], cursor?: string | null) {
	const params = new URLSearchParams();
	const trimmed = q.trim();
	if (trimmed) {
		params.set("q", trimmed);
	}
	// Repeatable `kind` param — the server ORs them (a kind filter narrows to
	// the selected kinds; none selected = all kinds).
	for (const kind of kinds) {
		params.append("kind", kind);
	}
	if (cursor) {
		params.set("cursor", cursor);
	}
	const qs = params.toString();
	return `/api/browse-events${qs ? `?${qs}` : ""}`;
}

const DEBOUNCE_MS = 150;
const POLL_MS = 10_000;

const numberFormat = new Intl.NumberFormat("en-US");

export function EventsLog() {
	const [rawQuery, setRawQuery] = useState("");
	const [query, setQuery] = useState("");
	const [activeKinds, setActiveKinds] = useState<BrowseEventKind[]>([]);
	const logRef = useRef<HTMLDivElement>(null);
	const sentinelRef = useRef<HTMLDivElement>(null);

	// Debounce the filter box ~150ms before it feeds the SWR key.
	useEffect(() => {
		const id = setTimeout(() => setQuery(rawQuery), DEBOUNCE_MS);
		return () => clearTimeout(id);
	}, [rawQuery]);

	// Kinds sort into the key so toggle order can't fork identical filters into
	// distinct SWR cache entries. They MUST be in the key — filtering is
	// server-side.
	const sortedKinds = useMemo(
		() => BROWSE_EVENT_KINDS.filter((kind) => activeKinds.includes(kind)),
		[activeKinds],
	);
	const key = buildUrl(query, sortedKinds);

	// keepPreviousData: a key change (filter text, kind toggle) keeps the
	// previous response rendered while the new page loads instead of blanking
	// to `data === undefined` — the pane must NEVER go empty during a refetch
	// (SPEC §9). `isLoading` stays true for such a fetch (SWR: no data for the
	// CURRENT key yet), which is what dims the stale rows and parks the
	// infinite-scroll sentinel; background polls don't set it.
	const { data, error, isLoading } = useSWR<ListResponse, Error>(key, fetcher, {
		refreshInterval: POLL_MS,
		keepPreviousData: true,
	});

	// Deeper pages, loaded via the sentinel. Only page 1 (the SWR key above)
	// polls; appended pages are a point-in-time snapshot — same documented
	// simplification as the feed.
	const [morePages, setMorePages] = useState<ApiBrowseEvent[][]>([]);
	const [cursor, setCursor] = useState<string | null>(null);
	const [loadingMore, setLoadingMore] = useState(false);
	const loadingMoreRef = useRef(false);

	// Reset paging whenever the filter changes (the SWR key captures both the
	// text and the kinds). Done during render — React's "adjust state when a
	// prop changes" pattern — so the reset is visible in the very render that
	// changed `key`, with no stale flash of the previous filter's pages.
	const prevKey = useRef(key);
	if (prevKey.current !== key) {
		prevKey.current = key;
		setMorePages([]);
		setCursor(null);
	}

	// Only sync `cursor` from the polled page 1 while no deeper page has been
	// loaded — once the sentinel has advanced, a background page-1 refresh must
	// not clobber the further-along cursor.
	useEffect(() => {
		if (morePages.length === 0) {
			setCursor(data?.nextCursor ?? null);
		}
	}, [data, morePages.length]);

	const events = useMemo(
		() => [...(data?.events ?? []), ...morePages.flat()],
		[data, morePages],
	);
	const rows = useMemo(() => withDayDividers(events), [events]);

	async function loadMore() {
		// Ref (not state) guards double-fires: the observer can call again before
		// the setLoadingMore re-render lands.
		if (!cursor || loadingMoreRef.current) {
			return;
		}
		loadingMoreRef.current = true;
		setLoadingMore(true);
		const keyAtStart = key;
		try {
			const page = await fetcher(buildUrl(query, sortedKinds, cursor));
			if (prevKey.current !== keyAtStart) {
				// Filter changed mid-flight — the page belongs to the old view.
				return;
			}
			setMorePages((pages) => [...pages, page.events]);
			setCursor(page.nextCursor);
		} catch {
			// Transient failure — the sentinel refires on the next intersection
			// change, so this retries naturally on scroll.
		} finally {
			loadingMoreRef.current = false;
			setLoadingMore(false);
		}
	}
	// Latest-closure ref so the observer effect doesn't depend on everything
	// `loadMore` captures.
	const loadMoreRef = useRef(loadMore);
	loadMoreRef.current = loadMore;

	// Infinite scroll: observe the sentinel inside the log's own scroll
	// container. Recreated per `cursor` so a sentinel still visible after a page
	// lands chains straight into the next fetch (observe() fires an initial
	// callback with the current intersection state). The `isLoading` gate parks
	// it while stale previous-key rows are showing — `cursor` still belongs to
	// the OLD key then, and paging with it would splice foreign rows in.
	useEffect(() => {
		if (cursor === null || isLoading) {
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
	}, [cursor, isLoading]);

	function toggleKind(kind: BrowseEventKind) {
		setActiveKinds((prev) =>
			prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind],
		);
	}

	const total = data?.total ?? 0;
	const filtered = query.trim().length > 0 || sortedKinds.length > 0;

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2">
				<input
					type="search"
					value={rawQuery}
					onChange={(e) => setRawQuery(e.target.value)}
					placeholder="filter url / title…"
					spellCheck={false}
					className="min-w-[180px] flex-1 rounded-md border border-border bg-background px-2.5 py-[5px] font-mono text-[12.5px] outline-none focus:border-[var(--log-accent)]"
				/>
				<span className="whitespace-nowrap font-mono text-[11px] text-muted-foreground">
					{numberFormat.format(total)} events
				</span>
			</div>

			<div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-4 py-1.5">
				{BROWSE_EVENT_KINDS.map((kind) => {
					const active = activeKinds.includes(kind);
					const style = kindBadgeStyle(kind);
					return (
						<button
							key={kind}
							type="button"
							onClick={() => toggleKind(kind)}
							aria-pressed={active}
							// Active chips wear the kind's own badge colors; inactive
							// ones are outlines, so the palette reads as the legend.
							style={
								active
									? { ...style, borderColor: style.color }
									: { color: "var(--log-faint)" }
							}
							className={cn(
								"whitespace-nowrap rounded border px-[7px] py-px font-mono text-[10.5px]",
								active
									? "font-semibold"
									: "border-border hover:bg-[var(--log-soft)]",
							)}
						>
							{kind}
						</button>
					);
				})}
				{activeKinds.length > 0 ? (
					<button
						type="button"
						onClick={() => setActiveKinds([])}
						className="ml-1 font-mono text-[10.5px] text-[var(--log-accent)]"
					>
						clear
					</button>
				) : null}
			</div>

			<div ref={logRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto">
				{error ? (
					<p className="px-4 py-3 font-mono text-xs text-destructive">
						Couldn&apos;t load events: {error.message}
					</p>
				) : null}

				{!data && isLoading ? (
					<p className="px-4 py-6 font-mono text-xs text-muted-foreground">
						Loading…
					</p>
				) : rows.length === 0 ? (
					<EmptyState filtered={filtered} />
				) : (
					// Stale rows (previous key, kept by keepPreviousData) dim while the
					// new page is in flight — they never disappear.
					<div className={cn("transition-opacity", isLoading && "opacity-60")}>
						{rows.map(({ event, divider }) => (
							<Fragment key={event.id}>
								{divider ? <DayDivider label={divider} /> : null}
								<EventRow event={event} />
							</Fragment>
						))}
					</div>
				)}

				{cursor !== null && !isLoading ? (
					<div
						ref={sentinelRef}
						className="px-4 py-2 font-mono text-[11px] text-muted-foreground"
					>
						{loadingMore ? "loading…" : " "}
					</div>
				) : null}
			</div>
		</div>
	);
}

function DayDivider({ label }: { label: string }) {
	return (
		<div className="sticky top-0 z-10 border-b border-[var(--log-rule)] bg-[var(--log-panel)] px-4 py-[3px] font-mono text-[10px] tracking-[0.08em] text-muted-foreground">
			{label.toUpperCase()}
		</div>
	);
}

function EventRow({ event }: { event: ApiBrowseEvent }) {
	const host = event.url ? hostOf(event.url) : null;
	const detail = formatEventDetail(event);
	const badge = kindBadgeStyle(event.kind);
	// Title where the kind carries one (§13: nav has none — at commit time the
	// tab still shows the previous page's), URL otherwise. Boundary kinds
	// (window_blur, idle, capture_*) carry neither and leave the column empty.
	const label = event.title ?? event.url ?? "";

	return (
		<div
			// Denser than the feed's rows: this is a diagnostic log, read by the
			// screenful.
			className="flex items-center gap-2.5 border-b border-[var(--log-rule)] px-4 py-[3px] hover:bg-[var(--log-hover)]"
			title={event.url ?? undefined}
		>
			<span className="w-[56px] shrink-0 whitespace-nowrap font-mono text-[11px] text-muted-foreground">
				{formatEventTime(new Date(event.occurredAt))}
			</span>
			<span className="w-[96px] shrink-0">
				<span
					style={badge}
					className="inline-block max-w-full truncate rounded border px-[5px] py-px font-mono text-[10px] leading-[15px]"
				>
					{event.kind}
				</span>
			</span>
			<span className="hidden w-[150px] shrink-0 truncate font-mono text-[11px] text-muted-foreground md:block">
				{host ?? ""}
			</span>
			<span className="min-w-0 flex-1 truncate text-[12.5px]">{label}</span>
			{detail ? (
				<span className="hidden w-[168px] shrink-0 truncate font-mono text-[10.5px] text-[var(--log-chip-fg)] lg:block">
					{detail}
				</span>
			) : (
				<span aria-hidden className="hidden w-[168px] shrink-0 lg:block" />
			)}
			<span className="w-[52px] shrink-0 text-right font-mono text-[10.5px] text-[var(--log-faint)]">
				{event.tabId ?? ""}
			</span>
		</div>
	);
}

function EmptyState({ filtered }: { filtered: boolean }) {
	return (
		<p className="max-w-md px-4 py-6 font-mono text-xs text-muted-foreground">
			{filtered
				? "no matching events"
				: "No browse events yet — flip on attention tracking in the extension popup and captured events show up here."}
		</p>
	);
}
