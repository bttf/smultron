// One-shot icon generator (m14, PWA). Run with `node scripts/generate-icons.mjs`
// from web/. Rasterises an inline SVG strawberry into the PNG sizes the web
// manifest and iOS home screen need. The art is drawn with SVG shapes rather
// than the 🍓 emoji glyph: emoji fonts are not guaranteed to exist on the
// machine (or CI container) doing the rasterisation, and a missing font would
// silently produce blank icons.
//
// Outputs (checked in, regenerate only when the art changes):
//   public/icons/icon-192.png      any-purpose, art inset from the edges
//   public/icons/icon-512.png
//   public/icons/maskable-192.png  maskable, full-bleed bg + safe-zone padding
//   public/icons/maskable-512.png
//   src/app/apple-icon.png         180px, opaque background (iOS won't mask).
//                                  Lives in app/ (not public/) so it goes
//                                  through Next's `apple-icon` file convention
//                                  alongside app/icon.png — see layout.tsx for
//                                  why declaring icons in `metadata` instead
//                                  would drop the favicon.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.join(here, "..");
const publicDir = path.join(webDir, "public");
const iconsDir = path.join(publicDir, "icons");
const appDir = path.join(webDir, "src", "app");

const BERRY = "#e0313f";
const BERRY_DARK = "#b81f2c";
const LEAF = "#2f9e44";
const SEED = "#ffe8a3";
const BG = "#ffffff";
// Maskable full-bleed background: a light berry tint, not BERRY itself —
// the berry body would vanish against its own colour.
const MASK_BG = "#ffe9ec";

/**
 * Draws the strawberry on a 100x100 user-space canvas, scaled/translated so
 * the art occupies `artFraction` of the icon and stays centred. A maskable
 * icon just uses a smaller fraction (more padding) and a full-bleed
 * background, per the maskable safe-zone guidance (art within the middle 80%).
 */
function svg({ size, artFraction, rounded, background }) {
	const art = size * artFraction;
	const offset = (size - art) / 2;
	const scale = art / 100;
	const radius = rounded ? size * 0.22 : 0;

	// Seeds scattered over the berry body.
	const seeds = [
		[50, 46],
		[38, 53],
		[62, 53],
		[44, 63],
		[56, 63],
		[50, 73],
		[33, 44],
		[67, 44],
	]
		.map(
			([cx, cy]) =>
				`<ellipse cx="${cx}" cy="${cy}" rx="2.6" ry="3.6" fill="${SEED}"/>`,
		)
		.join("");

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="${background}"/>
  <g transform="translate(${offset} ${offset}) scale(${scale})">
    <path d="M50 88 C24 76 16 56 20 42 C23 31 34 26 50 30 C66 26 77 31 80 42 C84 56 76 76 50 88 Z" fill="${BERRY}"/>
    <path d="M50 88 C68 79 78 62 80 46 C74 60 64 76 50 84 Z" fill="${BERRY_DARK}" opacity="0.45"/>
    ${seeds}
    <path d="M50 32 C42 32 34 29 30 24 C38 22 45 23 50 26 C55 23 62 22 70 24 C66 29 58 32 50 32 Z" fill="${LEAF}"/>
    <rect x="47.5" y="12" width="5" height="13" rx="2.5" fill="${LEAF}"/>
  </g>
</svg>`;
}

async function render(file, markup, size) {
	const buf = await sharp(Buffer.from(markup)).png().toBuffer();
	const meta = await sharp(buf).metadata();
	if (meta.width !== size || meta.height !== size) {
		throw new Error(`${file}: expected ${size}px, got ${meta.width}px`);
	}
	// Guard against the "blank icon" failure mode: a fully uniform image means
	// nothing drew.
	const { channels } = await sharp(buf).stats();
	const flat = channels.every((c) => c.min === c.max);
	if (flat) {
		throw new Error(`${file}: rasterised to a flat image (nothing drew)`);
	}
	await writeFile(file, buf);
	return buf.length;
}

await mkdir(iconsDir, { recursive: true });

const targets = [
	// any-purpose: art inset a little, rounded-square background.
	[path.join(iconsDir, "icon-192.png"), 192, 0.82, true, BG],
	[path.join(iconsDir, "icon-512.png"), 512, 0.82, true, BG],
	// maskable: full-bleed berry-tinted background, art inside the 80% safe zone.
	[path.join(iconsDir, "maskable-192.png"), 192, 0.62, false, MASK_BG],
	[path.join(iconsDir, "maskable-512.png"), 512, 0.62, false, MASK_BG],
	// iOS home screen: opaque, square (iOS applies its own rounding).
	[path.join(appDir, "apple-icon.png"), 180, 0.82, false, BG],
];

for (const [file, size, artFraction, rounded, background] of targets) {
	const bytes = await render(
		file,
		svg({ size, artFraction, rounded, background }),
		size,
	);
	console.log(`wrote ${path.relative(webDir, file)} (${size}px, ${bytes}B)`);
}
