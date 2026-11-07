import { describe, expect, it } from "vitest";
import {
	BUTTON_MAX_AGE_MS,
	createInbox,
	GITHUB_MAX_AGE_MS,
	RETENTION_MS,
} from "../src/inbox.ts";
import { memorySql } from "./sql.ts";

function setup() {
	let now = 1_000_000_000_000;
	let seq = 0;
	const inbox = createInbox(memorySql(), {
		now: () => now,
		newId: () => `id-${String(++seq).padStart(3, "0")}`,
	});
	return {
		inbox,
		advance: (ms: number) => {
			now += ms;
		},
	};
}

describe("受け箱", () => {
	it("置いた順に渡す", () => {
		const { inbox } = setup();
		inbox.put("button", { n: 1 });
		inbox.put("github", { n: 2 });
		expect(inbox.pending().map((i) => [i.id, i.kind, i.body])).toEqual([
			["id-001", "button", { n: 1 }],
			["id-002", "github", { n: 2 }],
		]);
	});

	it("dedupe が同じものは二度置かない", () => {
		const { inbox } = setup();
		expect(inbox.put("github", { n: 1 }, "github:d1")).not.toBeNull();
		expect(inbox.put("github", { n: 1 }, "github:d1")).toBeNull();
		expect(inbox.pending()).toHaveLength(1);
	});

	it("ack した行だけを消す", () => {
		const { inbox } = setup();
		inbox.put("button", { n: 1 });
		inbox.put("button", { n: 2 });
		expect(inbox.ack(JSON.stringify({ type: "ack", id: "id-001" }))).toBe(true);
		expect(inbox.pending().map((i) => i.id)).toEqual(["id-002"]);
	});

	it("ack でないメッセージは無視する", () => {
		const { inbox } = setup();
		inbox.put("button", { n: 1 });
		expect(inbox.ack("not json")).toBe(false);
		expect(inbox.ack(JSON.stringify({ type: "hello" }))).toBe(false);
		expect(inbox.pending()).toHaveLength(1);
	});

	it("古すぎるボタン・コマンドと GitHub の出来事は渡さずに消す", () => {
		const { inbox, advance } = setup();
		inbox.put("button", { n: 1 });
		inbox.put("command", { n: 3 });
		inbox.put("github", { n: 2 });
		advance(BUTTON_MAX_AGE_MS + 1);
		expect(inbox.pending().map((i) => i.kind)).toEqual(["github"]);
		advance(GITHUB_MAX_AGE_MS);
		expect(inbox.pending()).toEqual([]);
	});

	it("保持の期限を過ぎた行を purge で消す", () => {
		const { inbox, advance } = setup();
		inbox.put("github", { n: 1 }, "github:d1");
		advance(RETENTION_MS + 1);
		inbox.purge();
		// 消えたので、同じ配信をもう一度置ける
		expect(inbox.put("github", { n: 1 }, "github:d1")).not.toBeNull();
	});
});
