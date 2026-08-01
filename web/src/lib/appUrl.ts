// The site's public base URL — the origin OAuth redirects must come back to.
//
// `APP_URL` is the source of truth (AGENTS.md §Environment variables:
// http://localhost:3000 in dev, https://smultron.redpine.software in prod).
// It used to be read with a bare `?? "http://localhost:3000"` fallback, which
// silently sent production sign-ins to localhost whenever the variable was
// missing from the deployment. The fallbacks below derive the origin the
// browser actually used instead, so a missing APP_URL degrades to "correct"
// rather than "localhost".
//
// Resolution order:
//   1. APP_URL
//   2. the forwarded/request host (x-forwarded-host, then host)
//   3. VERCEL_PROJECT_PRODUCTION_URL / VERCEL_URL
//   4. http://localhost:3000
import { headers } from "next/headers";

export type AppUrlSources = {
	appUrl?: string | null;
	forwardedProto?: string | null;
	forwardedHost?: string | null;
	host?: string | null;
	vercelUrl?: string | null;
};

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** First entry of a possibly comma-joined proxy header, trimmed. */
function firstValue(header: string | null | undefined): string | null {
	const value = header?.split(",")[0]?.trim();
	return value ? value : null;
}

/** `https://host` with any trailing slash / path stripped; null if unusable. */
function toOrigin(value: string | null | undefined): string | null {
	const raw = value?.trim();
	if (!raw) {
		return null;
	}
	// Bare hosts ("smultron.redpine.software", "localhost:3000") are common in
	// env vars — VERCEL_URL never carries a scheme. Anything carrying a scheme
	// other than http(s) is rejected rather than coerced ("ftp://x" must not
	// become "https://ftp://x", which parses as the host "ftp").
	const hasHttpScheme = /^https?:\/\//i.test(raw);
	if (!hasHttpScheme && /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
		return null;
	}
	const withScheme = hasHttpScheme
		? raw
		: `${isLocalHost(raw) ? "http" : "https"}://${raw}`;

	try {
		const url = new URL(withScheme);
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			return null;
		}
		return url.origin;
	} catch {
		return null;
	}
}

function isLocalHost(hostOrUrl: string): boolean {
	const host = hostOrUrl.replace(/^https?:\/\//i, "").split("/")[0] ?? "";
	const hostname = host.replace(/:\d+$/, "");
	return LOCAL_HOSTNAMES.has(hostname);
}

/**
 * Pure resolver behind {@link getAppUrl} — no `process.env`, no `headers()`,
 * so the precedence rules are unit-testable.
 */
export function resolveAppUrl(sources: AppUrlSources): string {
	const configured = toOrigin(sources.appUrl);
	if (configured) {
		return configured;
	}

	const host = firstValue(sources.forwardedHost) ?? firstValue(sources.host);
	if (host) {
		const proto = firstValue(sources.forwardedProto);
		const scheme = proto ?? (isLocalHost(host) ? "http" : "https");
		const fromRequest = toOrigin(`${scheme}://${host}`);
		if (fromRequest) {
			return fromRequest;
		}
	}

	return toOrigin(sources.vercelUrl) ?? "http://localhost:3000";
}

/**
 * Base URL to build absolute app links from (no trailing slash).
 *
 * Pass `requestHeaders` inside a Route Handler; Server Actions and Server
 * Components can omit it and the ambient request headers are used.
 */
export async function getAppUrl(requestHeaders?: Headers): Promise<string> {
	const h = requestHeaders ?? (await headers());
	return resolveAppUrl({
		appUrl: process.env.APP_URL,
		forwardedProto: h.get("x-forwarded-proto"),
		forwardedHost: h.get("x-forwarded-host"),
		host: h.get("host"),
		vercelUrl:
			process.env.VERCEL_PROJECT_PRODUCTION_URL ?? process.env.VERCEL_URL,
	});
}
