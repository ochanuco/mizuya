import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	acceptTitle,
	buildSeatPreamble,
	composeTitle,
	numberedTitle,
	parseTitle,
	unnumberedTitle,
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
			expect(text).toContain('--schedule "<cron 式>"');
			expect(text).toContain("0 9-18 * * 1-5");
			expect(text).toContain("--until");
			expect(text).toContain("yunomi-memory watch-stop --id");
			expect(text).toContain(
				"何を・どこを・いつ（何時間おきか、cron 式の時間帯と曜日）見張るか",
			);
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

describe("numberedTitle", () => {
	it("番号は要約の 40 字の枠の外で頭に付け、付け直しても重ねず、件名の上限で切る", () => {
		const title = "あ".repeat(40);
		expect(numberedTitle(1234, title)).toBe(`[1234] ${title}`);
		expect(numberedTitle(1234, `[1234] ${title}`)).toBe(`[1234] ${title}`);
		expect(numberedTitle(5678, "[1234] 件名")).toBe("[5678] 件名");
		const long = numberedTitle(1234, "い".repeat(120));
		expect(long).toHaveLength(100);
		expect(long.endsWith("…")).toBe(true);
		expect(unnumberedTitle("[1234] 件名")).toBe("件名");
		expect(unnumberedTitle("[12] 件名")).toBe("[12] 件名");
	});
});

describe("件名の絵文字と番号", () => {
	const EMOJIS = ["🎉", "🤔", "👀", "👨‍💼", "👷"];

	it("頭の既知の絵文字と番号を外して元の件名に戻す", () => {
		for (const e of EMOJIS) {
			expect(unnumberedTitle(`${e}[1234] 柄杓テスト`, EMOJIS)).toBe(
				"柄杓テスト",
			);
			expect(unnumberedTitle(`${e} 柄杓テスト`, EMOJIS)).toBe("柄杓テスト");
		}
		expect(parseTitle("🎉[1234] 柄杓テスト", EMOJIS)).toEqual({
			emoji: "🎉",
			number: 1234,
			base: "柄杓テスト",
		});
		// 人の手で重ねた絵文字や異体字セレクタ付きも外す
		expect(unnumberedTitle("🤔🎉 [1234] 件名", EMOJIS)).toBe("件名");
		expect(unnumberedTitle("👀\uFE0F[1234] 件名", EMOJIS)).toBe("件名");
	});

	it("知らない絵文字や件名の途中の絵文字・番号には触らない", () => {
		expect(unnumberedTitle("🍵[1234] 件名", EMOJIS)).toBe("🍵[1234] 件名");
		expect(unnumberedTitle("件名 🎉 [1234]", EMOJIS)).toBe("件名 🎉 [1234]");
		expect(unnumberedTitle("[12] 件名", EMOJIS)).toBe("[12] 件名");
		expect(unnumberedTitle("🎉[1234] 件名")).toBe("🎉[1234] 件名");
	});

	it("絵文字・番号・件名を組み、上限を超える分は件名の側で切る", () => {
		expect(composeTitle("🎉", 1234, "柄杓テスト")).toBe("🎉[1234] 柄杓テスト");
		expect(composeTitle("🤔", null, "柄杓テスト")).toBe("🤔 柄杓テスト");
		expect(composeTitle(null, null, "柄杓テスト")).toBe("柄杓テスト");
		const long = composeTitle("👨‍💼", 1234, "🍵".repeat(60));
		expect(long.length).toBeLessThanOrEqual(100);
		expect(long.startsWith("👨‍💼[1234] 🍵")).toBe(true);
		expect(long.endsWith("🍵…")).toBe(true);
	});

	it("番号を付け直しても頭の絵文字は残す", () => {
		expect(numberedTitle(1234, "🤔 件名", EMOJIS)).toBe("🤔[1234] 件名");
	});
});
