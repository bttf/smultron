// /login — minimal sign-in page. The button triggers a server action that
// starts the Supabase Google OAuth (PKCE) flow and redirects to Google.
import { redirect } from "next/navigation";
import { getAuthState } from "../../lib/auth";
import { signInWithGoogleAction } from "../../lib/authActions";

export default async function LoginPage({
	searchParams,
}: {
	searchParams: Promise<{ error?: string }>;
}) {
	const { error } = await searchParams;

	// Already signed in with the allowed account? Straight to the app.
	const auth = await getAuthState();
	if (auth.status === "authed") {
		redirect("/");
	}

	return (
		<main className="flex flex-1 flex-col items-center justify-center gap-8 p-8">
			<div className="text-center">
				<h1 className="text-3xl font-semibold tracking-tight">
					<span aria-hidden>🍓</span> Smultronstället
				</h1>
				<p className="mt-2 text-sm text-muted-foreground">
					Personal bookmarks feed and search.
				</p>
			</div>

			<form action={signInWithGoogleAction}>
				<button
					type="submit"
					className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
				>
					Sign in with Google
				</button>
			</form>

			{error ? (
				<p className="max-w-md text-center text-sm text-destructive">
					Sign-in failed: {error}
				</p>
			) : null}
		</main>
	);
}
