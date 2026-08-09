import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { RegisterServiceWorker } from "./register-sw";

const geistSans = Geist({
	variable: "--font-geist-sans",
	subsets: ["latin"],
});

const geistMono = Geist_Mono({
	variable: "--font-geist-mono",
	subsets: ["latin"],
});

// Icons come from the file convention ONLY — `app/icon.png` (favicon) and
// `app/apple-icon.png` (iOS touch icon). Do NOT add an `icons` field here:
// Next merges the file-convention icons into the resolved metadata only when
// `icons` is still unset (`resolveMetadata` in next/dist/lib/metadata), so any
// `icons` object silently drops BOTH file-based icons. m16 hit exactly that —
// `icons: { apple: ... }` suppressed the favicon. See layout.test.ts.
export const metadata: Metadata = {
	title: "Smultronstället",
	description: "Personal bookmarks feed and search.",
	// m16 (PWA): iOS has no manifest support for home-screen installs, so the
	// standalone/title/status-bar hints come from meta tags.
	appleWebApp: { capable: true, title: "Smultron", statusBarStyle: "default" },
};

// Separate from `metadata` since Next 14 — themeColor/viewport live here.
export const viewport: Viewport = {
	themeColor: [
		{ media: "(prefers-color-scheme: light)", color: "#ffffff" },
		{ media: "(prefers-color-scheme: dark)", color: "#242424" },
	],
};

export default function RootLayout({
	children,
}: Readonly<{
	children: React.ReactNode;
}>) {
	return (
		<html
			lang="en"
			className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
		>
			<body className="min-h-full flex flex-col">
				{children}
				<RegisterServiceWorker />
			</body>
		</html>
	);
}
