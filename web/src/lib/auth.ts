// Site session auth — SPEC §7 (Site auth). Supabase Google OAuth session,
// gated to the single ALLOWED_EMAIL (exact match). This is THE helper later
// milestones use to guard /api/bookmarks* and pages.
import { createSupabaseServerClient } from "./supabase/server";

export type AuthedUser = { id: string; email: string };

export type AuthState =
	| { status: "unauthenticated" }
	/** Valid session, but the Google account is not ALLOWED_EMAIL. */
	| { status: "forbidden" }
	| { status: "authed"; user: AuthedUser };

/**
 * Reads the Supabase session server-side and applies the ALLOWED_EMAIL gate.
 *
 * A logged-in user with the WRONG email is signed out here (SPEC §7: "sign
 * out and show a 'not allowed' page") and reported as `forbidden` so pages
 * can redirect to /not-allowed. When called during a Server Component render
 * the sign-out cannot clear cookies (renders can't set cookies) — the proxy
 * (src/proxy.ts) performs the cookie-clearing sign-out on the next request,
 * and this gate never treats such a session as authed regardless.
 */
export async function getAuthState(): Promise<AuthState> {
	const supabase = await createSupabaseServerClient();

	const { data, error } = await supabase.auth.getUser();
	const user = data?.user;
	if (error || !user) {
		return { status: "unauthenticated" };
	}

	const allowed = process.env.ALLOWED_EMAIL;
	if (!allowed || !user.email || user.email !== allowed) {
		try {
			await supabase.auth.signOut();
		} catch {
			// Network/API failure revoking the session — still forbidden.
		}
		return { status: "forbidden" };
	}

	return { status: "authed", user: { id: user.id, email: user.email } };
}

/**
 * `{ id, email }` when a valid session's email exactly matches
 * ALLOWED_EMAIL; null otherwise (callers respond 401 / redirect).
 */
export async function getAuthedUser(): Promise<AuthedUser | null> {
	const state = await getAuthState();
	return state.status === "authed" ? state.user : null;
}
