import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	turbopack: {
		// Pin the workspace root to this monorepo — avoids Next.js misdetecting
		// it from an unrelated lockfile further up the directory tree.
		root: path.join(process.cwd(), ".."),
	},
};

export default nextConfig;
