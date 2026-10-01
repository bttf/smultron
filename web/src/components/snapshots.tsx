"use client";
// Page snapshots on the site (m25, SPEC §17.9): the expanded panel's
// SNAPSHOTS section and the `/snapshots/:id` view. Talks ONLY to
// /api/snapshots* (Hard rule #2). Asset URLs are signed by the server per
// response (the bucket is private, SPEC §17.3); nothing here builds a Storage
// URL beyond appending Supabase's `download` parameter to a signed one.
//
// The markdown is the primary export — it gets pasted into LLM prompts — so
// "Copy markdown" is the first action everywhere it appears.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { formatTimestamp } from "../lib/logTime";
import { relativeTime } from "../lib/relativeTime";
import { cn } from "../lib/utils";

export type ApiSnapshotSummary = {
	id: number;
	bookmarkId: number;
	url: string;
	title: string;
	adapterId: string;
	adapterVersion: string;
	status: "uploading" | "complete";
	capturedAt: string;
	createdAt: string;
	markdownChars: number;
	screenshotCount: number;
};

type ApiSnapshotAsset = {
	kind: "screenshot" | "html" | "data";
	idx: number;
	path: string;
	mime: string;
	byteSize: number;
	width?: number;
	height?: number;
	/** Signed read URL (6 h), or null when the object could not be signed. */
	url: string | null;
	expiresAt: string | null;
};

type ApiSnapshot = ApiSnapshotSummary & {
	markdown: string;
	metadata: Record<string, unknown>;
	assets: ApiSnapshotAsset[];
};

class HttpError extends Error {
	readonly status: number;

	constructor(status: number) {
		super(`request failed (${status})`);
		this.status = status;
	}
}

async function getJson<T>(url: string): Promise<T> {
	const res = await fetch(url);
	if (!res.ok) {
		throw new HttpError(res.status);
	}
	return res.json() as Promise<T>;
}

async function fetchSnapshot(id: number): Promise<ApiSnapshot> {
	const body = await getJson<{ snapshot: ApiSnapshot }>(`/api/snapshots/${id}`);
	return body.snapshot;
}

/**
 * Display names for the adapters the extension ships (SPEC §17.5). The site
 * only sees the stored id; an id it does not know shows as itself.
 */
const ADAPTER_NAMES: Record<string, string> = {
	"reddit-post": "Reddit post",
	generic: "Generic",
};

export function adapterName(id: string): string {
	return ADAPTER_NAMES[id] ?? id;
}

function chars(n: number): string {
	return `${n.toLocaleString()} chars`;
}

const LABEL_CLASS =
	"shrink-0 font-mono text-[10px] tracking-[0.08em] text-muted-foreground";

/**
 * Clipboard write with the brief "Copied" confirmation (SPEC §17.9).
 * `getText` may fetch; a failure (network or clipboard) shows "Couldn't copy"
 * instead of lying with a checkmark.
 */
function useCopy(getText: () => Promise<string>) {
	const [state, setState] = useState<"idle" | "busy" | "copied" | "failed">(
		"idle",
	);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const mounted = useRef(true);

	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			if (timer.current) {
				clearTimeout(timer.current);
			}
		};
	}, []);

	async function copy() {
		if (state === "busy") {
			return;
		}
		setState("busy");
		let next: "copied" | "failed";
		try {
			await navigator.clipboard.writeText(await getText());
			next = "copied";
		} catch {
			next = "failed";
		}
		if (!mounted.current) {
			return;
		}
		setState(next);
		if (timer.current) {
			clearTimeout(timer.current);
		}
		timer.current = setTimeout(() => setState("idle"), 1500);
	}

	return { state, copy };
}

