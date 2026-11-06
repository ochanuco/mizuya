import { describe, expect, it } from "vitest";
import { replaceStatusTag, takeStatus } from "./work-status.ts";

describe("takeStatus", () => {
	it("最後の行の状態を読み、本文から外す", () => {
		expect(takeStatus("終わりました。\n\n状態: 完了\n")).toEqual({
			body: "終わりました。",
			status: "完了",
		});
		expect(takeStatus("どちらにしますか\n状態：決めてほしい")).toEqual({
			body: "どちらにしますか",
			status: "決めてほしい",
		});
	});

	it("書き忘れや知らない状態は、本文をそのまま残して決めてほしいにする", () => {
		expect(takeStatus("返事だけ")).toEqual({
			body: "返事だけ",
			status: "決めてほしい",
		});
		expect(takeStatus("x\n状態: 休憩")).toEqual({
			body: "x\n状態: 休憩",
			status: "決めてほしい",
		});
	});
});

describe("replaceStatusTag", () => {
	const tags = new Map([
		["作業中", "w"],
		["完了", "d"],
	] as const);

	it("状態のタグだけを付け替える", () => {
		expect(replaceStatusTag(["other", "w"], tags, "完了")).toEqual([
			"other",
			"d",
		]);
	});

	it("フォーラムにないタグは付けず、古い状態は外す", () => {
		expect(replaceStatusTag(["w"], tags, "引き継ぎ")).toEqual([]);
	});
});
