// /settings — session-gated. Pairing status + token regeneration (one-time
// display, same endpoint as the gate) and sign-out.
import Link from "next/link";
import { redirect } from "next/navigation";
import { PairingTokenPanel } from "../../components/pairing";
import { ThemeSelect } from "../../components/theme-select";
import { db } from "../../db";
import { getAuthState } from "../../lib/auth";
import { signOutAction } from "../../lib/authActions";
import { getPairingStatus } from "../../lib/pairing";

export default async function SettingsPage() {
	const auth = await getAuthState();
	if (auth.status === "unauthenticated") {
		redirect("/login");
	}
	if (auth.status === "forbidden") {
		redirect("/not-allowed");
	}

	const pairing = await getPairingStatus(db, auth.user.id);

	return (
		<main className="mx-auto flex w-full max-w-lg flex-1 flex-col gap-8 p-8">
			<div className="flex items-center justify-between">
				<h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
				<Link
					href="/"
					className="text-sm text-muted-foreground hover:text-foreground"
				>
					Back to feed
				</Link>
			</div>

			<section className="flex flex-col gap-3">
				<h2 className="font-medium">Extension pairing</h2>
				<p className="text-sm text-muted-foreground">
					Status:{" "}
					{pairing.paired
						? "paired"
						: pairing.hasToken
							? "token generated, waiting for the extension"
							: "no token generated yet"}
				</p>
				<PairingTokenPanel hasToken={pairing.hasToken} poll="after-generate" />
			</section>

			<section className="flex flex-col gap-3">
				<h2 className="font-medium">Appearance</h2>
				<p className="text-sm text-muted-foreground">
					System follows your device's light/dark setting. Pick Light or Dark if
					your browser forces a scheme of its own.
				</p>
				<ThemeSelect />
			</section>

			<section className="flex flex-col gap-3">
				<h2 className="font-medium">Account</h2>
				<p className="text-sm text-muted-foreground">
					Signed in as {auth.user.email}
				</p>
				<div>
					<form action={signOutAction}>
						<button
							type="submit"
							className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-accent"
						>
							Sign out
						</button>
					</form>
				</div>
			</section>
		</main>
	);
}
