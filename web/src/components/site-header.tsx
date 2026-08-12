// Shared app header for the two full-viewport log shells: the feed (`/`) and
// the browse-event log (`/events`, m19). Server component — it renders the
// sign-out server action's form directly.
import Link from "next/link";
import { signOutAction } from "../lib/authActions";

export function SiteHeader({ current }: { current: "feed" | "events" }) {
	return (
		<header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2.5">
			<span className="text-sm font-semibold tracking-tight">
				<span aria-hidden>🍓</span> Smultronstället
			</span>
			<nav className="flex items-center gap-3.5 text-[13px]">
				{/* Two-way link between the log views (SPEC §9): the feed points at
				    the event log, the event log points back. Deliberately small and
				    lowercase — /events is a diagnostic tool, not a product surface. */}
				<Link
					href={current === "events" ? "/" : "/events"}
					className="font-mono text-[12px] text-muted-foreground hover:text-foreground"
				>
					{current === "events" ? "feed" : "events"}
				</Link>
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
