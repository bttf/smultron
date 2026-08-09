"use client";
// m10 chip editor (+ m14 autocomplete) for the expanded row's TAGS line —
// SPEC §9. Every mutation (✕ remove, ⏎ add) is ONE PATCH of the full tags
// array via `onSave` — the returned row lands in the feed's `overrides` like
// any other edit, so there is no local tags state to drift; only the
// add-input draft (and its dropdown state) is local.
import { useId, useMemo, useRef, useState } from "react";
import { filterTagSuggestions } from "../lib/tagSuggestions";
import { cn } from "../lib/utils";

export function TagChips({
	tags,
	autoFocusInput,
	suggestions,
	onSave,
}: {
	tags: string[];
	/** m11: a bookmark just created via the composer opens ready to tag. */
	autoFocusInput: boolean;
	/** m14 autocomplete source: existing tags in usage order (the feed facets). */
	suggestions: string[];
	onSave: (next: string[]) => void;
}) {
	const [draft, setDraft] = useState("");
	// -1 = nothing highlighted, so Enter falls through to the raw draft.
	const [highlighted, setHighlighted] = useState(-1);
	// Open-ness is its own state, not "matches exist": Escape closes the
	// dropdown while KEEPING the draft, and blur closes it too (SPEC §9).
	const [open, setOpen] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const listId = useId();

	const matches = useMemo(
		() => filterTagSuggestions(suggestions, tags, draft),
		[suggestions, tags, draft],
	);
	const showList = open && matches.length > 0;
	// `matches` can shrink UNDER an open dropdown without a keystroke (the
	// `suggestions` prop follows the ~10s SWR poll; `tags` follows a PATCH), so
	// the stored index is clamped rather than trusted — Enter and
	// aria-activedescendant must never index past the end.
	const active = highlighted < matches.length ? highlighted : -1;
	const activeId = showList && active >= 0 ? `${listId}-${active}` : undefined;

	// The single add path (⏎ on the draft, ⏎ on a highlight, pointer select):
	// after ANY add the input clears, the dropdown closes and focus stays put.
	function addTag(value: string) {
		const next = value.trim();
		if (!next) {
			return;
		}
		setDraft("");
		setHighlighted(-1);
		setOpen(false);
		if (tags.includes(next)) {
			// Duplicate — nothing to add, but the input still clears so the
			// rejected text doesn't linger looking un-submitted.
			return;
		}
		onSave([...tags, next]);
	}

	return (
		<div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
			{tags.map((tag) => (
				<span
					key={tag}
					className="flex items-center gap-1 rounded bg-[var(--log-chip-bg)] px-[7px] py-[2px] font-mono text-[10.5px] text-[var(--log-chip-fg)]"
				>
					{tag}
					<button
						type="button"
						aria-label={`Remove tag ${tag}`}
						onClick={() => onSave(tags.filter((t) => t !== tag))}
						className="text-[10px] text-[var(--log-faint)] hover:text-[var(--log-note-fg)]"
					>
						✕
					</button>
				</span>
			))}
			{/* Anchor for the absolutely-positioned suggestion list below. */}
			<div className="relative">
				<input
					ref={inputRef}
					// biome-ignore lint/a11y/noAutofocus: only set right after the user added a bookmark via the composer — tagging is the expected next action.
					autoFocus={autoFocusInput}
					value={draft}
					role="combobox"
					aria-expanded={showList}
					aria-controls={listId}
					aria-activedescendant={activeId}
					aria-autocomplete="list"
					aria-label="Add tag"
					onChange={(e) => {
						// Typing refilters and resets the highlight to none.
						setDraft(e.target.value);
						setHighlighted(-1);
						setOpen(true);
					}}
					onBlur={() => {
						setOpen(false);
						setHighlighted(-1);
					}}
					onKeyDown={(e) => {
						if (e.key === "ArrowDown" && showList) {
							// From none → first; wraps at the end.
							e.preventDefault();
							setHighlighted((active + 1) % matches.length);
						} else if (e.key === "ArrowUp" && showList) {
							// From none → last; wraps at the start.
							e.preventDefault();
							setHighlighted(active <= 0 ? matches.length - 1 : active - 1);
						} else if (e.key === "Enter") {
							e.preventDefault();
							addTag(showList && active >= 0 ? matches[active] : draft);
						} else if (e.key === "Escape") {
							e.preventDefault();
							if (showList) {
								// Close the dropdown first, keeping the draft; a
								// second Escape clears it as before.
								setOpen(false);
								setHighlighted(-1);
							} else {
								setDraft("");
								e.currentTarget.blur();
							}
						}
					}}
					placeholder="add tag ⏎"
					className="w-[84px] rounded border border-dashed border-[var(--log-dash)] px-[7px] py-px font-mono text-[10.5px] text-[var(--log-fg)] outline-none focus:border-solid focus:border-[var(--log-accent)]"
				/>
				{showList ? (
					<div
						id={listId}
						role="listbox"
						className="absolute top-[calc(100%+2px)] left-0 z-20 max-h-[152px] min-w-[128px] overflow-y-auto rounded border border-[var(--log-dash)] bg-[var(--log-panel)] py-px shadow-md"
					>
						{matches.map((tag, i) => (
							<button
								key={tag}
								id={`${listId}-${i}`}
								type="button"
								role="option"
								aria-selected={i === active}
								tabIndex={-1}
								// mousedown (not click) so the add commits BEFORE the
								// input blurs and closes the list.
								onMouseDown={(e) => {
									e.preventDefault();
									addTag(tag);
									inputRef.current?.focus();
								}}
								className={cn(
									"block w-full truncate px-2 py-px text-left font-mono text-[10.5px] text-[var(--log-fg)]",
									i === active
										? "bg-[var(--log-facet-active)]"
										: "hover:bg-[var(--log-soft)]",
								)}
							>
								{tag}
							</button>
						))}
					</div>
				) : null}
			</div>
		</div>
	);
}
