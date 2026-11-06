// hook として node で直接動かすため、node の組み込み以外を import しない。
import {
	appendFileSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type GrantFile, grantPathOf } from "./env.ts";
import type { Operation } from "./operation.ts";

/**
 * 止めた操作・使った許可・許可のやりとりを volume に残す。
 * hook（操作のたびに起動する別プロセス）と受付の両方が読み書きするので、ファイルで受け渡す。
 */
export type ApprovalEvent =
	| {
			event: "blocked";
			thread_id: string;
			operation: Operation;
			reason: string;
	  }
	| { event: "used"; thread_id: string; grant_id: string; operation: Operation }
	| {
			event: "requested";
			thread_id: string;
			message_id: string;
			operations: Operation[];
	  }
	| {
			event: "granted";
			thread_id: string;
			grant_id: string;
			message_id: string;
			operations: Operation[];
	  }
	| {
			event: "expired";
			thread_id: string;
			grant_id: string;
			operations: Operation[];
	  }
	| { event: "dismissed"; thread_id: string; operations: Operation[] };

export type Pending = { operation: Operation; reason: string };

const safeName = (s: string) => (/^[A-Za-z0-9_-]+$/.test(s) ? s : "_");

const readLines = <T>(path: string): T[] => {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return [];
	}
	const out: T[] = [];
	for (const line of raw.split("\n")) {
		if (line.trim() === "") continue;
		try {
			out.push(JSON.parse(line) as T);
		} catch {
			// 書きかけの行は読まない
		}
	}
	return out;
};

const append = (path: string, value: unknown) => {
	mkdirSync(join(path, ".."), { recursive: true });
	appendFileSync(path, `${JSON.stringify(value)}\n`);
};

export const createLedger = (
	dir: string,
	now: () => Date = () => new Date(),
) => {
	const pendingPath = (threadId: string) =>
		join(dir, "pending", `${safeName(threadId)}.jsonl`);
	const usedPath = (grantId: string) =>
		join(dir, "used", `${safeName(grantId)}.jsonl`);

	return {
		log: (e: ApprovalEvent) =>
			append(join(dir, "log.jsonl"), { t: now().toISOString(), ...e }),
		addPending: (threadId: string, p: Pending) =>
			append(pendingPath(threadId), p),
		/** 止めた操作を取り出して消す。受付が 1 回の作業の後に呼ぶ。 */
		takePending: (threadId: string): Pending[] => {
			const path = pendingPath(threadId);
			const taking = `${path}.taking`;
			try {
				renameSync(path, taking);
			} catch {
				return [];
			}
			const items = readLines<Pending>(taking);
			rmSync(taking, { force: true });
			return items;
		},
		used: (grantId: string): Operation[] => readLines(usedPath(grantId)),
		markUsed: (grantId: string, op: Operation) => append(usedPath(grantId), op),
		clearUsed: (grantId: string) => rmSync(usedPath(grantId), { force: true }),
		/** 持ち主が許可した操作を、その投稿の席の hook に渡す。 */
		grant: (threadId: string, grant: GrantFile) => {
			const path = grantPathOf(dir, threadId);
			mkdirSync(join(path, ".."), { recursive: true });
			writeFileSync(`${path}.tmp`, JSON.stringify(grant));
			renameSync(`${path}.tmp`, path);
		},
		/** 渡していた許可を取り下げて返す。 */
		takeGrant: (threadId: string): GrantFile | null => {
			const path = grantPathOf(dir, threadId);
			let raw: string;
			try {
				raw = readFileSync(path, "utf8");
			} catch {
				return null;
			}
			rmSync(path, { force: true });
			try {
				return JSON.parse(raw) as GrantFile;
			} catch {
				return null;
			}
		},
	};
};

export type Ledger = ReturnType<typeof createLedger>;