function CopyMarkdownButton({
	getText,
	size = "small",
}: {
	getText: () => Promise<string>;
	size?: "small" | "large";
}) {
	const { state, copy } = useCopy(getText);
	return (
		<button
			type="button"
			onClick={copy}
			disabled={state === "busy"}
			aria-live="polite"
			className={cn(
				"shrink-0 rounded border border-transparent bg-[var(--log-accent-solid)] font-medium text-white hover:bg-[var(--log-accent-solid-hover)] disabled:opacity-70",
				size === "large"
					? "rounded-md px-3.5 py-1.5 text-[12.5px]"
					: "px-2 py-[3px] font-mono text-[10.5px] tracking-[0.04em]",
			)}
		>
			{state === "copied"
				? "✓ Copied"
				: state === "failed"
					? "Couldn't copy"
					: state === "busy"
						? "Copying…"
						: "Copy markdown"}
		</button>
	);
}

/** The cap the panel asks for; a bookmark with more shows the newest ones. */
const PANEL_LIMIT = 100;

/**
 * The expanded panel's SNAPSHOTS section (SPEC §17.9). Mounted only for the
 * open row — and only when the row reports at least one snapshot — so
 * collapsed rows never fetch. A changed `snapshotCount` (a capture landing
 * while the panel is open) refetches the list.
 */
export function SnapshotsSection({
	bookmarkId,
	snapshotCount,
}: {
	bookmarkId: number;
	snapshotCount: number;
}) {
	const key = `/api/snapshots?bookmarkId=${bookmarkId}&limit=${PANEL_LIMIT}`;
	const { data, error, mutate } = useSWR<{
		snapshots: ApiSnapshotSummary[];
		nextCursor: string | null;
	}>(key, getJson, { revalidateOnFocus: false });

	// The count is the "list changed" signal. Skip the mount, where SWR is
	// already fetching.
	const seenCount = useRef(snapshotCount);
	useEffect(() => {
		if (seenCount.current !== snapshotCount) {
			seenCount.current = snapshotCount;
			void mutate();
		}
	}, [snapshotCount, mutate]);

	return (
		<div className="flex max-w-[720px] flex-col gap-1.5">
			<span className={LABEL_CLASS}>SNAPSHOTS ({snapshotCount})</span>
			{!data && error ? (
				<span className="font-mono text-[11px] text-destructive">
					could not load snapshots
				</span>
			) : !data ? (
				<span className="font-mono text-[11px] text-[var(--log-faint)]">
					loading…
				</span>
			) : (
				<div className="flex flex-col">
					{data.snapshots.map((snapshot) => (
						<SnapshotLine key={snapshot.id} snapshot={snapshot} />
					))}
					{data.nextCursor ? (
						<span className="pt-1 font-mono text-[10px] text-[var(--log-faint)]">
							showing the {PANEL_LIMIT} most recent
						</span>
					) : null}
				</div>
			)}
		</div>
	);
}

function SnapshotLine({ snapshot }: { snapshot: ApiSnapshotSummary }) {
	const captured = new Date(snapshot.capturedAt);
	return (
		<div className="flex items-center gap-2.5 border-b border-[var(--log-rule)] py-1 last:border-b-0">
			<span
				className="w-[88px] shrink-0 whitespace-nowrap font-mono text-[11px] text-muted-foreground"
				title={captured.toLocaleString()}
			>
				{formatTimestamp(captured)}
			</span>
			<span className="min-w-0 truncate text-[12px] text-[var(--log-fg)]">
				{adapterName(snapshot.adapterId)}
			</span>
			{/* Dropped on a phone-width panel, where the buttons need the room. */}
			<span className="hidden shrink-0 font-mono text-[10.5px] text-[var(--log-faint)] sm:inline">
				{chars(snapshot.markdownChars)}
			</span>
			{snapshot.status === "uploading" ? (
				<span
					title="The extension never finished uploading this snapshot's files"
					className="shrink-0 font-mono text-[10.5px] text-destructive"
				>
					incomplete
				</span>
			) : null}
			<span className="ml-auto flex shrink-0 items-center gap-2">
				<CopyMarkdownButton
					getText={async () => (await fetchSnapshot(snapshot.id)).markdown}
				/>
				<a
					href={`/snapshots/${snapshot.id}`}
					target="_blank"
					rel="noreferrer"
					className="rounded border border-[var(--log-strong-border)] px-2 py-[3px] font-mono text-[10.5px] tracking-[0.04em] text-[var(--log-fg)] hover:bg-[var(--log-soft)]"
				>
					Open
				</a>
			</span>
		</div>
	);
}

