"use client";
// Feed + search UI — SPEC §9. Talks ONLY to /api/bookmarks* (Hard rule #2
// — never the DB directly). SWR polls page 1 every 10s; "Load more" appends
// further keyset pages as local state. Row edits (title/tags/archive) PATCH
// then reconcile local state — see the comment above `Feed` for the
// reconciliation model.
import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import { relativeTime } from "../lib/relativeTime";
import { cn } from "../lib/utils";

type ApiBookmark = {
	id: number;
	url: string;
	urlNormalized: string;
	title: string;
	tags: string[];
	createdAt: string;
	updatedAt: string;
	archivedAt: string | null;
};

type ListResponse = { bookmarks: ApiBookmark[]; nextCursor: string | null };

class FetchError extends Error {}

async function fetcher(url: string): Promise<ListResponse> {
	const res = await fetch(url);
	if (!res.ok) {
		throw new FetchError(`request failed (${res.status})`);
	}
	return res.json() as Promise<ListResponse>;
}

function buildUrl(q: string, archived: boolean, cursor?: string | null) {
	const params = new URLSearchParams();
	const trimmed = q.trim();
	if (trimmed) {
		params.set("q", trimmed);
	}
	if (archived) {
		params.set("archived", "1");
	}
	if (cursor) {
		params.set("cursor", cursor);
	}
	const qs = params.toString();
	return `/api/bookmarks${qs ? `?${qs}` : ""}`;
}

const DEBOUNCE_MS = 150;

