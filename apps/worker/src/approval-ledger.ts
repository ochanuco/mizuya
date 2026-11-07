import type { Sql } from "./inbox.ts";

/**
 * 承認待ちを投稿したかの記録。GitHub は同じ承認待ちの workflow_job を、別の delivery で同時に複数送ることがある。
 * Discord のメッセージを探してからでは間に合わないので、投稿する前にここで先に取る。
 */
export type ApprovalLedger = {
	/** まだ誰も取っていなければ取って true。取られていれば false。 */
	claim: (key: string) => boolean;
	/** 投稿に失敗したときに手放し、次の配信で投稿し直せるようにする。 */
	release: (key: string) => void;
	/** 保持の期限を過ぎた記録を消す。残っていれば true。 */
	purge: () => boolean;
};

/** GitHub の承認待ちは最長 30 日で切れるので、それより長く持つ。 */
export const LEDGER_RETENTION_MS = 31 * 24 * 60 * 60_000;

/** 承認待ちを見分ける鍵。run と Environment の組で 1 つの承認になる。 */
export const approvalKey = (t: {
	repo: string;
	runId: number;
	environment: string;
}) => `${t.repo}#${t.runId}#${t.environment}`;

export const createApprovalLedger = (
	sql: Sql,
	opts: { now?: () => number } = {},
): ApprovalLedger => {
	const now = opts.now ?? Date.now;
	sql.exec(
		`CREATE TABLE IF NOT EXISTS claims (
			key TEXT PRIMARY KEY,
			claimed_at INTEGER NOT NULL
		)`,
	);
	return {
		claim: (key) =>
			sql
				.exec(
					"INSERT INTO claims (key, claimed_at) VALUES (?, ?) ON CONFLICT DO NOTHING RETURNING key",
					key,
					now(),
				)
				.toArray().length > 0,
		release: (key) => {
			sql.exec("DELETE FROM claims WHERE key = ?", key);
		},
		purge: () => {
			sql.exec(
				"DELETE FROM claims WHERE claimed_at < ?",
				now() - LEDGER_RETENTION_MS,
			);
			return sql.exec("SELECT key FROM claims LIMIT 1").toArray().length > 0;
		},
	};
};
