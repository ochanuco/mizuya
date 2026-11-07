import { describe, expect, it } from "vitest";
import { newAlerts } from "../src/alerts.ts";
import { summarize } from "../src/usage.ts";

const period = { start: "2026-11-01", end: "2026-12-01" };

// 11-11 に取得（経過 10 日、期間 30 日）。予測は累計の 3 倍
const summaryAt = (periodToDate: number) =>
	summarize(
		[
			{
				periodStart: period.start,
				chargeDate: "2026-11-05",
				serviceName: "Workers Standard",
				serviceFamily: "Workers",
				cost: periodToDate,
				quantity: null,
				unit: null,
			},
		],
		period,
		"2026-11-11",
		10,
	);

const kinds = (alerts: { kind: string }[]) => alerts.map((a) => a.kind);

describe("newAlerts", () => {
	it("越えていなければ何もない", () => {
		expect(newAlerts(summaryAt(3), [50, 90, 100], new Set())).toEqual([]);
	});

	it("予測が 100% を越えたら予測の知らせ", () => {
		expect(kinds(newAlerts(summaryAt(4), [50, 90, 100], new Set()))).toEqual([
			"forecast:100",
		]);
	});

	it("越えた閾値をすべて、低い順に出す", () => {
		expect(kinds(newAlerts(summaryAt(9.5), [50, 90, 100], new Set()))).toEqual([
			"actual:50",
			"actual:90",
			"forecast:100",
		]);
	});

	it("閾値ちょうどでも越えたとみなす", () => {
		expect(
			kinds(newAlerts(summaryAt(5), [50], new Set(["forecast:100"]))),
		).toEqual(["actual:50"]);
	});

	it("知らせ済みのものは出さない", () => {
		const notified = new Set(["actual:50", "forecast:100"]);
		expect(kinds(newAlerts(summaryAt(9.5), [50, 90, 100], notified))).toEqual([
			"actual:90",
		]);
		expect(
			newAlerts(
				summaryAt(9.5),
				[50, 90, 100],
				new Set([...notified, "actual:90"]),
			),
		).toEqual([]);
	});
});
