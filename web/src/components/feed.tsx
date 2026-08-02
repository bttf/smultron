"use client";
// Feed v2 "log view" + search UI — SPEC §9, m9. Talks ONLY to /api/bookmarks*
// (Hard rule #2 — never the DB directly). SWR polls page 1 every 10s; deeper
// keyset pages append via an infinite-scroll sentinel. Row edits (title/tags/
// archive, highlight delete) PATCH/DELETE then reconcile local state — see the
// comments inside `Feed` for the reconciliation model.
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { relativeTime } from "../lib/relativeTime";
import { textFragmentUrl } from "../lib/textFragment";
import { cn } from "../lib/utils";

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
	tags: string[];
	createdAt: string;
	updatedAt: string;
	archivedAt: string | null;
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
};

type PatchFn = (
	id: number,
	patch: { title?: string; tags?: string[]; archived?: boolean },
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
	const { data, error, isLoading, mutate } = useSWR<ListResponse, Error>(
		key,
		fetcher,
		{ refreshInterval: 10_000 },
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
	}

	// Only sync `cursor` from the polled page 1 while no deeper page has been
	// loaded yet — once the sentinel has advanced past page 1, a background
	// page-1 refresh must not clobber the further-along cursor.
	useEffect(() => {
		if (morePages.length === 0) {
			setCursor(data?.nextCursor ?? null);
		}
	}, [data, morePages.length]);

	const items = useMemo(() => {
		const base = [...(data?.bookmarks ?? []), ...morePages.flat()];
		return base
			.filter((b) => !removed.has(b.id))
			.map((b) => {
				const patch = overrides.get(b.id);
				return patch ? { ...b, ...patch } : b;
			});
	}, [data, morePages, overrides, removed]);

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
		if (!noQuery || cursor === null) {
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
	}, [noQuery, cursor]);

	async function patchRow(
		id: number,
		patch: { title?: string; tags?: string[]; archived?: boolean },
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

		if (patch.archived !== undefined) {
			// Archiving/restoring always moves the row out of whichever view
			// it's currently shown in — and its panel must not stay open.
			setRemoved((prev) => new Set(prev).add(id));
			setExpanded((prev) => (prev === id ? null : prev));
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

	const facets = data?.facets ?? [];
	const total = data?.total ?? 0;
	const matching = data?.matching ?? 0;

	const facetFilterTrimmed = facetFilter.trim().toLowerCase();
	const visibleFacets = facetFilterTrimmed
		? facets.filter((f) => f.tag.toLowerCase().includes(facetFilterTrimmed))
		: facets;

	return (
		<div className="flex min-h-0 flex-1 flex-col [--log-accent:#4F46E5]">
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
						archived && "border-[oklch(0.85_0_0)] bg-[oklch(0.97_0_0)]",
					)}
				>
					{archived ? "Viewing archived" : "Archived"}
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
										"flex w-full items-center justify-between gap-2 rounded-[5px] px-2 py-1 text-left text-xs hover:bg-[oklch(0.965_0_0)]",
										active
											? "bg-[oklch(0.955_0.015_280)] font-semibold text-[var(--log-accent)]"
											: "text-[oklch(0.3_0_0)]",
									)}
								>
									<span className="truncate">{f.tag}</span>
									<span className="shrink-0 font-mono text-[10.5px] text-[oklch(0.6_0_0)]">
										{f.count}
									</span>
								</button>
							);
						})}
					</div>
				</aside>

				<div ref={logRef} className="min-w-0 flex-1 overflow-y-auto">
					{error ? (
						<p className="px-4 py-3 font-mono text-xs text-destructive">
							Couldn&apos;t load bookmarks: {error.message}
						</p>
					) : null}

					{isLoading ? (
						<p className="px-4 py-6 font-mono text-xs text-muted-foreground">
							Loading…
						</p>
					) : items.length === 0 ? (
						<EmptyState archived={archived} noQuery={noQuery} />
					) : (
						items.map((b) => (
							<LogRow
								key={b.id}
								bookmark={b}
								archivedView={archived}
								expanded={expanded === b.id}
								activeTags={activeTags}
								onToggleExpand={() =>
									setExpanded((prev) => (prev === b.id ? null : b.id))
								}
								onToggleTag={toggleTag}
								onPatch={patchRow}
								onDeleteHighlight={deleteHighlight}
							/>
						))
					)}

					{noQuery && cursor !== null ? (
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
}: {
	archived: boolean;
	noQuery: boolean;
}) {
	const message = !noQuery
		? "No matches."
		: archived
			? "No archived bookmarks yet."
			: "Bookmarks will appear as you save them in Chrome — the initial backfill runs when the extension starts.";
	return (
		<p className="max-w-md px-4 py-6 font-mono text-xs text-muted-foreground">
			{message}
		</p>
	);
}

function hostOf(url: string): string | null {
	try {
		return new URL(url).hostname;
	} catch {
		return null;
	}
}

