"use client";
// One bookmark of the log view — the row, its expanded panel, and the leaf
// editors only they use (SPEC §9). Extracted from feed.tsx as a pure move:
// this subtree renders and edits a SINGLE bookmark and talks to the Feed
// orchestrator only through props (the bookmark, a few view booleans, and
// the PATCH/DELETE callbacks) — it knows nothing of paging, search keys,
// facets, or the composer. `Favicon`/`hostOf` are exported for the pinned
// shelf's cards, which share the same presentation atoms.
import { Fragment, useEffect, useRef, useState } from "react";
import { relativeTime } from "../lib/relativeTime";
import { textFragmentUrl } from "../lib/textFragment";
import { cn } from "../lib/utils";
import { ArticleSection } from "./article";
import { TagChips } from "./tag-chips";

export type ApiHighlight = {
	id: number;
	text: string;
	createdAt: string;
};

export type ApiBookmark = {
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

export type PatchFn = (
	id: number,
	patch: {
		title?: string;
		tags?: string[];
		note?: string;
		archived?: boolean;
		pinned?: boolean;
	},
) => Promise<void>;

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

export function hostOf(url: string): string | null {
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
export function Favicon({ host, src }: { host: string; src?: string | null }) {
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

export function LogRow({
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
	 * m18 (SPEC §9): the §5 metadata fill status for this freshly added row.
	 * "loading" shows an explicit spinner chip ("fetching page info…") in the
	 * note-preview slot; "failed" (the fill's deadline passed) shows a timed
	 * destructive notice instead. Title and favicon render normally either
	 * way — the hostname title and fallback icon are honest content, the chip
	 * is the affordance. The row stays fully interactive; the expanded panel
	 * shows no chip at all.
	 */
	enriching: "loading" | "failed" | false;
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
				{host ? <Favicon host={host} src={bookmark.faviconUrl} /> : null}
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
					<span className="min-w-0 shrink truncate text-[13px] font-medium">
						{bookmark.title || "(untitled)"}
					</span>
					{/* Enriching (m18): an explicit status chip takes the note
					    preview's slot while the §5 fill is out — a spinner while
					    loading, a timed destructive notice once the deadline
					    decides the fill isn't coming. `role="status"` so screen
					    readers hear the transition too. */}
					{enriching ? (
						<span
							role="status"
							className={cn(
								"flex shrink-0 items-center gap-1.5 font-mono text-[11px]",
								enriching === "loading"
									? "text-[var(--log-accent)]"
									: "text-destructive",
							)}
						>
							{enriching === "loading" ? (
								<Fragment>
									<span
										aria-hidden
										className="h-[10px] w-[10px] animate-spin rounded-full border border-[var(--log-accent)] border-t-transparent"
									/>
									fetching page info…
								</Fragment>
							) : (
								<Fragment>
									<span aria-hidden>✗</span>
									couldn&apos;t fetch page info
								</Fragment>
							)}
						</span>
					) : (bookmark.note ?? null) !== null ? (
						<span className="min-w-0 flex-1 basis-0 truncate text-[12.5px] text-muted-foreground">
							— {(bookmark.note as string).replace(/\s+/g, " ")}
						</span>
					) : null}
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
		// Sync the draft to a fresher server title ONLY while not editing —
		// since m18 the metadata fill routinely lands seconds after the panel
		// auto-expands, and it must never replace keystrokes in progress (the
		// server-side mid-flight guard protects the save; this protects the
		// draft).
		if (!editing) {
			setValue(title);
		}
	}, [title, editing]);

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
