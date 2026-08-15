import { defineConfig } from "vitest/config";

export default defineConfig({
	// `server-only` throws on import outside a React Server Component. Under
	// Vitest that guard is noise — these tests ARE the server — so resolve it
	// the way the RSC build does, to the package's empty module. Vitest loads
	// modules through the SSR pipeline, hence `ssr.resolve`.
	ssr: {
		resolve: {
			conditions: ["react-server", "node", "import", "default"],
			externalConditions: ["react-server", "node", "import", "default"],
		},
	},
	test: {
		environment: "node",
		include: ["src/**/*.test.ts"],
		passWithNoTests: true,
	},
});
