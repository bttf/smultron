"use server";
// Server action for the pairing gate's "skip" CTA (actions may set cookies,
// Server Component renders may not — same reasoning as authActions.ts).
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SKIP_PAIRING_COOKIE } from "./pairing";

/**
 * Dismisses the pairing gate on `/`: the user wants to use the site without
 * the extension (web adds, m11). Sets a long-lived preference cookie and
 * redirects back to `/`, which now renders the feed. Pairing remains
 * available in /settings at any time.
 */
export async function skipPairingAction(): Promise<void> {
	(await cookies()).set(SKIP_PAIRING_COOKIE, "1", {
		path: "/",
		maxAge: 60 * 60 * 24 * 365,
		sameSite: "lax",
		httpOnly: true,
		secure: process.env.NODE_ENV === "production",
	});
	redirect("/");
}
