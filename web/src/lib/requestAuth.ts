// Dual-scheme request auth for the ONE endpoint both clients read (m20,
// SPEC §8): `GET /api/bookmarks` answers the site's session AND the
// extension's pairing token, so the new tab page can render pins/recent/
// search without a second listing endpoint.
//
// Deliberately dependency-injected and import-free: the session resolver
// pulls in `next/headers` and the token resolver pulls in the service-role
// db, and neither belongs in a unit test of this policy.

export interface RequestAuthResolvers {
	/** Bearer-token path — `authenticateApiToken` in production. */
	resolveToken: (request: Request) => Promise<{ userId: string } | null>;
	/** Session path — `getAuthedUser` in production. */
	resolveSession: () => Promise<{ id: string } | null>;
}

/**
 * The authenticated user's id, or null (caller responds 401).
 *
 * An `Authorization` header commits the request to the token path and is
 * NEVER retried as a session: a revoked or mistyped token must 401 honestly
 * rather than silently succeeding on whatever cookies the browser happened
 * to attach — otherwise a broken extension pairing would look healthy for as
 * long as the user stayed logged into the site in the same profile.
 */
export async function authenticateRequest(
	request: Request,
	{ resolveToken, resolveSession }: RequestAuthResolvers,
): Promise<string | null> {
	if (request.headers.get("authorization") !== null) {
		const token = await resolveToken(request);
		return token?.userId ?? null;
	}
	const user = await resolveSession();
	return user?.id ?? null;
}
