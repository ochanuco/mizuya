import { describe, expect, it } from "vitest";
import {
	approvalKey,
	createApprovalLedger,
	LEDGER_RETENTION_MS,
} from "../src/approval-ledger.ts";
import { memorySql } from "./sql.ts";

describe("承認待ちの投稿の記録", () => {
	const key = approvalKey({
		repo: "example/app",
		runId: 1,
		environment: "production-approval",
	});

	it("同じ承認待ちは 1 回だけ取れ、手放せばまた取れる", () => {
		const ledger = createApprovalLedger(memorySql());
		expect(ledger.claim(key)).toBe(true);
		expect(ledger.claim(key)).toBe(false);
		ledger.release(key);
		expect(ledger.claim(key)).toBe(true);
	});

	it("run か Environment が違えば別の承認待ち", () => {
		const ledger = createApprovalLedger(memorySql());
		expect(ledger.claim(key)).toBe(true);
		expect(
			ledger.claim(
				approvalKey({
					repo: "example/app",
					runId: 2,
					environment: "production-approval",
				}),
			),
		).toBe(true);
		expect(
			ledger.claim(
				approvalKey({ repo: "example/app", runId: 1, environment: "staging" }),
			),
		).toBe(true);
	});

	it("保持の期限を過ぎた記録は消える", () => {
		let now = 1_000_000_000_000;
		const ledger = createApprovalLedger(memorySql(), { now: () => now });
		ledger.claim(key);
		expect(ledger.purge()).toBe(true);
		now += LEDGER_RETENTION_MS + 1;
		expect(ledger.purge()).toBe(false);
		expect(ledger.claim(key)).toBe(true);
	});
});
