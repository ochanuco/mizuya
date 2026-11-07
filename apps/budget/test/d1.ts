/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

type Statement = {
	bind: (...values: unknown[]) => Statement;
	run: () => Promise<{ success: true }>;
	all: () => Promise<{ results: Record<string, unknown>[] }>;
	execute: () => void;
};

/** D1 の代わりに node の SQLite を使う。store.ts が使う prepare・bind・run・all・batch だけを持つ */
export function memoryD1(): { db: D1Database; raw: DatabaseSync } {
	const raw = new DatabaseSync(":memory:");
	raw.exec(
		readFileSync(
			join(import.meta.dirname, "../migrations/0001_init.sql"),
			"utf8",
		),
	);
	const prepare = (query: string, values: unknown[] = []): Statement => {
		const statement = raw.prepare(query);
		const args = values as SQLInputValue[];
		return {
			bind: (...next) => prepare(query, next),
			execute: () => {
				statement.run(...args);
			},
			run: async () => {
				statement.run(...args);
				return { success: true };
			},
			all: async () => ({
				results: statement.all(...args) as Record<string, unknown>[],
			}),
		};
	};
	const db = {
		prepare: (query: string) => prepare(query),
		batch: async (statements: Statement[]) => {
			raw.exec("BEGIN");
			try {
				for (const s of statements) s.execute();
				raw.exec("COMMIT");
			} catch (e) {
				raw.exec("ROLLBACK");
				throw e;
			}
			return [];
		},
	};
	return { db: db as unknown as D1Database, raw };
}
