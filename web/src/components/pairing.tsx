"use client";
// Pairing UI (SPEC §7): token generation with one-time raw display + copy,
// and polling of /api/pairing-status until the extension says hello.
// Talks ONLY to the pairing API routes — never to the DB (Hard rule #2).
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { skipPairingAction } from "../lib/pairingActions";

type GenerateState =
	| { phase: "idle" }
	| { phase: "loading" }
	// The one and only time the raw token is visible.
	| { phase: "revealed"; token: string }
	| { phase: "error"; message: string };

const POLL_MS = 3000;

/**
 * Polls /api/pairing-status every ~3s while `active`; on paired -> true it
 * refreshes the route so the server component re-renders unlocked.
 */
function usePairingPoll(active: boolean): boolean {
	const router = useRouter();
	const [paired, setPaired] = useState(false);

	useEffect(() => {
		if (!active || paired) {
			return;
		}
		let cancelled = false;

		const tick = async () => {
			try {
				const res = await fetch("/api/pairing-status", { cache: "no-store" });
				if (!res.ok) {
					return;
				}
				const body = (await res.json()) as { paired?: boolean };
				if (!cancelled && body.paired) {
					setPaired(true);
					router.refresh();
				}
			} catch {
				// Transient network error — next tick retries.
			}
		};

		const id = setInterval(tick, POLL_MS);
		tick();
		return () => {
			cancelled = true;
			clearInterval(id);
		};
	}, [active, paired, router]);

	return paired;
}

function CopyButton({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);
	return (
		<button
			type="button"
			className="shrink-0 rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
			onClick={async () => {
				try {
					await navigator.clipboard.writeText(text);
					setCopied(true);
					setTimeout(() => setCopied(false), 2000);
				} catch {
					// Clipboard unavailable — the token is selectable text.
				}
			}}
		>
			{copied ? "Copied" : "Copy"}
		</button>
	);
}

/**
 * Generate/regenerate button + one-time token reveal.
 *
 * `poll`: "always" keeps polling from mount (the gate on `/` — a token from
 * a previous visit may get paired while this page is open); "after-generate"
 * only polls once a new token has been revealed (settings).
 */
export function PairingTokenPanel({
	hasToken,
	poll,
}: {
	hasToken: boolean;
	poll: "always" | "after-generate";
}) {
	const [state, setState] = useState<GenerateState>({ phase: "idle" });
	const paired = usePairingPoll(
		poll === "always" || state.phase === "revealed",
	);

	const generate = async () => {
		setState({ phase: "loading" });
		try {
			const res = await fetch("/api/pairing/token", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			});
			if (!res.ok) {
				throw new Error(`request failed (${res.status})`);
			}
			const body = (await res.json()) as { token?: string };
			if (!body.token) {
				throw new Error("no token in response");
			}
			setState({ phase: "revealed", token: body.token });
		} catch (err) {
			setState({
				phase: "error",
				message: err instanceof Error ? err.message : "unknown error",
			});
		}
	};

	// True once a token has been issued at some point — a regenerate must warn.
	const isRegenerate = hasToken || state.phase === "revealed";

	if (paired) {
		return (
			<p className="text-sm text-muted-foreground">Paired. Reloading&hellip;</p>
		);
	}

	return (
		<div className="flex flex-col gap-3">
			{state.phase === "revealed" ? (
				<>
					<div className="flex items-start gap-2">
						<code className="min-w-0 flex-1 break-all rounded-md border border-border bg-muted px-3 py-2 font-mono text-sm">
							{state.token}
						</code>
						<CopyButton text={state.token} />
					</div>
					<p className="text-sm text-muted-foreground">
						Copy it now — it won&apos;t be shown again. Waiting for the
						extension to connect&hellip;
					</p>
				</>
			) : (
				<>
					{isRegenerate ? (
						<p className="text-sm text-muted-foreground">
							A token already exists. Regenerating invalidates it and un-pairs
							the extension — you&apos;ll need to paste the new token into the
							extension options again.
						</p>
					) : null}
					<div>
						<button
							type="button"
							onClick={generate}
							disabled={state.phase === "loading"}
							className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
						>
							{state.phase === "loading"
								? "Generating…"
								: isRegenerate
									? "Regenerate token"
									: "Generate token"}
						</button>
					</div>
					{state.phase === "error" ? (
						<p className="text-sm text-destructive">
							Could not generate a token: {state.message}
						</p>
					) : null}
				</>
			)}
		</div>
	);
}

/**
 * Full-screen block rendered by `/` while unpaired — explains the flow and
 * unlocks (via router.refresh) once /api/pairing-status reports paired.
 */
export function PairingGate({ hasToken }: { hasToken: boolean }) {
	return (
		<main className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center gap-6 p-8">
			<div>
				<h1 className="text-2xl font-semibold tracking-tight">
					Pair the extension
				</h1>
				<p className="mt-2 text-sm text-muted-foreground">
					Smultronstället needs its Chrome extension to capture your bookmarks.
				</p>
			</div>

			<ol className="list-decimal space-y-2 pl-5 text-sm">
				<li>Install the Smultronstället Chrome extension.</li>
				<li>Generate a pairing token below and copy it.</li>
				<li>
					Open the extension&apos;s options page, paste the token, and save.
				</li>
				<li>This page unlocks automatically once the extension connects.</li>
			</ol>

			<PairingTokenPanel hasToken={hasToken} poll="always" />

			<form action={skipPairingAction} className="border-t border-border pt-4">
				<button
					type="submit"
					className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
				>
					I know what I&apos;m doing, skip.
				</button>
			</form>
		</main>
	);
}
