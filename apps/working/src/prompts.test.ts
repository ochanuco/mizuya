import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	acceptTitle,
	buildSeatPreamble,
	WORKING_INSTRUCTIONS,
} from "./prompts.ts";

const handoff = join(import.meta.dirname, "..", "handoff");

describe("buildSeatPreamble", () => {
	it("人格、仕事のしかた、引き継ぎの手順、申し送りの雛形の順に並べる", () => {
		const handoffPrompt = readFileSync(join(handoff, "prompt.md"), "utf8");
		const issueTemplate = readFileSync(
			join(handoff, "issue-template.md"),
			"utf8",
		);
		const text = buildSeatPreamble({
			persona: "あなたは人格である。\n",
			handoffPrompt,
			issueTemplate,
		});
		const order = [
			"あなたは人格である。",
			WORKING_INSTRUCTIONS.trim(),
			handoffPrompt.trim(),
			issueTemplate.trim(),
		].map((part) => text.indexOf(part));
		expect(order.every((i) => i >= 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
	});
});

describe("workingInstructions", () => {
	it.each(["Yukarin", "Akarin"])(
		"%s の席は見張りを自分で登録・停止し、登録した内容を返事に書く",
		(name) => {
			const text = buildSeatPreamble({
				persona: "",
				handoffPrompt: "",
				issueTemplate: "",
				partnerName: name,
			});
			expect(text).toContain("yunomi-memory watch-add --query");
			expect(text).toContain("--source");
			expect(text).toContain("--interval-hours");
			expect(text).toContain("--until");
			expect(text).toContain("yunomi-memory watch-stop --id");
			expect(text).toContain("何を・どこを・何時間おきに見張るか");
			expect(text).not.toContain("登録と停止は会話のとき");
		},
	);
});

describe("acceptTitle", () => {
	it("1 行の件名はそのまま、件名: や括弧は外して受ける", () => {
		expect(acceptTitle("先月分の請求書の整理\n")).toBe("先月分の請求書の整理");
		expect(acceptTitle("件名: 見積もりの比較")).toBe("見積もりの比較");
		expect(acceptTitle("「見積もりの比較」")).toBe("見積もりの比較");
	});

	it("前置き・メタ発言・複数行・句点・40 字超は弾く", () => {
		expect(
			acceptTitle("件名だけを出力する依頼なので、要約を返します。"),
		).toBeNull();
		expect(acceptTitle("承知しました\n請求書の整理")).toBeNull();
		expect(acceptTitle("以下の内容を要約します")).toBeNull();
		expect(acceptTitle("請求書を整理しました。")).toBeNull();
		expect(acceptTitle("あ".repeat(41))).toBeNull();
		expect(acceptTitle("  ")).toBeNull();
	});
});
