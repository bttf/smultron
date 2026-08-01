// /auth/callback — OAuth code exchange (SPEC §7). Supabase redirects here
// after Google sign-in; we exchange the code for a cookie session (PKCE),
// then gate on ALLOWED_EMAIL: wrong account -> sign out + /not-allowed.
import { NextResponse } from "next/server";
import { isEmailAllowed } from "../../../lib/allowedEmail";
import { getAppUrl } from "../../../lib/appUrl";
import { createSupabaseServerClient } from "../../../lib/supabase/server";

export const runtime = "nodejs";

export async function GET(request: Request) {
	const { searchParams } = new URL(request.url);
	// Post-callback redirects go to APP_URL, not `request.url`'s origin, so the
	// session lands on the canonical domain rather than a deployment host.
	const origin = await getAppUrl(request.headers);
	const code = searchParams.get("code");

	if (!code) {
		// Provider-side failure (user cancelled, config error, ...).
		const reason =
			searchParams.get("error_description") ??
			searchParams.get("error") ??
			"Missing authorization code";
		return NextResponse.redirect(
			`${origin}/login?error=${encodeURIComponent(reason)}`,
		);
	}

	const supabase = await createSupabaseServerClient();
	const { data, error } = await supabase.auth.exchangeCodeForSession(code);
	if (error) {
		return NextResponse.redirect(
			`${origin}/login?error=${encodeURIComponent(error.message)}`,
		);
	}

	if (!isEmailAllowed(data.user?.email)) {
		// SPEC §7: sign out and show the "not allowed" page.
		try {
			await supabase.auth.signOut();
		} catch {
			// Best effort — the redirect target never grants access anyway.
		}
		return NextResponse.redirect(`${origin}/not-allowed`);
	}

	return NextResponse.redirect(`${origin}/`);
}