function Favicon({ host }: { host: string }) {
	const [broken, setBroken] = useState(false);
	if (broken) {
		return null;
	}
	return (
		// biome-ignore lint/performance/noImgElement: a tiny 32px favicon icon doesn't warrant next/image's overhead here.
		<img
			src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`}
			alt=""
			width={14}
			height={14}
			className="shrink-0 rounded-[2px]"
			onError={() => setBroken(true)}
		/>
	);
}

function LogRow({
	bookmark,
	archivedView,
	expanded,
	activeTags,
	onToggleExpand,
	onToggleTag,
	onPatch,
	onDeleteHighlight,
}: {
	bookmark: ApiBookmark;
	archivedView: boolean;
	expanded: boolean;
	activeTags: string[];
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
					"flex cursor-pointer items-center gap-2.5 border-b border-[oklch(0.945_0_0)] px-4 py-[5px] hover:bg-[oklch(0.972_0_0)]",
					expanded && "bg-[oklch(0.972_0_0)]",
				)}
			>
				<span
					aria-hidden
					className="w-2.5 shrink-0 font-mono text-[9px] text-[oklch(0.6_0_0)]"
				>
					{expanded ? "▾" : "▸"}
				</span>
				<span className="w-[88px] shrink-0 whitespace-nowrap font-mono text-[11px] text-muted-foreground">
					{formatTimestamp(new Date(bookmark.updatedAt))}
				</span>
				{host ? <Favicon host={host} /> : null}
				{host ? (
					<span className="hidden w-[148px] shrink-0 truncate font-mono text-[11px] text-muted-foreground md:block">
						{host}
					</span>
				) : null}
				<span className="min-w-0 flex-1 truncate text-[13px] font-medium">
					{bookmark.title || "(untitled)"}
				</span>
				{bookmark.highlights.length > 0 ? (
					<span className="shrink-0 rounded-full bg-[oklch(0.97_0_0)] px-[7px] py-px font-mono text-[10.5px] text-[var(--log-accent)]">
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
											? "bg-[var(--log-accent)] text-white"
											: "bg-[oklch(0.962_0_0)] text-[oklch(0.45_0_0)]",
									)}
								>
									{tag}
								</button>
							);
						})}
					</span>
				) : null}
				<button
					type="button"
					onClick={(e) => {
						e.stopPropagation();
						onPatch(bookmark.id, { archived: !archivedView });
					}}
					className="shrink-0 px-1 py-0.5 text-[11px] text-[oklch(0.7_0_0)] hover:text-foreground"
				>
					{archivedView ? "Restore" : "Archive"}
				</button>
			</div>
			{expanded ? (
				<ExpandedPanel
					bookmark={bookmark}
					onPatch={onPatch}
					onDeleteHighlight={onDeleteHighlight}
				/>
			) : null}
		</Fragment>
	);
}

function ExpandedPanel({
	bookmark,
	onPatch,
	onDeleteHighlight,
}: {
	bookmark: ApiBookmark;
	onPatch: PatchFn;
	onDeleteHighlight: (bookmarkId: number, highlightId: number) => Promise<void>;
}) {
	return (
		// The row above already draws the 1px rule (its border-b), so the panel
		// only draws its own bottom rule — a border-t here would double up.
		<div className="flex flex-col gap-2 border-b border-[oklch(0.945_0_0)] bg-[oklch(0.985_0_0)] pt-2.5 pr-4 pb-3.5 pl-11">
			<a
				href={bookmark.url}
				target="_blank"
				rel="noreferrer"
				className="max-w-[720px] truncate font-mono text-[11.5px] text-[var(--log-accent)] hover:underline"
			>
				{bookmark.url}
			</a>
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
			<div className="flex max-w-[720px] items-baseline gap-2">
				<span className="shrink-0 font-mono text-[10px] tracking-[0.08em] text-muted-foreground">
					TAGS
				</span>
				<EditableTags
					tags={bookmark.tags}
					onSave={(tags) => onPatch(bookmark.id, { tags })}
				/>
			</div>
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
		</div>
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
		<div className="flex max-w-[720px] items-start gap-2 rounded-md border border-[oklch(0.93_0_0)] bg-card px-2.5 py-[7px]">
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
				className="min-w-0 flex-1 text-[12.5px] leading-[1.55] text-[oklch(0.3_0_0)] hover:underline"
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

function EditableTags({
	tags,
	onSave,
}: {
	tags: string[];
	onSave: (next: string[]) => void;
}) {
	const [editing, setEditing] = useState(false);
	const [value, setValue] = useState(tags.join(", "));

	useEffect(() => {
		setValue(tags.join(", "));
	}, [tags]);

	function commit() {
		setEditing(false);
		const next = value
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean);
		const changed =
			next.length !== tags.length || next.some((t, i) => t !== tags[i]);
		if (changed) {
			onSave(next);
		}
	}

	if (editing) {
		return (
			<input
				// biome-ignore lint/a11y/noAutofocus: user just clicked the tags to edit — focus is expected.
				autoFocus
				value={value}
				onChange={(e) => setValue(e.target.value)}
				onBlur={commit}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						commit();
					} else if (e.key === "Escape") {
						e.preventDefault();
						setValue(tags.join(", "));
						setEditing(false);
					}
				}}
				placeholder="comma, separated, tags"
				className="w-full min-w-0 rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[11px] outline-none focus:border-[var(--log-accent)]"
			/>
		);
	}

	return (
		<button
			type="button"
			onClick={() => setEditing(true)}
			className="min-w-0 truncate text-left font-mono text-[11px] text-[oklch(0.45_0_0)] hover:underline"
			title="Click to edit tags"
		>
			{tags.length === 0 ? "add tags…" : tags.join(", ")}
		</button>
	);
}
