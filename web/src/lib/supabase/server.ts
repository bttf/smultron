// Supabase server client for AUTH ONLY (Hard rule #5: all data access goes
// through Drizzle). Binds @supabase/ssr's cookie-session handling to Next's
// request cookie store. PKCE + cookie sessions are the @supabase/ssr
// defaults.
//
// Env is read lazily inside the function (never at module scope) so that
// `next build` with placeholder .env.local values succeeds — pages that call
// this are all dynamic (they read cookies), so nothing runs at build time.
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/**
 * Creates a per-request Supabase auth client. Never share the returned
 * client across requests.
 */
export async function createSupabaseServerClient() {
	const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
	const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
	if (!url || !key) {
		throw new Error(
			"NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY are not set",
		);
	}

	const cookieStore = await cookies();

	return createServerClient(url, key, {
		cookies: {
			getAll() {
				return cookieStore.getAll();
			},
			setAll(cookiesToSet) {
				try {
					for (const { name, value, options } of cookiesToSet) {
						cookieStore.set(name, value, options);
					}
				} catch {
					// Cookie writes are not allowed during Server Component
					// rendering. Safe to ignore: the proxy (src/proxy.ts)
					// refreshes sessions and persists the updated cookies.
				}
			},
		},
	});
}
