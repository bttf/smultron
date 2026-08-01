import { describe, expect, it } from "vitest";
import { resolveAppUrl } from "./appUrl";

describe("resolveAppUrl", () => {
	describe("APP_URL wins", () => {
		it("uses APP_URL over the request host", () => {
			expect(
				resolveAppUrl({
					appUrl: "https://smultron.redpine.software",
					forwardedHost: "smultron-abc123.vercel.app",
					forwardedProto: "https",
				}),
			).toBe("https://smultron.redpine.software");
		});

		it("strips a trailing slash and any path", () => {
			expect(
				resolveAppUrl({ appUrl: "https://smultron.redpine.software/" }),
			).toBe("https://smultron.redpine.software");
			expect(
				resolveAppUrl({ appUrl: "https://smultron.redpine.software/app/" }),
			).toBe("https://smultron.redpine.software");
		});

		it("keeps a non-default port (local dev)", () => {
			expect(resolveAppUrl({ appUrl: "http://localhost:3000" })).toBe(
				"http://localhost:3000",
			);
		});

		it("assumes https for a scheme-less host, http for a local one", () => {
			expect(resolveAppUrl({ appUrl: "smultron.redpine.software" })).toBe(
				"https://smultron.redpine.software",
			);
			expect(resolveAppUrl({ appUrl: "localhost:3000" })).toBe(
				"http://localhost:3000",
			);
		});

		it("ignores blank or unusable values and falls through", () => {
			for (const appUrl of ["", "   ", "ftp://example.com", ":://nope"]) {
				expect(
					resolveAppUrl({ appUrl, forwardedHost: "smultron.redpine.software" }),
				).toBe("https://smultron.redpine.software");
			}
		});
	});

	describe("request host fallback (APP_URL unset)", () => {
		it("derives the origin from x-forwarded-host/proto", () => {
			expect(
				resolveAppUrl({
					forwardedHost: "smultron.redpine.software",
					forwardedProto: "https",
					host: "smultron-abc123.vercel.app",
				}),
			).toBe("https://smultron.redpine.software");
		});

		it("falls back to the Host header", () => {
			expect(resolveAppUrl({ host: "smultron.redpine.software" })).toBe(
				"https://smultron.redpine.software",
			);
		});

		it("takes the first entry of comma-joined proxy headers", () => {
			expect(
				resolveAppUrl({
					forwardedHost: "smultron.redpine.software, internal.vercel.app",
					forwardedProto: "https, http",
				}),
			).toBe("https://smultron.redpine.software");
		});

		it("assumes https for a remote host when the proto header is absent", () => {
			expect(resolveAppUrl({ host: "smultron.redpine.software" })).toBe(
				"https://smultron.redpine.software",
			);
		});

		it("assumes http for a local host when the proto header is absent", () => {
			expect(resolveAppUrl({ host: "localhost:3000" })).toBe(
				"http://localhost:3000",
			);
		});

		it("prefers the request host over VERCEL_URL", () => {
			expect(
				resolveAppUrl({
					forwardedHost: "smultron.redpine.software",
					vercelUrl: "smultron-abc123.vercel.app",
				}),
			).toBe("https://smultron.redpine.software");
		});
	});

	describe("last resorts", () => {
		it("uses the scheme-less VERCEL_URL when there is no request host", () => {
			expect(resolveAppUrl({ vercelUrl: "smultron-abc123.vercel.app" })).toBe(
				"https://smultron-abc123.vercel.app",
			);
		});

		it("defaults to localhost only when nothing else is known", () => {
			expect(resolveAppUrl({})).toBe("http://localhost:3000");
		});
	});
});
