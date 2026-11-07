/// <reference types="node" />
import { DatabaseSync } from "node:sqlite";
import type { Sql } from "../src/inbox.ts";

/** Durable Object の SQLite の代わりに node の SQLite を使う */
export function memorySql(): Sql {
	const db = new DatabaseSync(":memory:");
	return {
		exec: (query, ...bindings) => {
			const statement = db.prepare(query);
			if (statement.columns().length === 0) {
				statement.run(...bindings);
				return { toArray: () => [] };
			}
			const rows = statement.all(...bindings) as Record<string, unknown>[];
			return { toArray: () => rows };
		},
	};
}
