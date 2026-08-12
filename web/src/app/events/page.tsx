// /events — the browse-event log view (m19, SPEC §9 + §13). Session gating is
// identical to `/`: no session -> /login; wrong email -> signed out
// (getAuthState) -> /not-allowed.
//
// Deliberately NOT gated on pairing: the pairing gate is the feed's onboarding
// funnel (it exists so a first-run user is told to install the extension before
// the feed sits empty), while this is a diagnostic read over data the extension
// has already sent. An unpaired or pairing-skipped session sees the view, which
// simply reports that no events have arrived yet.
import { redirect } from "next/navigation";
import { EventsLog } from "../../components/events-log";
import { SiteHeader } from "../../components/site-header";
import { getAuthState } from "../../lib/auth";

export default async function EventsPage() {
	const auth = await getAuthState();
	if (auth.status === "unauthenticated") {
		redirect("/login");
	}
	if (auth.status === "forbidden") {
		redirect("/not-allowed");
	}

	// Full-viewport log shell, like the feed: the page itself never scrolls —
	// the toolbar is fixed and the log pane scrolls internally.
	return (
		<div className="flex h-dvh flex-col overflow-hidden">
			<SiteHeader current="events" />
			<EventsLog />
		</div>
	);
}
