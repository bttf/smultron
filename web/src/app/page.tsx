// / (home) — SPEC §7 gating: no session -> /login; wrong email -> signed out
// (getAuthState) -> /not-allowed; authed but unpaired -> PairingGate blocks
// the happy path (skippable via the SKIP_PAIRING_COOKIE cookie — web adds
// work without the extension, m11); paired or skipped -> the feed (Feed,
// src/components/feed.tsx).
import { cookies } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Feed } from "../components/feed";
import { PairingGate } from "../components/pairing";
import { db } from "../db";
import { getAuthState } from "../lib/auth";
import { signOutAction } from "../lib/authActions";
import { getPairingStatus, SKIP_PAIRING_COOKIE } from "../lib/pairing";

function Header() {
	return (
		<header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2.5">
			<span className="text-sm font-semibold tracking-tight">
				<span aria-hidden>🍓</span> Smultronstället
			</span>
			<nav className="flex items-center gap-3.5 text-[13px]">
				<Link
					href="/settings"
					className="text-muted-foreground hover:text-foreground"
				>
					Settings
				</Link>
				<form action={signOutAction}>
					<button
						type="submit"
						className="text-muted-foreground hover:text-foreground"
					>
						Sign out
					</button>
				</form>
			</nav>
		</header>
	);
}

export default async function Home() {
	const auth = await getAuthState();
	if (auth.status === "unauthenticated") {
		redirect("/login");
	}
	if (auth.status === "forbidden") {
		redirect("/not-allowed");
	}

	const pairing = await getPairingStatus(db, auth.user.id);
	const skipped = (await cookies()).get(SKIP_PAIRING_COOKIE)?.value === "1";

	if (pairing.paired || skipped) {
		// Full-viewport log shell (m9): the page itself never scrolls — the
		// feed's log pane and facets aside scroll internally.
		return (
			<div className="flex h-dvh flex-col overflow-hidden">
				<Header />
				<Feed />
			</div>
		);
	}

	// Unpaired path keeps normal document flow (PairingGate renders as a page).
	return (
		<div className="flex flex-1 flex-col">
			<Header />
			<PairingGate hasToken={pairing.hasToken} />
		</div>
	);
}