/**
 * `/snapshots/:id` (SPEC §17.9). Fetched once: asset URLs are signed per
 * response, so revalidating would hand every tile a fresh URL and reload the
 * images for nothing.
 */
export function SnapshotView({ id }: { id: number }) {
	const { data, error } = useSWR<ApiSnapshot>(
		["snapshot", id],
		() => fetchSnapshot(id),
		{
			revalidateOnFocus: false,
			revalidateOnReconnect: false,
			revalidateIfStale: false,
		},
	);

	if (!data && error) {
		return (
			<p className="font-mono text-[12px] text-muted-foreground">
				{error instanceof HttpError && error.status === 404
					? "Snapshot not found."
					: "Could not load the snapshot."}{" "}
				<Link href="/" className="text-[var(--log-accent)] hover:underline">
					Back to the feed
				</Link>
			</p>
		);
	}
	if (!data) {
		return (
			<p className="font-mono text-[12px] text-[var(--log-faint)]">loading…</p>
		);
	}
	return <SnapshotDocument snapshot={data} />;
}

function SnapshotDocument({ snapshot }: { snapshot: ApiSnapshot }) {
	const captured = new Date(snapshot.capturedAt);
	const tiles = snapshot.assets
		.filter((asset) => asset.kind === "screenshot")
		.sort((a, b) => a.idx - b.idx);
	const html = snapshot.assets.find((asset) => asset.kind === "html") ?? null;

	return (
		<article className="flex flex-col gap-6">
			<header className="flex flex-col gap-2">
				<div className="flex items-center gap-2">
					<span className={LABEL_CLASS}>SNAPSHOT</span>
					{snapshot.status === "uploading" ? (
						<span
							title="The extension never finished uploading this snapshot's files"
							className="font-mono text-[10.5px] text-destructive"
						>
							incomplete
						</span>
					) : null}
				</div>
				<h1 className="text-xl font-semibold leading-snug tracking-tight">
					{snapshot.title || "(untitled)"}
				</h1>
				<a
					href={snapshot.url}
					target="_blank"
					rel="noreferrer"
					className="min-w-0 truncate font-mono text-[11.5px] text-[var(--log-accent)] hover:underline"
				>
					{snapshot.url}
				</a>
				<span className="font-mono text-[11px] text-muted-foreground">
					captured {formatTimestamp(captured)} · {relativeTime(captured)} ·{" "}
					{adapterName(snapshot.adapterId)} v{snapshot.adapterVersion} ·{" "}
					{chars(snapshot.markdownChars)}
				</span>
				<div className="flex flex-wrap items-center gap-2 pt-1">
					<CopyMarkdownButton
						size="large"
						getText={async () => snapshot.markdown}
					/>
					{html?.url ? (
						<a
							// Supabase's `download` parameter turns the signed URL into an
							// attachment; a cross-origin `<a download>` would be ignored.
							href={`${html.url}&download=${encodeURIComponent(`snapshot-${snapshot.id}.html`)}`}
							className="rounded-md border border-border bg-card px-3 py-1.5 text-[12.5px] text-[var(--log-chip-fg)] hover:bg-[var(--log-soft)]"
						>
							Download HTML
						</a>
					) : null}
					<DeleteButton id={snapshot.id} />
				</div>
			</header>

			<section className="flex flex-col gap-2">
				<span className={LABEL_CLASS}>MARKDOWN</span>
				<pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-[var(--log-card-border)] bg-card px-3 py-2.5 font-mono text-[12px] leading-[1.6] text-[var(--log-fg)]">
					{snapshot.markdown}
				</pre>
			</section>

			<section className="flex flex-col gap-2">
				<span className={LABEL_CLASS}>SCREENSHOT ({tiles.length})</span>
				{tiles.length === 0 ? (
					<span className="font-mono text-[11px] text-[var(--log-faint)]">
						no screenshot — the capture failed for this page
					</span>
				) : (
					// Tiles stack edge to edge so the page reads top to bottom.
					<div className="flex flex-col overflow-hidden rounded-md border border-[var(--log-card-border)]">
						{tiles.map((tile) =>
							tile.url ? (
								// biome-ignore lint/performance/noImgElement: signed, expiring Storage URLs; next/image's optimizer would cache and re-serve them.
								<img
									key={tile.path}
									src={tile.url}
									alt={`Screenshot, part ${tile.idx + 1} of ${tiles.length}`}
									width={tile.width}
									height={tile.height}
									loading="lazy"
									decoding="async"
									className="block h-auto w-full"
								/>
							) : (
								<span
									key={tile.path}
									className="px-3 py-2 font-mono text-[11px] text-[var(--log-faint)]"
								>
									part {tile.idx + 1} unavailable
								</span>
							),
						)}
					</div>
				)}
			</section>

			<MetadataSection metadata={snapshot.metadata} />
		</article>
	);
}

