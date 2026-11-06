import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as v from "valibot";
import type { Operation } from "./guard/operation.ts";

const operationSchema = v.object({ tool: v.string(), target: v.string() });
const fileSchema = v.object({
	threads: v.record(
		v.string(),
		v.object({
			message_ids: v.array(v.string()),
			operations: v.array(operationSchema),
		}),
	),
});

/** 投稿で持ち主に許可を求めている操作と、求めたメッセージ。 */
export type ApprovalRequest = {
	messageIds: readonly string[];
	operations: readonly Operation[];
};

export type ApprovalStore = {
	get: (threadId: string) => ApprovalRequest | null;
	set: (threadId: string, req: ApprovalRequest) => Promise<void>;
	delete: (threadId: string) => Promise<void>;
};

/**
 * 許可を待っている操作。受付を作り直しても OK の返事を受けられるよう volume 上の JSON に置く。
 * 受付が起動したときだけ読み、以降は手元の内容を正とする（作業中の Claude CLI に書き換えられても使わない）。
 */
export const openApprovalStore = async (
	dir: string,
): Promise<ApprovalStore> => {
	await mkdir(dir, { recursive: true });
	const path = join(dir, "approvals.json");
	const requests = new Map<string, ApprovalRequest>();
	const raw = await readFile(path, "utf8").catch(() => null);
	if (raw !== null) {
		const parsed = v.safeParse(
			fileSchema,
			(() => {
				try {
					return JSON.parse(raw);
				} catch {
					return null;
				}
			})(),
		);
		if (!parsed.success) {
			throw new Error(`${path} を読めない`);
		}
		for (const [id, r] of Object.entries(parsed.output.threads)) {
			requests.set(id, { messageIds: r.message_ids, operations: r.operations });
		}
	}

	let writing: Promise<void> = Promise.resolve();
	const flush = () => {
		const body = {
			threads: Object.fromEntries(
				[...requests].map(([id, r]) => [
					id,
					{ message_ids: r.messageIds, operations: r.operations },
				]),
			),
		};
		writing = writing.then(async () => {
			const tmp = `${path}.tmp`;
			await writeFile(tmp, JSON.stringify(body, null, "\t"));
			await rename(tmp, path);
		});
		return writing;
	};

	return {
		get: (threadId) => requests.get(threadId) ?? null,
		set: (threadId, req) => {
			requests.set(threadId, req);
			return flush();
		},
		delete: (threadId) => {
			if (!requests.delete(threadId)) return Promise.resolve();
			return flush();
		},
	};
};
