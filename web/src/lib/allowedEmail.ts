// ALLOWED_EMAIL gate predicate — SPEC §7 (Site auth). Single implementation
// used by getAuthState (auth.ts), the OAuth callback, and the proxy.
//
// ALLOWED_EMAIL is OPTIONAL (approved 2026-08-01): unset/empty disables the
// gate — any authenticated Google account may sign in, each user seeing only
// their own data. When set, only that exact email passes.
export function isEmailAllowed(email: string | null | undefined): boolean {
	const allowed = process.env.ALLOWED_EMAIL?.trim();
	if (!allowed) {
		return true;
	}
	return email === allowed;
}
