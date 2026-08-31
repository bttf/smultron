"use client";
// The expanded editor panel for ONE bookmark — URL line, title, tags, note,
// article section, highlights, pin/archive (SPEC §9) — plus the leaf editors
// only it uses. Extracted from `log-row.tsx` in m22 as a pure move: since the
// pinned shelf's `✎` opens the very same panel beneath the shelf grid, the
// panel can no longer live inside the log row that used to be its only mount
// point.
//
// It also owns the shared bookmark shape and the log's timestamp formatters,
// so the dependency runs ONE way (`feed` → `log-row` → here) with no import
// cycle. Like `LogRow`, this subtree talks to the Feed orchestrator only
// through props: the bookmark and the PATCH/DELETE callbacks.
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
	// m13: null = not pinned. Pinned rows are the shelf; since m22 they ALSO
	// render in the feed log like any other row, marked by the `★` below.
	pinnedAt: string | null;
	highlights: ApiHighlight[];
};

export type PatchFn = (
	id: number,
	patch: {
		// m22: the ONE way to correct a bookmark's URL (SPEC §8). Rejected with
		// `DuplicateUrlError` when the new key already belongs to another row.
		url?: string;
		title?: string;
		tags?: string[];
		note?: string;
		archived?: boolean;
		pinned?: boolean;
	},
) => Promise<void>;

/**
 * m22: a `409 duplicate_url` from `PATCH /api/bookmarks/:id` (SPEC §8) — the
 * URL the user typed already belongs to another of their rows and NOTHING was
 * written. Thrown by the Feed's `patchRow` so the URL editor can name the
 * conflicting bookmark instead of showing a bare failure.
 *
 * `conflict` is the row that owns the URL; null only in the narrow race where
 * the server couldn't read it back.
 */
export class DuplicateUrlError extends Error {
	readonly conflict: { id: number; title: string; url: string } | null;

