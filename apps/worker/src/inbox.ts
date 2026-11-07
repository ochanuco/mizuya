import * as v from "valibot";

/**
 * Working の受け箱。Worker が受けた仕事向けの出来事（ボタン、`/ai` コマンド、GitHub の出来事）を置き、
 * 外向きの WebSocket でつないだ Working に渡す。Working は受け取った行を ack し、ack した行だけを消す。
 */

export const INBOX_KINDS = ["button", "command", "github"] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

export type InboxItem = {
	id: string;
	kind: InboxKind;
	received_at: string;
	body: unknown;
};

/** Working が接続を保つために送る文字列と、Durable Object が起きずに返す文字列。 */
export const INBOX_PING = "ping";
export const INBOX_PONG = "pong";

/** Worker から Working に送る形。 */
export type InboxPush = { type: "item" } & InboxItem;

/** ボタンとコマンドの interaction の token は 15 分で切れ、その後に効いても押した人には何も返せない。 */
export const BUTTON_MAX_AGE_MS = 15 * 60_000;
/** これより古い GitHub の出来事は渡さない。Working が長く止まっていた分は見回りが拾う。 */
export const GITHUB_MAX_AGE_MS = 6 * 60 * 60_000;
/** 渡せないまま残った行を消すまでの時間。 */
export const RETENTION_MS = 24 * 60 * 60_000;

const maxAgeOf = (kind: InboxKind) =>
	kind === "github" ? GITHUB_MAX_AGE_MS : BUTTON_MAX_AGE_MS;

/** Durable Object の SQLite のうち、受け箱が使う分。 */
export type Sql = {
	exec: (
		query: string,
		...bindings: (string | number | null)[]
	) => { toArray: () => Record<string, unknown>[] };
};

type Row = {
	id: string;
	kind: InboxKind;
	dedupe: string | null;
	body: string;
	received_at: number;
};

const ackSchema = v.object({
	type: v.literal("ack"),
	id: v.pipe(v.string(), v.nonEmpty()),
});

export type Inbox = {
	/** 置いた行を返す。dedupe が同じ行がもうあれば置かずに null。 */
	put: (
		kind: InboxKind,
		body: unknown,
		dedupe?: string | null,
	) => InboxItem | null;
	/** 渡してよい行を古い順に返す。古すぎる行はここで消す。 */
	pending: () => InboxItem[];
	/** Working からのメッセージを読む。ack なら行を消して true。 */
	ack: (message: string) => boolean;
	/** 保持の期限を過ぎた行を消す。 */
	purge: () => void;
};

const toItem = (r: Row): InboxItem => ({
	id: r.id,
	kind: r.kind,
	received_at: new Date(r.received_at).toISOString(),
	body: JSON.parse(r.body),
});

export const createInbox = (
	sql: Sql,
	opts: { now?: () => number; newId?: () => string } = {},
): Inbox => {
	const now = opts.now ?? Date.now;
	// id は時刻を頭に置き、文字列の順が置いた順になるようにする
	const newId =
		opts.newId ??
		(() => `${now().toString().padStart(15, "0")}-${crypto.randomUUID()}`);
	sql.exec(
		`CREATE TABLE IF NOT EXISTS items (
			id TEXT PRIMARY KEY,
			kind TEXT NOT NULL,
			dedupe TEXT UNIQUE,
			body TEXT NOT NULL,
			received_at INTEGER NOT NULL
		)`,
	);
	return {
		put: (kind, body, dedupe = null) => {
			const row: Row = {
				id: newId(),
				kind,
				dedupe,
				body: JSON.stringify(body),
				received_at: now(),
			};
			const inserted = sql
				.exec(
					"INSERT INTO items (id, kind, dedupe, body, received_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING id",
					row.id,
					row.kind,
					row.dedupe,
					row.body,
					row.received_at,
				)
				.toArray();
			return inserted.length > 0 ? toItem(row) : null;
		},
		pending: () => {
			const at = now();
			for (const kind of INBOX_KINDS) {
				sql.exec(
					"DELETE FROM items WHERE kind = ? AND received_at < ?",
					kind,
					at - maxAgeOf(kind),
				);
			}
			const rows = sql
				.exec("SELECT * FROM items ORDER BY id")
				.toArray() as Row[];
			return rows.map(toItem);
		},
		ack: (message) => {
			let json: unknown;
			try {
				json = JSON.parse(message);
			} catch {
				return false;
			}
			const parsed = v.safeParse(ackSchema, json);
			if (!parsed.success) return false;
			sql.exec("DELETE FROM items WHERE id = ?", parsed.output.id);
			return true;
		},
		purge: () => {
			sql.exec("DELETE FROM items WHERE received_at < ?", now() - RETENTION_MS);
		},
	};
};
