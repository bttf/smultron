// /not-allowed — shown after signing in with a Google account other than
// ALLOWED_EMAIL (the session is signed out before the user lands here).
import Link from "next/link";

export default function NotAllowedPage() {
	return (
		<main className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
			<h1 className="text-2xl font-semibold tracking-tight">Not allowed</h1>
			<p className="max-w-md text-sm text-muted-foreground">
				This is a personal instance — your Google account isn&apos;t allowed
				here.
			</p>
			<Link href="/login" className="text-sm underline underline-offset-4">
				Sign in with a different account
			</Link>
		</main>
	);
}
