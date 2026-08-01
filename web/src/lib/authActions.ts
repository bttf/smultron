"use server";
// Server actions for sign-in/sign-out. Actions (unlike Server Component
// renders) may set cookies, which signInWithOAuth needs for the PKCE code
// verifier and signOut needs to clear the session.
import { redirect } from "next/navigation";
import { getAppUrl } from "./appUrl";
import { createSupabaseServerClient } from "./supabase/server";

/**
 * Starts the Google OAuth flow (PKCE) and redirects the browser to Google.
 * Google redirects back to Supabase, which redirects to /auth/callback.
 */
export async function signInWithGoogleAction(): Promise<void> {
	const supabase = await createSupabaseServerClient();
	// APP_URL (falling back to the request's own origin) — never a hardcoded
	// localhost, which would bounce production sign-ins to the dev server.
	const appUrl = await getAppUrl();

	const { data, error } = await supabase.auth.signInWithOAuth({
		provider: "google",
		options: { redirectTo: `${appUrl}/auth/callback` },
	});

	if (error || !data?.url) {
		redirect(
			`/login?error=${encodeURIComponent(error?.message ?? "Could not start sign-in")}`,
		);
	}
	redirect(data.url);
}

export async function signOutAction(): Promise<void> {
	const supabase = await createSupabaseServerClient();
	try {
		await supabase.auth.signOut();
	} catch {
		// Revocation call failed (e.g. network) — cookies are cleared
		// locally by signOut's cookie removal; proceed to /login regardless.
	}
	redirect("/login");
}
