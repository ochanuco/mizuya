import { describe, expect, it } from "vitest";
import { decodeCustomId, encodeCustomId } from "../src/review.ts";

describe("custom_id", () => {
	it("repo・run・Environment を往復できる", () => {
		const target = { repo: "example/app", runId: 42, environment: "prod:eu" };
		const id = encodeCustomId("reject", target);
		expect(decodeCustomId(id)).toEqual({ decision: "reject", target });
	});

	it("100 文字を超えるなら Environment を省き、すべての Environment を指す", () => {
		const target = {
			repo: "example/app",
			runId: 42,
			environment: "x".repeat(100),
		};
		const id = encodeCustomId("approve", target);
		expect(id.length).toBeLessThanOrEqual(100);
		expect(decodeCustomId(id)?.target.environment).toBeNull();
	});

	it("mizuya 以外の custom_id は読まない", () => {
		expect(decodeCustomId("other:approve:example/app:1:prod")).toBeNull();
		expect(decodeCustomId("mizuya:merge:example/app:1:prod")).toBeNull();
		expect(decodeCustomId("mizuya:approve:example/app:abc:prod")).toBeNull();
	});
});
