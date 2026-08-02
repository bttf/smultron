"use client";
// Read-aloud section of the expanded row — SPEC §9/§10.
//
// Talks ONLY to /api/bookmarks/:id/article* (Hard rule #2). Mounted lazily:
// ExpandedPanel renders it only for the open row, so no article is fetched
// for rows the user never expands.
//
// While a run is in flight the article GET is polled; once terminal, polling
// stops. Audio is fetched on demand per kind and cached server-side, so the
// second press of a play button is immediate.
import { useCallback, useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { cn } from "../lib/utils";

type ArticleStatus =
	| "queued"
	| "scraping"
	| "cleaning"
	| "summarizing"
	| "ready"
	| "failed";

type AudioKind = "summary" | "transcript";

type ApiArticle = {
	id: number;
	bookmarkId: number;
	status: ArticleStatus;
	error: string | null;
	sourceUrl: string | null;
	title: string | null;
	transcript: string | null;
	summary: string | null;
	wordCount: number | null;
	audioKinds: AudioKind[];
	createdAt: string;
	updatedAt: string;
};

type ArticleResponse = { article: ApiArticle | null };

type AudioResponse = {
	kind: AudioKind;
	voice: string;
	url: string;
	expiresAt: string;
	byteSize: number;
	segmentCount: number;
	cached: boolean;
};

/** Terminal statuses — nothing more will happen without a new run. */
const TERMINAL: ReadonlySet<ArticleStatus> = new Set(["ready", "failed"]);

/** What each in-flight status is actually doing, in the user's terms. */
const PROGRESS_LABEL: Record<ArticleStatus, string> = {
	queued: "queued",
	scraping: "fetching the page",
	cleaning: "cleaning up the text",
	summarizing: "writing the summary",
	ready: "ready",
	failed: "failed",
};

const POLL_MS = 2000;

async function fetchArticle(url: string): Promise<ArticleResponse> {
	const res = await fetch(url);
	if (!res.ok) {
		throw new Error(`request failed (${res.status})`);
	}
	return res.json() as Promise<ArticleResponse>;
}

const LABEL_CLASS =
	"shrink-0 font-mono text-[10px] tracking-[0.08em] text-muted-foreground";

/** Small mono button, matching the panel's existing note/tag affordances. */
function PanelButton({
	children,
	onClick,
	disabled,
	tone = "default",
}: {
	children: React.ReactNode;
	onClick: () => void;
	disabled?: boolean;
	tone?: "default" | "accent";
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			className={cn(
				"rounded border px-2 py-[3px] font-mono text-[10.5px] tracking-[0.04em] transition-colors disabled:cursor-not-allowed disabled:opacity-50",
				tone === "accent"
					? "border-transparent bg-[var(--log-accent-solid)] text-white hover:bg-[var(--log-accent-solid-hover)]"
					: "border-[var(--log-strong-border)] text-[var(--log-fg)] hover:bg-[var(--log-soft)]",
			)}
		>
			{children}
		</button>
	);
}

export function ArticleSection({ bookmarkId }: { bookmarkId: number }) {
	const key = `/api/bookmarks/${bookmarkId}/article`;

	// `pollUntilTerminal` keeps polling after a POST even before the first
	// response lands, so the status line starts moving immediately.
	const [expectRun, setExpectRun] = useState(false);
	const [starting, setStarting] = useState(false);
	const [startError, setStartError] = useState<string | null>(null);

	const { data, error, isLoading, mutate } = useSWR<ArticleResponse>(
		key,
		fetchArticle,
		{
			refreshInterval: (latest) => {
				const status = latest?.article?.status;
				if (!status) {
					return expectRun ? POLL_MS : 0;
				}
				return TERMINAL.has(status) ? 0 : POLL_MS;
			},
			revalidateOnFocus: false,
		},
	);

	const article = data?.article ?? null;
	const running = article !== null && !TERMINAL.has(article.status);

	// Once a terminal state lands, stop forcing polling on.
	useEffect(() => {
		if (article && TERMINAL.has(article.status)) {
			setExpectRun(false);
		}
	}, [article]);

	const start = useCallback(
		async (refresh: boolean) => {
			setStarting(true);
			setStartError(null);
			setExpectRun(true);
			try {
				const res = await fetch(key, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(refresh ? { refresh: true } : {}),
				});
				if (!res.ok) {
					throw new Error(`could not start (${res.status})`);
				}
				const body = (await res.json()) as {
					article: ApiArticle | null;
					started: boolean;
				};
				await mutate({ article: body.article }, { revalidate: false });
			} catch (cause) {
				setExpectRun(false);
				setStartError(
					cause instanceof Error ? cause.message : "could not start",
				);
			} finally {
				setStarting(false);
			}
		},
		[key, mutate],
	);

	return (
		<div className="flex max-w-[720px] flex-col gap-2">
			<div className="flex items-center gap-2">
				<span className={LABEL_CLASS}>READ ALOUD</span>
				{article?.status === "ready" && article.wordCount ? (
					<span className="font-mono text-[10px] text-[var(--log-faint)]">
						{article.wordCount.toLocaleString()} words
					</span>
				) : null}
				{article?.status === "ready" ? (
					<button
						type="button"
						onClick={() => start(true)}
						disabled={starting}
						className="ml-auto font-mono text-[10px] text-[var(--log-faint)] hover:text-[var(--log-fg)] disabled:opacity-50"
					>
						re-scrape
					</button>
				) : null}
			</div>

			{error ? (
				<span className="font-mono text-[11px] text-destructive">
					could not load the article
				</span>
			) : isLoading ? (
				<span className="font-mono text-[11px] text-[var(--log-faint)]">
					checking…
				</span>
			) : article === null ? (
				<div className="flex items-center gap-2">
					<PanelButton onClick={() => start(false)} disabled={starting}>
						{starting ? "starting…" : "scrape & prepare audio"}
					</PanelButton>
					<span className="font-mono text-[10px] text-[var(--log-faint)]">
						fetches the page, cleans it up, writes a summary
					</span>
				</div>
			) : running ? (
				<RunningState status={article.status} />
			) : article.status === "failed" ? (
				<FailedState
					message={article.error}
					onRetry={() => start(false)}
					onRescrape={() => start(true)}
					disabled={starting}
				/>
			) : (
				<ReadyState bookmarkId={bookmarkId} article={article} />
			)}

			{startError ? (
				<span className="font-mono text-[11px] text-destructive">
					{startError}
				</span>
			) : null}
		</div>
	);
}

