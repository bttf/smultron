// Next.js 16 proxy (the file convention formerly named `middleware`).
// Refreshes the Supabase auth session on every matched request (@supabase/ssr
// requires this so expired access tokens get renewed and written back to
// cookies) and applies optimistic redirects:
//
//   - no session on a protected page        -> /login
//   - session with the wrong Google account -> sign out, /not-allowed
//
// Pages/API routes still enforce auth themselves via getAuthState()/
// getAuthedUser() — the proxy is an optimistic layer, not the authority
// (see node_modules/next/dist/docs/01-app/01-getting-started/16-proxy.md).
//
// /api/sync, /api/hello and /api/bookmarks/by-url are token-authed by the
// extension and are excluded in the matcher below — they must NEVER hit
// session/redirect logic. (/api/highlights is Bearer-authed too but shares
// its path prefix with the session-authed DELETE /api/highlights/:id, so it
// stays matched — harmless, since matched /api/* is never redirected.)
// Other /api/* routes are matched (so their sessions refresh) but are never
// redirected — they 401 on their own.
import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";
import { isEmailAllowed } from "./lib/allowedEmail";

// Pages reachable without a session.
const PUBLIC_PATHS = new Set(["/login", "/not-allowed"]);

export async function proxy(request: NextRequest) {
	const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
	const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
	if (!url || !key) {
		// Supabase env not configured (placeholder builds) — pass through;
		// page-level auth will surface the misconfiguration.
		return NextResponse.next();
	}

	let response = NextResponse.next({ request });

	const supabase = createServerClient(url, key, {
		cookies: {
			getAll() {
				return request.cookies.getAll();
			},
			setAll(cookiesToSet) {
				// Standard @supabase/ssr proxy pattern: mirror refreshed
				// cookies onto the forwarded request AND the response.
				for (const { name, value } of cookiesToSet) {
					request.cookies.set(name, value);
				}
				response = NextResponse.next({ request });
				for (const { name, value, options } of cookiesToSet) {
					response.cookies.set(name, value, options);
				}
			},
		},
	});

	let user: { email?: string } | null = null;
	try {
		const { data } = await supabase.auth.getUser();
		user = data?.user ?? null;
	} catch {
		// Auth server unreachable (e.g. placeholder env) — treat as no user.
	}

	const { pathname } = request.nextUrl;
	const isPublic = PUBLIC_PATHS.has(pathname) || pathname.startsWith("/auth/");
	const isApi = pathname.startsWith("/api/");

	if (!user && !isPublic && !isApi) {
		const loginUrl = request.nextUrl.clone();
		loginUrl.pathname = "/login";
		loginUrl.search = "";
		return NextResponse.redirect(loginUrl);
	}

	if (
		user &&
		!isEmailAllowed(user.email) &&
		!isApi &&
		pathname !== "/not-allowed"
	) {
		// Wrong Google account: sign out (SPEC §7) and show /not-allowed.
		try {
			await supabase.auth.signOut();
		} catch {
			// Revocation failure — still redirect; the session cookies that
			// signOut managed to clear are carried onto the redirect below.
		}
		const notAllowedUrl = request.nextUrl.clone();
		notAllowedUrl.pathname = "/not-allowed";
		notAllowedUrl.search = "";
		const redirectResponse = NextResponse.redirect(notAllowedUrl);
		for (const cookie of response.cookies.getAll()) {
			redirectResponse.cookies.set(cookie);
		}
		return redirectResponse;
	}

	return response;
}

export const config = {
	// Everything EXCEPT: Next internals/static assets, files with common
	// static extensions, and the extension's Bearer-token endpoints
	// (/api/sync, /api/hello, /api/bookmarks/by-url), which must stay out of
	// session logic entirely.
	matcher: [
		"/((?!_next/static|_next/image|favicon.ico|api/sync|api/hello|api/bookmarks/by-url|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|css|js|txt|xml|json)$).*)",
	],
};
