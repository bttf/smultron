import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Regression guard for the m14 favicon regression.
//
// Next collects `app/icon.*` / `app/apple-icon.*` into `leafSegmentStaticIcons`
// and merges them into the resolved metadata behind an `if (!resolvedMetadata
// .icons)` check (next/dist/lib/metadata/resolve-metadata.js). So declaring an
// `icons` field in `metadata` — even a partial one that only sets `apple` —
// makes Next drop BOTH file-convention icons and emit no `<link rel="icon">`
// at all. That is exactly how the favicon vanished when m14 added
// `icons: { apple: "/apple-touch-icon.png" }`.
//
// layout.tsx can't be imported here (it pulls in globals.css and next/font at
// module scope), so this asserts on the source text plus the icon files.

const appDir = path.dirname(fileURLToPath(import.meta.url));
const layoutSource = readFileSync(path.join(appDir, "layout.tsx"), "utf8");

describe("root layout icons", () => {
	it("ships both file-convention icons in app/", () => {
		// Non-empty PNGs — a zero-byte file would still 'exist' but render nothing.
		expect(readFileSync(path.join(appDir, "icon.png")).length).toBeGreaterThan(
			0,
		);
		expect(
			readFileSync(path.join(appDir, "apple-icon.png")).length,
		).toBeGreaterThan(0);
	});

	it("declares no `icons` metadata field, which would drop them", () => {
		expect(layoutSource).not.toMatch(/^\s*icons\s*:/m);
	});
});