function RunningState({ status }: { status: ArticleStatus }) {
	return (
		<div className="flex items-center gap-2">
			<span
				aria-hidden
				className="size-1.5 animate-pulse rounded-full bg-[var(--log-accent)]"
			/>
			<span className="font-mono text-[11px] text-[var(--log-fg)]">
				{PROGRESS_LABEL[status]}…
			</span>
		</div>
	);
}

function FailedState({
	message,
	onRetry,
	onRescrape,
	disabled,
}: {
	message: string | null;
	onRetry: () => void;
	onRescrape: () => void;
	disabled: boolean;
}) {
	return (
		<div className="flex flex-col gap-1.5">
			<span className="font-mono text-[11px] text-destructive">
				{message ?? "the article could not be prepared"}
			</span>
			<div className="flex items-center gap-2">
				{/* Retry resumes from the last completed step; re-scrape starts over. */}
				<PanelButton onClick={onRetry} disabled={disabled}>
					try again
				</PanelButton>
				<PanelButton onClick={onRescrape} disabled={disabled}>
					start over
				</PanelButton>
			</div>
		</div>
	);
}

function ReadyState({
	bookmarkId,
	article,
}: {
	bookmarkId: number;
	article: ApiArticle;
}) {
	const [showTranscript, setShowTranscript] = useState(false);

	return (
		<div className="flex flex-col gap-2.5">
			{article.summary ? (
				<div className="rounded-md border border-[var(--log-card-border)] bg-card px-2.5 py-2 text-[12.5px] leading-[1.6] text-[var(--log-fg)] whitespace-pre-wrap">
					{article.summary}
				</div>
			) : null}

			<Player bookmarkId={bookmarkId} article={article} />

			{article.transcript ? (
				<div className="flex flex-col gap-1.5">
					<button
						type="button"
						onClick={() => setShowTranscript((open) => !open)}
						className="self-start font-mono text-[10px] tracking-[0.04em] text-[var(--log-faint)] hover:text-[var(--log-fg)]"
					>
						{showTranscript ? "hide transcript ▴" : "show transcript ▾"}
					</button>
					{showTranscript ? (
						<div className="max-h-[420px] overflow-y-auto rounded-md border border-[var(--log-card-border)] bg-card px-2.5 py-2 text-[12.5px] leading-[1.65] text-[var(--log-fg)] whitespace-pre-wrap">
							{article.transcript}
						</div>
					) : null}
				</div>
			) : null}
		</div>
	);
}