/** Two clicks: the first arms the button for a few seconds, the second deletes. */
function DeleteButton({ id }: { id: number }) {
	const router = useRouter();
	const [state, setState] = useState<"idle" | "armed" | "busy" | "failed">(
		"idle",
	);
	const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(
		() => () => {
			if (timer.current) {
				clearTimeout(timer.current);
			}
		},
		[],
	);

	async function onClick() {
		if (state === "busy") {
			return;
		}
		if (state !== "armed") {
			setState("armed");
			if (timer.current) {
				clearTimeout(timer.current);
			}
			timer.current = setTimeout(() => setState("idle"), 4000);
			return;
		}
		if (timer.current) {
			clearTimeout(timer.current);
		}
		setState("busy");
		try {
			const res = await fetch(`/api/snapshots/${id}`, { method: "DELETE" });
			if (!res.ok && res.status !== 404) {
				throw new Error(String(res.status));
			}
			router.push("/");
		} catch {
			setState("failed");
		}
	}

	return (
		<button
			type="button"
			onClick={onClick}
			disabled={state === "busy"}
			className={cn(
				"rounded-md border px-3 py-1.5 text-[12.5px] disabled:opacity-60",
				state === "armed"
					? "border-destructive text-destructive"
					: "border-border bg-card text-[var(--log-chip-fg)] hover:text-destructive",
			)}
		>
			{state === "armed"
				? "Click again to delete"
				: state === "busy"
					? "Deleting…"
					: state === "failed"
						? "Couldn't delete"
						: "Delete"}
		</button>
	);
}

function displayValue(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}
	return JSON.stringify(value);
}

/**
 * The page metadata (SPEC §17.5 `PageMetadata`): a collapsible key/value list
 * of the top-level fields, plus the raw JSON.
 */
function MetadataSection({ metadata }: { metadata: Record<string, unknown> }) {
	const entries = Object.entries(metadata);
	return (
		<section className="flex flex-col gap-2">
			<span className={LABEL_CLASS}>METADATA</span>
			<details className="rounded-md border border-[var(--log-card-border)] bg-card">
				<summary className="cursor-pointer px-3 py-2 font-mono text-[11px] text-[var(--log-fg)]">
					{entries.length} fields
				</summary>
				<dl className="grid grid-cols-[minmax(90px,max-content)_1fr] gap-x-4 gap-y-1 border-t border-[var(--log-card-border)] px-3 py-2.5">
					{entries.map(([key, value]) => (
						<Fragment key={key}>
							<dt className="font-mono text-[11px] text-muted-foreground">
								{key}
							</dt>
							<dd className="min-w-0 whitespace-pre-wrap break-all font-mono text-[11px] text-[var(--log-fg)]">
								{displayValue(value)}
							</dd>
						</Fragment>
					))}
				</dl>
			</details>
			<details className="rounded-md border border-[var(--log-card-border)] bg-card">
				<summary className="cursor-pointer px-3 py-2 font-mono text-[11px] text-[var(--log-fg)]">
					raw JSON
				</summary>
				<pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-all border-t border-[var(--log-card-border)] px-3 py-2.5 font-mono text-[11px] leading-[1.55] text-[var(--log-fg)]">
					{JSON.stringify(metadata, null, 2)}
				</pre>
			</details>
		</section>
	);
}
