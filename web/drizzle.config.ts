import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

config({ path: ".env.local" });

// Migrations use the direct (non-pooled) connection — see AGENTS.md.
// No throw here: `drizzle-kit generate` only reads the schema and must work
// without a real DB configured (e.g. in CI). `drizzle-kit migrate` needs a
// real DIRECT_URL and will fail loudly against an empty string.
const directUrl = process.env.DIRECT_URL ?? "";

export default defineConfig({
	dialect: "postgresql",
	schema: "./src/db/schema.ts",
	out: "./drizzle",
	dbCredentials: {
		url: directUrl,
	},
});
