import { describe, expect, it } from "vitest";
import { silentLogger } from "./logger.ts";
import {
	type HeartbeatPlan,
	nextHeartbeat,
	nextStandupAt,
	parseQuietHours,
	type RunKind,
	startStandupTimer,
} from "./standup-timer.ts";

const NINE = { hour: 9, minute: 0 };

describe("nextStandupAt", () => {
	it.each([
		// 2026-11-05 は木曜
		[
			"木曜の 8:59 JST なら同じ日の 9:00",
			"2026-11-04T23:59:00Z",
			"2026-11-05T00:00:00Z",
		],
		[
			"木曜の 9:00 ちょうどなら翌日",
			"2026-11-05T00:00:00Z",
			"2026-11-06T00:00:00Z",
		],
		["金曜の 10:00 なら土曜", "2026-11-06T01:00:00Z", "2026-11-07T00:00:00Z"],
		["土曜の 12:00 なら日曜", "2026-11-07T03:00:00Z", "2026-11-08T00:00:00Z"],
		// UTC ではまだ前の日でも、JST ではその日の朝
		[
			"日曜の 0:30 JST（UTC では土曜）なら同じ日曜",
			"2026-11-07T15:30:00Z",
			"2026-11-08T00:00:00Z",
		],
		["年をまたぐ", "2026-12-31T05:00:00Z", "2027-01-01T00:00:00Z"],
	])("%s", (_name, now, want) => {
		expect(nextStandupAt(new Date(now), NINE).getTime()).toBe(
			new Date(want).getTime(),
		);
	});

	it("時刻を変えられる", () => {
		expect(
			nextStandupAt(new Date("2026-11-05T00:00:00Z"), { hour: 9, minute: 30 }),
		).toEqual(new Date("2026-11-05T00:30:00Z"));
	});
});

describe("parseQuietHours", () => {
	it("24 時を超えた書き方を 0:00 からの分に直す", () => {
		expect(parseQuietHours("26:00-08:00")).toEqual({
			startMinute: 120,
			endMinute: 480,
		});
		expect(parseQuietHours("23:30-07:00")).toEqual({
			startMinute: 1410,
			endMinute: 420,
		});
	});
	it("読めないものと幅のないものは null", () => {
		expect(parseQuietHours("夜")).toBeNull();
		expect(parseQuietHours("24:00-00:00")).toBeNull();
	});
});

describe("nextHeartbeat", () => {
	const plan: HeartbeatPlan = {
		standupAt: NINE,
		intervalMs: 2 * 3600_000,
		// 2:00-8:00 JST
		quiet: { startMinute: 120, endMinute: 480 },
	};
	it.each([
		[
			"昼は間隔ごとに見回る",
			"2026-11-06T03:00:00Z",
			"2026-11-06T05:00:00Z",
			"patrol",
		],
		[
			"寝ている時間帯に入るなら起きる時刻まで飛ばす",
			"2026-11-06T16:30:00Z",
			"2026-11-06T23:00:00Z",
			"patrol",
		],
		[
			"朝会の直前の見回りは朝会に寄せる",
			"2026-11-05T22:30:00Z",
			"2026-11-06T00:00:00Z",
			"standup",
		],
		[
			"間隔より先に朝会が来るなら朝会",
			"2026-11-05T23:30:00Z",
			"2026-11-06T00:00:00Z",
			"standup",
		],
	])("%s", (_name, now, at, kind) => {
		expect(nextHeartbeat(new Date(now), plan)).toEqual({
			at: new Date(at),
			kind,
		});
	});
	it("間隔が無ければ朝会だけ", () => {
		expect(
			nextHeartbeat(new Date("2026-11-06T03:00:00Z"), {
				...plan,
				intervalMs: null,
			}),
		).toEqual({ at: new Date("2026-11-07T00:00:00Z"), kind: "standup" });
	});
});

describe("startStandupTimer", () => {
	it("次の回までの時間で予約し、回の種類を渡し、終わったら次を予約する", async () => {
		let clock = new Date("2026-11-06T00:30:00Z");
		const waits: number[] = [];
		const fire: (() => void)[] = [];
		const runs: RunKind[] = [];
		const timer = startStandupTimer({
			plan: { standupAt: NINE, intervalMs: 2 * 3600_000, quiet: null },
			now: () => clock,
			run: async (kind) => {
				runs.push(kind);
			},
			setTimer: (fn, ms) => {
				waits.push(ms);
				fire.push(fn);
				return { cancel: () => {} };
			},
			logger: silentLogger,
		});
		expect(waits).toEqual([2 * 3600_000]);
		clock = new Date("2026-11-06T02:30:00Z");
		fire[0]?.();
		await new Promise((r) => setTimeout(r, 0));
		expect(runs).toEqual(["patrol"]);
		expect(waits[1]).toBe(2 * 3600_000);
		timer.stop();
	});
});
