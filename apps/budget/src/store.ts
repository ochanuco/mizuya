import type { Period } from "./period.ts";
import type { UsageRow } from "./usage.ts";

type DbRow = {
	period_start: string;
	charge_date: string;
	service_name: string;
	service_family: string;
	cost: number;
	quantity: number | null;
	unit: string | null;
};

const fromDb = (r: DbRow): UsageRow => ({
	periodStart: r.period_start,
	chargeDate: r.charge_date,
	serviceName: r.service_name,
	serviceFamily: r.service_family,
	cost: r.cost,
	quantity: r.quantity,
	unit: r.unit,
});

/**
 * 取り直した範囲 [from, to) の行を入れ替える。請求の数字は後から直ることがあり、
 * 消えた製品の行を残さないよう、範囲の行を消してから入れる。to の日は API が含むか分からないので消さずに上書きだけする
 */
export async function replaceUsage(
	db: D1Database,
	from: string,
	to: string,
	rows: UsageRow[],
): Promise<void> {
	const upsert = db.prepare(
		`INSERT INTO usage (period_start, charge_date, service_name, service_family, cost, quantity, unit)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT (period_start, charge_date, service_name) DO UPDATE SET
		   service_family = excluded.service_family,
		   cost = excluded.cost,
		   quantity = excluded.quantity,
		   unit = excluded.unit`,
	);
	await db.batch([
		db
			.prepare("DELETE FROM usage WHERE charge_date >= ? AND charge_date < ?")
			.bind(from, to),
		...rows.map((r) =>
			upsert.bind(
				r.periodStart,
				r.chargeDate,
				r.serviceName,
				r.serviceFamily,
				r.cost,
				r.quantity,
				r.unit,
			),
		),
	]);
}

/** 今期の行と、前日の行 */
export async function loadUsage(
	db: D1Database,
	periodStart: string,
	yesterday: string,
): Promise<UsageRow[]> {
	const { results } = await db
		.prepare(
			"SELECT * FROM usage WHERE period_start = ? OR charge_date = ? ORDER BY charge_date, service_name",
		)
		.bind(periodStart, yesterday)
		.all<DbRow>();
	return results.map(fromDb);
}

export async function notifiedKinds(
	db: D1Database,
	periodStart: string,
): Promise<Set<string>> {
	const { results } = await db
		.prepare("SELECT kind FROM notified WHERE period_start = ?")
		.bind(periodStart)
		.all<{ kind: string }>();
	return new Set(results.map((r) => r.kind));
}

export async function recordNotified(
	db: D1Database,
	periodStart: string,
	kinds: string[],
	at: Date,
): Promise<void> {
	if (kinds.length === 0) return;
	const insert = db.prepare(
		"INSERT OR IGNORE INTO notified (period_start, kind, notified_at) VALUES (?, ?, ?)",
	);
	await db.batch(
		kinds.map((kind) => insert.bind(periodStart, kind, at.toISOString())),
	);
}

export type Fetched = { at: string; period: Period };

export async function recordFetched(
	db: D1Database,
	fetched: Fetched,
): Promise<void> {
	const upsert = db.prepare(
		"INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
	);
	await db.batch([
		upsert.bind("fetched_at", fetched.at),
		upsert.bind("period_start", fetched.period.start),
		upsert.bind("period_end", fetched.period.end),
	]);
}

export async function loadFetched(db: D1Database): Promise<Fetched | null> {
	const { results } = await db
		.prepare("SELECT key, value FROM meta")
		.all<{ key: string; value: string }>();
	const meta = new Map(results.map((r) => [r.key, r.value]));
	const at = meta.get("fetched_at");
	const start = meta.get("period_start");
	const end = meta.get("period_end");
	if (!at || !start || !end) return null;
	return { at, period: { start, end } };
}
