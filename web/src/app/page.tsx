// / (home) — SPEC §7 gating: no session -> /login; wrong email -> signed out
// (getAuthState) -> /not-allowed; authed but unpaired -> PairingGate blocks
// the happy path (skippable via the SKIP_PAIRING_COOKIE cookie — web adds
// work without the extension, m11); paired or skipped -> the feed (Feed,
// src/components/feed.tsx).
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Feed } from "../components/feed";
import { PairingGate } from "../components/pairing";
import { SiteHeader } from "../components/site-header";
import { db } from "../db";
import { getAuthState } from "../lib/auth";
import { getPairingStatus, SKIP_PAIRING_COOKIE } from "../lib/pairing";

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
				<SiteHeader current="feed" />
				<Feed />
			</div>
		);
	}

	// Unpaired path keeps normal document flow (PairingGate renders as a page).
	return (
		<div className="flex flex-1 flex-col">
			<SiteHeader current="feed" />
			<PairingGate hasToken={pairing.hasToken} />
		</div>
	);
}
