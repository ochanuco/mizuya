import type { ApprovalLedger } from "./approval-ledger-object.ts";
import type { WorkingInbox } from "./inbox-object.ts";

// secret は wrangler.jsonc に書かないので、`wrangler types` の Env には出てこない。ここで型を持つ
export type Bindings = {
	GITHUB_WEBHOOK_SECRET: string;
	GITHUB_APPROVER_TOKEN: string;
	DISCORD_PUBLIC_KEY: string;
	DISCORD_BOT_TOKEN: string;
	DISCORD_APPROVER_USER_ID: string;
	DISCORD_APPROVAL_CHANNEL_ID: string;
	/** Working が受け箱につなぐときの token。無ければ受け箱の口を閉じる */
	WORKING_INBOX_TOKEN?: string;
	WORKING_INBOX: DurableObjectNamespace<WorkingInbox>;
	APPROVAL_LEDGER: DurableObjectNamespace<ApprovalLedger>;
};

export type WaitUntil = (promise: Promise<unknown>) => void;

/** 受け箱は 1 つだけ持つ */
export const inboxOf = (env: Bindings) =>
	env.WORKING_INBOX.get(env.WORKING_INBOX.idFromName("working"));

/** 承認待ちの投稿の記録も 1 つだけ持つ */
export const approvalLedgerOf = (env: Bindings) =>
	env.APPROVAL_LEDGER.get(env.APPROVAL_LEDGER.idFromName("approvals"));
