"use client";

// Registers the (deliberately cache-free) service worker from public/sw.js —
// see that file. Rendering nothing; this exists only for the side effect,
// which makes the app installable and unlocks the manifest's share target.
import { useEffect } from "react";

export function RegisterServiceWorker() {
	useEffect(() => {
		if (!("serviceWorker" in navigator)) return;
		navigator.serviceWorker.register("/sw.js").catch(() => {
			// Registration is best-effort: an unsupported/blocked worker just
			// means no install prompt, never a broken page.
		});
	}, []);

	return null;
}
