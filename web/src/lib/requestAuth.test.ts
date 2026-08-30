// m20 (SPEC §8): `GET /api/bookmarks` answers BOTH schemes. What matters here
// is the routing policy — which resolver a request reaches, and that a bad
// token never falls through to a session that happens to be lying around.
import { describe, expect, it, vi } from "vitest";
import { authenticateRequest } from "./requestAuth";

function request(headers: Record<string, string> = {}): Request {
	return new Request("https://smultron.redpine.software/api/bookmarks", {
		headers,
	});
}

describe("authenticateRequest", () => {
	it("uses the token path when an Authorization header is present", async () => {
		const resolveToken = vi.fn().mockResolvedValue({ userId: "user-token" });
		const resolveSession = vi.fn().mockResolvedValue({ id: "user-session" });

		const userId = await authenticateRequest(
			request({ authorization: "Bearer abc" }),
			{ resolveToken, resolveSession },
		);

		expect(userId).toBe("user-token");
		expect(resolveToken).toHaveBeenCalledTimes(1);
		expect(resolveSession).not.toHaveBeenCalled();
	});

	it("does NOT fall back to the session when the token is rejected", async () => {
		// The whole point: a revoked pairing token must 401 the extension, not
		// silently succeed because the same browser profile is logged into the
		// site — otherwise a broken pairing looks healthy.
		const resolveToken = vi.fn().mockResolvedValue(null);
		const resolveSession = vi.fn().mockResolvedValue({ id: "user-session" });

		const userId = await authenticateRequest(
			request({ authorization: "Bearer revoked" }),
			{ resolveToken, resolveSession },
		);

		expect(userId).toBeNull();
		expect(resolveSession).not.toHaveBeenCalled();
	});

	it("takes the token path for ANY Authorization header, however malformed", async () => {
		// `authenticateApiToken` owns Bearer parsing; anything it can't read is
		// null, and that stays a 401 rather than a session retry. `Headers`
		// keeps an empty value, so even `Authorization:` counts as present —
		// a request that names a scheme is judged by that scheme.
		const resolveToken = vi.fn().mockResolvedValue(null);
		const resolveSession = vi.fn().mockResolvedValue({ id: "user-session" });

		for (const header of ["", "Basic x", "Bearer", "bearer  "]) {
			expect(
				await authenticateRequest(request({ authorization: header }), {
					resolveToken,
					resolveSession,
				}),
			).toBeNull();
		}
		expect(resolveToken).toHaveBeenCalledTimes(4);
		expect(resolveSession).not.toHaveBeenCalled();
	});

	it("falls through to the session when no Authorization header is sent", async () => {
		const resolveToken = vi.fn().mockResolvedValue({ userId: "user-token" });
		const resolveSession = vi.fn().mockResolvedValue({ id: "user-session" });

		const userId = await authenticateRequest(request(), {
			resolveToken,
			resolveSession,
		});

		expect(userId).toBe("user-session");
		expect(resolveToken).not.toHaveBeenCalled();
	});

	it("is unauthenticated when neither scheme resolves a user", async () => {
		const userId = await authenticateRequest(request(), {
			resolveToken: vi.fn().mockResolvedValue(null),
			resolveSession: vi.fn().mockResolvedValue(null),
		});
		expect(userId).toBeNull();
	});
});
