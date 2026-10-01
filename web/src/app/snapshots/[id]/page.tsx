// /snapshots/:id — one page snapshot (m25, SPEC §17.9). Session gating is
// identical to `/` and `/events`: no session -> /login; wrong email -> signed
// out (getAuthState) -> /not-allowed. The extension popup's `Open` links here.
//
// The snapshot itself is fetched client-side from `GET /api/snapshots/:id`
// (Hard rule #2), which also mints the signed asset URLs; this server shell
// only gates the session and rejects an id that cannot be one.
import { notFound, redirect } from "next/navigation";
import { SiteHeader } from "../../../components/site-header";
import { SnapshotView } from "../../../components/snapshots";
import { getAuthState } from "../../../lib/auth";

export default async function SnapshotPage({
	params,
}: {
	params: Promise<{ id: string }>;
}) {
	const auth = await getAuthState();
	if (auth.status === "unauthenticated") {
		redirect("/login");
	}
	if (auth.status === "forbidden") {
		redirect("/not-allowed");
	}

	const { id } = await params;
	if (!/^[1-9]\d{0,15}$/.test(id)) {
		notFound();
	}

	return (
		<div className="flex min-h-dvh flex-col">
			<SiteHeader current="snapshot" />
			<main className="mx-auto w-full max-w-[960px] flex-1 px-4 py-6">
				<SnapshotView id={Number(id)} />
			</main>
		</div>
	);
}
