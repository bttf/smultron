"use client";
// One bookmark of the log view — the row itself, plus the expanded editor
// panel it mounts (SPEC §9). Extracted from feed.tsx as a pure move: this
// subtree renders and edits a SINGLE bookmark and talks to the Feed
// orchestrator only through props (the bookmark, a few view booleans, and
// the PATCH/DELETE callbacks) — it knows nothing of paging, search keys,
// facets, or the composer. `Favicon`/`hostOf` are exported for the pinned
// shelf's cards, which share the same presentation atoms.
//
// m22: the panel itself now lives in `bookmark-editor.tsx` — the shelf's `✎`
// opens the very same component, so it can't stay owned by the log row.
import { Fragment, useState } from "react";
import { cn } from "../lib/utils";
import {
	type ApiBookmark,
	BookmarkEditor,
	formatDate,
	formatTimestamp,
	type PatchFn,
} from "./bookmark-editor";

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
 * later (the fill landing on a poll, or m22 clearing a stale icon after a URL
 * edit) is tried without any state to reset.
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
	// m22: pinned rows are back in the feed log (SPEC §8/§9) — and a search has
	// always surfaced them — so the row itself has to say so. `?? null` guards
	// rows served before the m13 backend landed.
	const pinned = (bookmark.pinnedAt ?? null) !== null;

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
					{/* m22 pin marker: color-only state at the row's own type size,
					    immediately before the title (SPEC §9). */}
					{pinned ? (
						<span
							title="Pinned"
							className="shrink-0 text-[11px] text-[var(--log-accent)]"
						>
							★
						</span>
					) : null}
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
				<BookmarkEditor
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