export function Feed() {
	const [rawQuery, setRawQuery] = useState("");
	const [query, setQuery] = useState("");
	const [archived, setArchived] = useState(false);
	const searchInputRef = useRef<HTMLInputElement>(null);

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

	const key = buildUrl(query, archived);
	const { data, error, isLoading, mutate } = useSWR<ListResponse, Error>(
		key,
		fetcher,
		{ refreshInterval: 10_000 },
	);

	// Deeper pages, loaded via "Load more". Only page 1 (the SWR key above)
	// polls every 10s; appended pages are a point-in-time snapshot and don't
	// auto-refresh — documented simplification (SPEC §9 asks for a minimal
	// personal tool, not full pagination consistency).
	const [morePages, setMorePages] = useState<ApiBookmark[][]>([]);
	const [cursor, setCursor] = useState<string | null>(null);
	const [loadingMore, setLoadingMore] = useState(false);

	// Local overlays for row edits: `overrides` patches a row's fields after a
	// successful PATCH; `removed` drops a row that just left the current view
	// (archived here, or unarchived while looking at the archive).
	const [overrides, setOverrides] = useState<Map<number, Partial<ApiBookmark>>>(
		new Map(),
	);
	const [removed, setRemoved] = useState<Set<number>>(new Set());

	// Reset all paging/local-edit state whenever the query or the feed/archive
	// view changes (the SWR key, `key`, captures both). This follows React's
	// "adjusting state when a prop changes during render" pattern rather than
	// an effect, so the reset is visible in the very render that changed
	// `key` — no stale flash of the previous view's paging state.
	const prevKey = useRef(key);
	if (prevKey.current !== key) {
		prevKey.current = key;
		setMorePages([]);
		setCursor(null);
		setOverrides(new Map());
		setRemoved(new Set());
	}

	// Only sync `cursor` from the polled page 1 while no deeper page has been
	// loaded yet — once "Load more" has advanced past page 1, a background
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
		if (!cursor || loadingMore) {
			return;
		}
		setLoadingMore(true);
		try {
			const page = await fetcher(buildUrl(query, archived, cursor));
			setMorePages((pages) => [...pages, page.bookmarks]);
			setCursor(page.nextCursor);
		} catch {
			// Transient failure — "Load more" stays clickable to retry.
		} finally {
			setLoadingMore(false);
		}
	}

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
			// Archiving/unarchiving always moves the row out of whichever view
			// it's currently shown in.
			setRemoved((prev) => new Set(prev).add(id));
		} else {
			setOverrides((prev) => new Map(prev).set(id, updated));
		}
		// Background revalidate page 1; the 10s poll would eventually do this
		// anyway, but this makes the edit visible immediately on refresh.
		mutate();
	}

	const noQuery = query.trim().length === 0;

	return (
		<div className="flex flex-1 flex-col gap-4 p-6">
			<div className="flex flex-wrap items-center gap-3">
				<input
					ref={searchInputRef}
					type="search"
					value={rawQuery}
					onChange={(e) => setRawQuery(e.target.value)}
					placeholder="Search bookmarks…  (press / to focus)"
					className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none focus:ring-2 focus:ring-ring"
				/>
				<button
					type="button"
					onClick={() => setArchived((a) => !a)}
					className={cn(
						"shrink-0 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent",
						archived && "bg-accent",
					)}
				>
					{archived ? "Viewing archived" : "Archived"}
				</button>
			</div>

			{error ? (
				<p className="text-sm text-destructive">
					Couldn&apos;t load bookmarks: {error.message}
				</p>
			) : null}

			{isLoading ? (
				<p className="text-sm text-muted-foreground">Loading…</p>
			) : items.length === 0 ? (
				<EmptyState archived={archived} noQuery={noQuery} />
			) : (
				<ul className="flex flex-col gap-2">
					{items.map((b) => (
						<BookmarkCard
							key={b.id}
							bookmark={b}
							archivedView={archived}
							onPatch={patchRow}
						/>
					))}
				</ul>
			)}

			{cursor ? (
				<div>
					<button
						type="button"
						onClick={loadMore}
						disabled={loadingMore}
						className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
					>
						{loadingMore ? "Loading…" : "Load more"}
					</button>
				</div>
			) : null}
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
	if (!noQuery) {
		return <p className="text-sm text-muted-foreground">No matches.</p>;
	}
	if (archived) {
		return (
			<p className="text-sm text-muted-foreground">
				No archived bookmarks yet.
			</p>
		);
	}
	return (
		<p className="max-w-md text-sm text-muted-foreground">
			Bookmarks will appear as you save them in Chrome — the initial backfill
			runs when the extension starts.
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
			className="rounded-sm"
			onError={() => setBroken(true)}
		/>
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
				// biome-ignore lint/a11y/noAutofocus: user just clicked "edit" — focus is expected.
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
				className="w-full min-w-0 rounded border border-border bg-background px-1.5 py-0.5 text-sm font-medium"
			/>
		);
	}

	return (
		<button
			type="button"
			onClick={() => setEditing(true)}
			className="max-w-full truncate text-left font-medium hover:underline"
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
				// biome-ignore lint/a11y/noAutofocus: user just clicked "edit tags" — focus is expected.
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
				className="w-full min-w-0 rounded border border-border bg-background px-1.5 py-0.5 text-xs"
			/>
		);
	}

	return (
		<button
			type="button"
			onClick={() => setEditing(true)}
			className="flex flex-wrap items-center gap-1 text-left"
			title="Click to edit tags"
		>
			{tags.length === 0 ? (
				<span className="text-xs text-muted-foreground">Add tags…</span>
			) : (
				tags.map((tag) => (
					<span
						key={tag}
						className="rounded-full bg-secondary px-2 py-0.5 text-xs text-secondary-foreground"
					>
						{tag}
					</span>
				))
			)}
		</button>
	);
}

function BookmarkCard({
	bookmark,
	archivedView,
	onPatch,
}: {
	bookmark: ApiBookmark;
	archivedView: boolean;
	onPatch: (
		id: number,
		patch: { title?: string; tags?: string[]; archived?: boolean },
	) => Promise<void>;
}) {
	const host = hostOf(bookmark.url);

	return (
		<li className="flex flex-col gap-1.5 rounded-lg border border-border bg-card p-3">
			<div className="flex items-start justify-between gap-3">
				<a
					href={bookmark.url}
					target="_blank"
					rel="noreferrer"
					className="min-w-0 flex-1"
				>
					<EditableTitle
						title={bookmark.title}
						onSave={(title) => onPatch(bookmark.id, { title })}
					/>
				</a>
				<button
					type="button"
					onClick={() => onPatch(bookmark.id, { archived: !archivedView })}
					className="shrink-0 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
				>
					{archivedView ? "Unarchive" : "Archive"}
				</button>
			</div>

			<div className="flex items-center gap-1.5 text-xs text-muted-foreground">
				{host ? <Favicon host={host} /> : null}
				{host ? <span>{host}</span> : null}
				{host ? <span aria-hidden>·</span> : null}
				<span>{relativeTime(new Date(bookmark.updatedAt))}</span>
			</div>

			<EditableTags
				tags={bookmark.tags}
				onSave={(tags) => onPatch(bookmark.id, { tags })}
			/>
		</li>
	);
}
