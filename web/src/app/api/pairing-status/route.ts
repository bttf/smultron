// GET /api/pairing-status — SPEC §7/§8. Session-authed. `paired` is true
// once a token row exists AND the extension has said /api/hello
// (paired_at set). Polled by the pairing dialog every ~3s.
import { db } from "../../../db";
import { getAuthedUser } from "../../../lib/auth";
import { getPairingStatus } from "../../../lib/pairing";

// Node runtime: the postgres driver needs it.
export const runtime = "nodejs";

export async function GET() {
	const user = await getAuthedUser();
	if (!user) {
		return Response.json({ error: "unauthorized" }, { status: 401 });
	}

	const { paired } = await getPairingStatus(db, user.id);
	return Response.json({ paired });
}
