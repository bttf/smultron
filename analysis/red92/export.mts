// RED-92 scratch: snapshot every browse_event to a local JSON file so the
// analysis runs offline against a frozen dataset (and never hammers prod).
// Run from web/ so the `postgres` driver resolves:
//   cd web && set -a && . ./.env.local && set +a && node_modules/.bin/tsx ../analysis/red92/export.mts
import { writeFileSync } from "node:fs";
import postgres from "../../web/node_modules/postgres/src/index.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");
const sql = postgres(url, { prepare: false });

const rows = await sql`
  select id, user_id, client_event_id, boot_id, kind,
         (extract(epoch from occurred_at) * 1000)::bigint as occurred_at_ms,
         url, url_normalized, title, tab_id, window_id, idle_state, transition, document_lifecycle
  from smultron.browse_events
  order by occurred_at asc, id asc`;

const out = new URL("./data/events.json", import.meta.url);
writeFileSync(
	out,
	JSON.stringify(
		rows.map((r) => ({ ...r, occurred_at_ms: Number(r.occurred_at_ms) })),
	),
);
console.log(`wrote ${rows.length} events to ${out.pathname}`);
await sql.end();
