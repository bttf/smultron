// / (home) — SPEC §7 gating: no session -> /login; wrong email -> signed out
// (getAuthState) -> /not-allowed; authed but unpaired -> PairingGate blocks
// the happy path; paired -> feed placeholder (milestone 6 replaces the
// placeholder <main> below).
import Link from "next/link";
import { redirect } from "next/navigation";
import { PairingGate } from "../components/pairing";
import { db } from "../db";
import { getAuthState } from "../lib/auth";
import { signOutAction } from "../lib/authActions";
import { getPairingStatus } from "../lib/pairing";

export default async function Home() {
	const auth = await getAuthState();
	if (auth.status === "unauthenticated") {
		redirect("/login");
	}
	if (auth.status === "forbidden") {
		redirect("/not-allowed");
	}

	const pairing = await getPairingStatus(db, auth.user.id);

	return (
		<div className="flex flex-1 flex-col">
			<header className="flex items-center justify-between border-b border-border px-6 py-3">
				<span className="font-semibold tracking-tight">Smultronstället</span>
				<nav className="flex items-center gap-4 text-sm">
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

			{pairing.paired ? (
				<main className="flex flex-1 flex-col items-center justify-center gap-2 p-16">
					<h1 className="text-3xl font-semibold tracking-tight">
						Smultronstället
					</h1>
					<p className="text-muted-foreground">Feed coming in m6.</p>
				</main>
			) : (
				<PairingGate hasToken={pairing.hasToken} />
			)}
		</div>
	);
}
