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

export const metadata: Metadata = {
	title: "Smultronstället",
	description: "Personal bookmarks feed and search.",
	// m14 (PWA): iOS has no manifest support for home-screen installs, so the
	// standalone/title/status-bar hints and the touch icon come from meta tags.
	appleWebApp: { capable: true, title: "Smultron", statusBarStyle: "default" },
	icons: { apple: "/apple-touch-icon.png" },
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
