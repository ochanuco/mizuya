import { describe, expect, it } from "vitest";
import { elapsedText, panelText } from "./seat-panel.ts";

describe("elapsedText", () => {
	it("分単位に丸め、1 時間を超えたら時間と分で書く", () => {
		expect(elapsedText(30_000)).toBe("1分未満");
		expect(elapsedText(12 * 60_000 + 59_000)).toBe("12分");
		expect(elapsedText(60 * 60_000)).toBe("1時間");
		expect(elapsedText(125 * 60_000)).toBe("2時間5分");
	});
});

describe("panelText", () => {
	it("作業中でなければ状態だけを書く", () => {
		expect(
			panelText({ label: "決めてほしい", elapsedMs: 600_000, doing: "x" }),
		).toBe("状態: 決めてほしい");
	});

	it("いまやっていることは 1 行にまとめ、長ければ切る", () => {
		const text = panelText({
			label: "作業中",
			elapsedMs: 0,
			doing: `a\n${"b".repeat(400)}`,
		});
		const [, doing] = text.split("\n");
		expect(doing?.startsWith("いまやっていること: a b")).toBe(true);
		expect(doing?.endsWith("…")).toBe(true);
	});
});

describe("貸し出し待ちの状態の欄", () => {
	it("引き継ぎで記録を預けたら番号を出し、預けていなければ引き継ぎのまま", () => {
		expect(
			panelText({
				label: "引き継ぎ",
				elapsedMs: null,
				doing: null,
				lent: { number: 1234, using: false },
			}),
		).toBe("状態: Mac に貸し出し待ち（1234）");
		expect(
			panelText({
				label: "引き継ぎ",
				elapsedMs: null,
				doing: null,
				lent: { number: 1234, using: true },
			}),
		).toBe("状態: Mac に貸し出し中（1234）");
		expect(
			panelText({
				label: "引き継ぎ",
				elapsedMs: null,
				doing: null,
				lent: null,
			}),
		).toBe("状態: 引き継ぎ");
	});
});