/**
 * Fetches a signed audio URL per kind on demand and plays it.
 *
 * The URL is held in component state rather than SWR: it is a one-shot
 * side-effecting POST (it may synthesize), not a cacheable read, and re-
 * fetching it on focus would re-sign needlessly.
 */
function Player({
	bookmarkId,
	article,
}: {
	bookmarkId: number;
	article: ApiArticle;
}) {
	const [urls, setUrls] = useState<Partial<Record<AudioKind, string>>>({});
	const [active, setActive] = useState<AudioKind | null>(null);
	const [pending, setPending] = useState<AudioKind | null>(null);
	const [audioError, setAudioError] = useState<string | null>(null);
	const audioRef = useRef<HTMLAudioElement | null>(null);

	// A re-scrape invalidates any URL we hold: the text behind it changed.
	// biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the run's updatedAt, which is exactly the "content changed" signal.
	useEffect(() => {
		setUrls({});
		setActive(null);
		setAudioError(null);
	}, [article.updatedAt]);

	const play = useCallback(
		async (kind: AudioKind) => {
			setAudioError(null);

			const existing = urls[kind];
			if (existing) {
				setActive(kind);
				return;
			}

			setPending(kind);
			try {
				const res = await fetch(`/api/bookmarks/${bookmarkId}/article/audio`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ kind }),
				});
				if (!res.ok) {
					const detail = (await res.json().catch(() => null)) as {
						detail?: string;
					} | null;
					throw new Error(detail?.detail ?? `audio failed (${res.status})`);
				}
				const body = (await res.json()) as AudioResponse;
				setUrls((current) => ({ ...current, [kind]: body.url }));
				setActive(kind);
			} catch (cause) {
				setAudioError(
					cause instanceof Error ? cause.message : "could not prepare audio",
				);
			} finally {
				setPending(null);
			}
		},
		[bookmarkId, urls],
	);

	// Autoplay once a newly-fetched source is attached. Browsers allow this
	// because the chain started with the user's click on a play button.
	// biome-ignore lint/correctness/useExhaustiveDependencies: must re-run when the active source changes, not on every render.
	useEffect(() => {
		if (active && audioRef.current) {
			audioRef.current.play().catch(() => {
				// Autoplay blocked — the visible controls still work.
			});
		}
	}, [active, urls]);

	const activeUrl = active ? urls[active] : undefined;

	return (
		<div className="flex flex-col gap-2">
			<div className="flex flex-wrap items-center gap-2">
				<PanelButton
					onClick={() => play("summary")}
					disabled={pending !== null || !article.summary}
					tone={active === "summary" ? "accent" : "default"}
				>
					{pending === "summary" ? "preparing…" : "▸ listen to summary"}
				</PanelButton>
				<PanelButton
					onClick={() => play("transcript")}
					disabled={pending !== null || !article.transcript}
					tone={active === "transcript" ? "accent" : "default"}
				>
					{pending === "transcript" ? "preparing…" : "▸ listen to full article"}
				</PanelButton>
				{pending === "transcript" ? (
					<span className="font-mono text-[10px] text-[var(--log-faint)]">
						first time takes a moment
					</span>
				) : null}
			</div>

			{activeUrl ? (
				// `key` forces a fresh element when the source changes, so the
				// browser reloads instead of keeping the old buffered audio.
				<audio
					key={activeUrl}
					ref={audioRef}
					controls
					preload="auto"
					src={activeUrl}
					className="h-8 w-full max-w-[420px]"
				>
					<track kind="captions" />
				</audio>
			) : null}

			{audioError ? (
				<span className="font-mono text-[11px] text-destructive">
					{audioError}
				</span>
			) : null}
		</div>
	);
}
