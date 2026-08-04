// Web app manifest (m14, PWA). Next serves this route at
// /manifest.webmanifest (see node_modules/next/dist/docs/01-app/
// 03-api-reference/03-file-conventions/01-metadata/manifest.md) and injects
// the <link rel="manifest"> tag for us — the proxy matcher excludes
// `.webmanifest` so it is fetchable without a session.
//
// `share_target` makes the installed app appear in the Android share sheet;
// shares land on GET /share, which adds the bookmark (src/app/share/route.ts).
import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
	return {
		name: "Smultronstället",
		short_name: "Smultron",
		description: "Personal bookmarks feed and search.",
		start_url: "/",
		display: "standalone",
		background_color: "#ffffff",
		theme_color: "#ffffff",
		icons: [
			{
				src: "/icons/icon-192.png",
				sizes: "192x192",
				type: "image/png",
				purpose: "any",
			},
			{
				src: "/icons/icon-512.png",
				sizes: "512x512",
				type: "image/png",
				purpose: "any",
			},
			{
				src: "/icons/maskable-192.png",
				sizes: "192x192",
				type: "image/png",
				purpose: "maskable",
			},
			{
				src: "/icons/maskable-512.png",
				sizes: "512x512",
				type: "image/png",
				purpose: "maskable",
			},
		],
		share_target: {
			action: "/share",
			method: "GET",
			params: { title: "title", text: "text", url: "url" },
		},
	};
}
