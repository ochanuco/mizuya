import { describe, expect, it } from "vitest";
import { usageBioBody, workActivityText } from "./work-activity.ts";

// 2026-11-07 10:00 JST
const NOW = new Date("2026-11-07T01:00:00.000Z");
const usage = (five: number, week: number) => ({
	fiveHour: { usedPercent: five, resetsAt: Date.parse("2026-11-07T04:00:10Z") },
	weekly: { usedPercent: week, resetsAt: Date.parse("2026-11-10T00:00:00Z") },
});

describe("workActivityText", () => {
	it("席ごとに作業中の数と使用率を印で分けて並べる", () => {
		expect(
			workActivityText({
				partners: { yukarin: 2, akarin: 0 },
				usage: { yukarin: usage(30.4, 12), akarin: usage(5, 1) },
			}),
		).toBe("ゆ 作業中 2件 · 5h 30% · 週 12% ／ あ 5h 5% · 週 1%");
	});

	it("作業中の席も使用率もなければ出さない", () => {
		expect(
			workActivityText({ partners: { yukarin: 0, akarin: 0 }, usage: {} }),
		).toBeNull();
	});
});

describe("usageBioBody", () => {
	it("読めている席ごとに 1 行。今日のリセットは時刻だけ、別の日は曜日を付ける", () => {
		expect(usageBioBody({ yukarin: usage(30, 12) }, NOW)).toBe(
			"ゆ 5h 30%・13:00 W 12%・火 9:00",
		);
		expect(usageBioBody({}, NOW)).toBe("");
	});
});
