import { describe, expect, it } from "vitest";
import {
	APPROVAL_ASK,
	APPROVAL_BUTTONS,
	approvalAnswerOf,
	approvalRequestText,
	isApproval,
	settledApprovalText,
	uniquePending,
} from "./approval.ts";
import { DISMISS_ASK } from "./dismiss.ts";

const request = { messageIds: ["req1", "req2"], operations: [] };

describe("isApproval", () => {
	it.each(["OK", "ok", "ＯＫ", "OK!", "許可", "許可します。", "<@123> OK"])(
		"%s は許可",
		(content) => {
			expect(isApproval({ content, replyToMessageId: null }, request)).toBe(
				true,
			);
		},
	);

	it.each(["OKだけど待って", "いいよ", "うん", "OK? やめとく", ""])(
		"%s は許可にしない",
		(content) => {
			expect(isApproval({ content, replyToMessageId: null }, request)).toBe(
				false,
			);
		},
	);

	it("返信なら、許可を求めたメッセージへの返信だけを許可にする", () => {
		expect(
			isApproval({ content: "OK", replyToMessageId: "req2" }, request),
		).toBe(true);
		expect(
			isApproval({ content: "OK", replyToMessageId: "other" }, request),
		).toBe(false);
	});
});

describe("approvalRequestText", () => {
	it("同じ操作は 1 つにまとめ、コマンドをそのまま見せる", () => {
		const op = { tool: "Bash", target: "git push origin main" };
		const items = uniquePending([
			{ operation: op, reason: "dev/ 以外のブランチへの push" },
			{ operation: op, reason: "dev/ 以外のブランチへの push" },
			{
				operation: { tool: "Write", target: "/home/worker/.bashrc" },
				reason: "作業場所の外への書き込み",
			},
		]);
		const text = approvalRequestText(items);
		expect(text).toContain(
			"1. dev/ 以外のブランチへの push\n```\ngit push origin main\n```",
		);
		expect(text).toContain(
			"2. 作業場所の外への書き込み\n```\nWrite: /home/worker/.bashrc\n```",
		);
		expect(text).not.toContain("「OK」か「許可」");
	});
});

describe("許可のボタン", () => {
	it("付けたボタンの custom_id だけを許可か却下として読む", () => {
		expect(APPROVAL_BUTTONS.map((b) => approvalAnswerOf(b.customId))).toEqual([
			"grant",
			"deny",
		]);
		expect(approvalAnswerOf("other:grant")).toBeNull();
	});

	it("片付いた依頼は、頼みの文を結果に置き換える", () => {
		const text = `${APPROVAL_ASK}\n${DISMISS_ASK}`;
		const granted = settledApprovalText(text, "grant");
		expect(granted).toContain(DISMISS_ASK);
		expect(granted).toContain("許可済み");
		expect(granted).not.toContain("「OK」か「許可」");
		expect(settledApprovalText(text, "deny")).toContain("却下済み");
		expect(settledApprovalText("前置きだけ", "deny")).toBe(
			"前置きだけ\n\n却下済み: 書いてある操作は実行しません。",
		);
	});
});
