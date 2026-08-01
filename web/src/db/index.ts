import "server-only";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export * as schema from "./schema";

type Db = ReturnType<typeof drizzle<typeof schema>>;

let _db: Db | undefined;

// Lazy singleton: importing this module must not throw when DATABASE_URL is
// unset (e.g. at build time). It only throws when a query is actually run.
function getDb(): Db {
	if (_db) {
		return _db;
	}

	const url = process.env.DATABASE_URL;
	if (!url) {
		throw new Error("DATABASE_URL is not set");
	}

	// Pooled connection (pgbouncer, port 6543) — prepared statements are
	// unsupported in transaction-pooling mode.
	const client = postgres(url, { prepare: false });
	_db = drizzle(client, { schema });
	return _db;
}

export const db: Db = new Proxy({} as Db, {
	get(_target, prop, receiver) {
		return Reflect.get(getDb() as object, prop, receiver);
	},
});
