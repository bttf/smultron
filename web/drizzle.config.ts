import { defineConfig } from "drizzle-kit";

// Migrations use the direct (non-pooled) connection — see AGENTS.md.
const directUrl = process.env.DIRECT_URL;
if (!directUrl) {
	throw new Error("DIRECT_URL is not set");
}

export default defineConfig({
	dialect: "postgresql",
	schema: "./src/db/schema.ts",
	out: "./drizzle",
	dbCredentials: {
		url: directUrl,
	},
});