	constructor(conflict: { id: number; title: string; url: string } | null) {
		super("duplicate url");
		this.name = "DuplicateUrlError";
		this.conflict = conflict;
	}
}

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
export function formatTimestamp(date: Date, now: Date = new Date()): string {
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
export function formatDate(date: Date, now: Date = new Date()): string {
	const base = `${MONTHS[date.getMonth()]} ${date.getDate()}`;
	return date.getFullYear() !== now.getFullYear()
		? `${base} ${date.getFullYear()}`
		: base;
}

export function BookmarkEditor({
	bookmark,
	archivedView,
	autoFocusTags,
	tagSuggestions,
	onPatch,
	onDeleteHighlight,
	className,
}: {
	bookmark: ApiBookmark;
	archivedView: boolean;
	autoFocusTags: boolean;
	tagSuggestions: string[];
	onPatch: PatchFn;
	onDeleteHighlight: (bookmarkId: number, highlightId: number) => Promise<void>;
	/**
	 * m22: the ONE thing the two mount points differ on — the log indents the
	 * panel past its gutter (`pl-11`), the shelf runs it full-width (`pl-4`).
	 */
	className?: string;
}) {
	return (
		// Under a log row the row above already draws the 1px rule (its
		// border-b), so the panel only draws its own bottom rule — a border-t
		// here would double up. Under the shelf the grid plays that part.
		<div
			className={cn(
				"flex flex-col gap-2 border-b border-[var(--log-rule)] bg-[var(--log-panel)] pt-2.5 pr-4 pb-3.5 pl-11",
				className,
			)}
		>
			<EditableUrl
				url={bookmark.url}
				onSave={(url) => onPatch(bookmark.id, { url })}
			/>
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
			    omits them to stay compact across all viewports. The label reads
			    off the row itself: since m22 a pinned row is in the log too, and
			    the panel opened from a shelf card always reads "Unpin". */}
			<div className="flex gap-1.5">
				<button
					type="button"
					onClick={() =>
						// `?? null` guards rows served before the m13 backend
						// landed (same as the note preview on the row).
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

// m22 URL editing (SPEC §9). The link-out line gains a `✎` beside the copy
// button — the link itself must stay a link, so the affordance is a sibling
// rather than the title's click-anywhere-to-edit. Editing mirrors the
// composer: scheme-less input gets https:// prepended, then must parse with a
// dotted hostname, and the same inline mono "not a valid URL" is shown. The
// server re-validates identically (SPEC §8).
//
// A save can FAIL in a way the user has to read (409 duplicate_url names the
// row that already owns the URL), so — unlike the title editor — blur doesn't
// close this one: the input stays open with its error and `esc` cancels.
function EditableUrl({
	url,
	onSave,
}: {
	url: string;
	onSave: (next: string) => Promise<void>;
}) {
	const [editing, setEditing] = useState(false);
	const [value, setValue] = useState(url);
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	useEffect(() => {
		// Same rule as the title editor: track a fresher server URL only while
		// not editing, so a poll landing mid-edit can't replace keystrokes.
		if (!editing) {
			setValue(url);
		}
	}, [url, editing]);

	function cancel() {
		setValue(url);
		setError(null);
		setEditing(false);
	}

	async function save() {
		if (saving) {
			return;
		}
		let raw = value.trim();
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
			setError("not a valid URL");
			return;
		}
		if (raw === url) {
			// Nothing to save — close rather than spend a PATCH on a no-op.
			cancel();
			return;
		}
		setSaving(true);
		try {
			await onSave(raw);
			setError(null);
			setEditing(false);
		} catch (err) {
			setError(
				err instanceof DuplicateUrlError
					? err.conflict
						? `already saved as “${err.conflict.title || err.conflict.url}”`
						: "already saved as another bookmark"
					: "couldn't save URL",
			);
		} finally {
			setSaving(false);
		}
	}

	if (editing) {
		return (
			<div className="flex max-w-[720px] items-center gap-1.5">
				<input
					// biome-ignore lint/a11y/noAutofocus: user just clicked ✎ to edit the URL — focus is expected.
					autoFocus
					type="text"
					value={value}
					spellCheck={false}
					// readOnly, not disabled: a disabled input loses focus, and
					// after a 409 the user is left staring at an error with no
					// caret in the field they have to fix.
					readOnly={saving}
					aria-label="Bookmark URL"
					onChange={(e) => {
						setValue(e.target.value);
						setError(null);
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							void save();
						} else if (e.key === "Escape") {
							e.preventDefault();
							cancel();
						}
					}}
					className="min-w-0 flex-1 rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[11.5px] outline-none focus:border-[var(--log-accent)]"
				/>
				{error ? (
					<span className="shrink-0 font-mono text-[11px] text-destructive">
						{error}
					</span>
				) : null}
				<button
					type="button"
					onClick={cancel}
					className="shrink-0 px-1 py-0.5 text-[11px] text-[var(--log-faint)] hover:text-foreground"
				>
					esc
				</button>
			</div>
		);
	}

	return (
		<div className="flex max-w-[720px] items-center gap-1.5">
			<a
				href={url}
				target="_blank"
				rel="noreferrer"
				className="min-w-0 truncate font-mono text-[11.5px] text-[var(--log-accent)] hover:underline"
			>
				{url}
			</a>
			<CopyUrlButton url={url} />
			<button
				type="button"
				onClick={() => {
					setValue(url);
					setError(null);
					setEditing(true);
				}}
				aria-label="Edit URL"
				title="Edit URL"
				className="shrink-0 font-mono text-[11px] leading-none text-[var(--log-faint)] hover:text-[var(--log-accent)]"
			>
				✎
			</button>
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

// m10 NOTE section. The editor state lives here in the panel — only one panel
// is open at a time (m22: across the shelf AND the log), so collapsing or
// switching rows unmounts (and discards) any in-progress draft by
// construction. Save always PATCHes the trimmed draft; trimmed-empty means
// delete (server nulls the note, and the returned row in `overrides` flips
// this back to the SET NOTES state).
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
