import { DurableObject } from "cloudflare:workers";
import {
	createApprovalLedger,
	LEDGER_RETENTION_MS,
	type ApprovalLedger as Ledger,
} from "./approval-ledger.ts";
import type { Bindings } from "./env.ts";

/** 承認待ちの投稿の記録を 1 つだけ持つ Durable Object。呼び出しは 1 つずつ処理されるので、同時の配信でも取れるのは 1 つ。 */
export class ApprovalLedger extends DurableObject<Bindings> {
	private readonly ledger: Ledger;

	constructor(ctx: DurableObjectState, env: Bindings) {
		super(ctx, env);
		this.ledger = createApprovalLedger(ctx.storage.sql);
	}

	async claim(key: string): Promise<boolean> {
		const claimed = this.ledger.claim(key);
		if (claimed && (await this.ctx.storage.getAlarm()) === null) {
			await this.ctx.storage.setAlarm(Date.now() + LEDGER_RETENTION_MS);
		}
		return claimed;
	}

	async release(key: string): Promise<void> {
		this.ledger.release(key);
	}

	override async alarm(): Promise<void> {
		if (this.ledger.purge()) {
			await this.ctx.storage.setAlarm(Date.now() + LEDGER_RETENTION_MS);
		}
	}
}
