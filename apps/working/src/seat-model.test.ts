import { describe, expect, it } from "vitest";
import { MODEL_TAGS, replaceModelTag } from "./seat-model.ts";
import { newSeat, openSeatStore } from "./seat-store.ts";
import { tempDir } from "./test-support.ts";

describe("モデルのタグ", () => {
	const tags = new Map([
		["Opus", "t-opus"],
		["Sonnet", "t-sonnet"],
	]);

	it("モデルのタグだけを入れ替え、状態や人が付けたタグは残す", () => {
		expect(
			replaceModelTag(["t-working", "t-opus", "t-x"], tags, "sonnet"),
		).toEqual(["t-working", "t-x", "t-sonnet"]);
	});

	it("フォーラムに無いタグのモデルは、古いモデルのタグを外すだけにする", () => {
		expect(replaceModelTag(["t-working", "t-opus"], tags, "haiku")).toEqual([
			"t-working",
		]);
	});

	it("タグ名は選べるモデルを頭だけ大文字にしたもの", () => {
		expect(MODEL_TAGS).toEqual([
			"Opus",
			"Sonnet",
			"Haiku",
			"Terra",
			"Sol",
			"Luna",
		]);
	});
});

describe("席の記録のモデル", () => {
	it("選んだモデルと席のモデルは、受付を作り直しても残る", async () => {
		const dir = tempDir();
		const first = await openSeatStore(dir);
		await first.setModel("p1", "sonnet");
		await first.set({
			...newSeat("p1"),
			model: "opus",
			modelChange: { by: "ちゃぬ" },
		});
		const again = await openSeatStore(dir);
		expect(again.modelOf("p1")).toBe("sonnet");
		expect(again.get("p1")).toMatchObject({
			model: "opus",
			modelChange: { by: "ちゃぬ" },
		});
		expect(again.modelOf("p2")).toBeNull();
	});
});
