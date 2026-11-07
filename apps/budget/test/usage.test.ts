import { describe, expect, it } from "vitest";
import { parseUsage } from "../src/cloudflare.ts";
import { billingPeriod } from "../src/period.ts";
import { formatUsd, summarize, toRows, type UsageRow } from "../src/usage.ts";
import { envelope, record } from "./fixtures.ts";

const periodOf = (day: string) => billingPeriod(15, day).start;

function rowsOf(records: unknown[]): UsageRow[] {
	const parsed = parseUsage(200, envelope(records));
	if (!parsed.ok) throw new Error(parsed.error.message);
	return toRows(parsed.value, periodOf);
}

describe("toRows", () => {
	it("同じ日・製品の行を合計し、日ごとに期間を付ける", () => {
		const rows = rowsOf([
			record("2026-11-14", 0.5),
			record("2026-11-14", 0.25, { quantity: 500 }),
			record("2026-11-15", 1),
			record("2026-11-15", 2, {
				family: "R2",
				service: "R2 Storage",
				unit: "GB-month",
			}),
		]);
		expect(rows).toEqual([
			{
				periodStart: "2026-10-15",
				chargeDate: "2026-11-14",
				serviceName: "Workers Standard",
				serviceFamily: "Workers",
				cost: 0.75,
				quantity: 1500,
				unit: "Requests",
			},
			{
				periodStart: "2026-11-15",
				chargeDate: "2026-11-15",
				serviceName: "Workers Standard",
				serviceFamily: "Workers",
				cost: 1,
				quantity: 1000,
				unit: "Requests",
			},
			{
				periodStart: "2026-11-15",
				chargeDate: "2026-11-15",
				serviceName: "R2 Storage",
				serviceFamily: "R2",
				cost: 2,
				quantity: 1000,
				unit: "GB-month",
			},
		]);
	});

	it("単位が食い違う量は捨てる", () => {
		const rows = rowsOf([
			record("2026-11-01", 0.5, { unit: "Requests" }),
			record("2026-11-01", 0.5, { unit: "CPU ms" }),
		]);
		expect(rows[0]).toMatchObject({ cost: 1, quantity: null, unit: null });
	});
});

describe("summarize", () => {
	const period = { start: "2026-10-15", end: "2026-11-15" };

	it("前日・累計・予測・製品群別を出す", () => {
		const rows = rowsOf([
			record("2026-10-15", 1),
			record("2026-10-16", 2),
			record("2026-10-16", 1, { family: "R2", service: "R2 Storage" }),
			record("2026-10-17", 0.5),
		]);
		// 10-18 に取得: 経過 3 日、期間 31 日
		const s = summarize(rows, period, "2026-10-18", 10);
		expect(s.yesterday).toBe(0.5);
		expect(s.periodToDate).toBe(4.5);
		expect(s.elapsedDays).toBe(3);
		expect(s.daysInPeriod).toBe(31);
		expect(s.forecast).toBeCloseTo((4.5 / 3) * 31);
		expect(s.percent).toBeCloseTo(45);
		expect(s.families).toEqual([
			{ family: "Workers", cost: 3.5 },
			{ family: "R2", cost: 1 },
		]);
		expect(s.services.map((x) => x.service)).toEqual([
			"Workers Standard",
			"R2 Storage",
		]);
		expect(s.daily).toHaveLength(31);
		expect(s.daily.slice(0, 4).map((d) => d.cost)).toEqual([1, 3, 0.5, 0]);
	});

	it("期間の初日は前日を前の期間の行から取り、経過は 1 日とみなす", () => {
		const rows = rowsOf([record("2026-10-14", 3), record("2026-10-15", 0.1)]);
		const s = summarize(rows, period, "2026-10-15", 10);
		expect(s.yesterday).toBe(3);
		expect(s.periodToDate).toBe(0.1);
		expect(s.elapsedDays).toBe(1);
	});

	it("利用が無ければ 0", () => {
		const s = summarize([], period, "2026-11-01", 10);
		expect(s.periodToDate).toBe(0);
		expect(s.forecast).toBe(0);
		expect(s.families).toEqual([]);
	});
});

describe("formatUsd", () => {
	it("1 セント未満は桁を増やす", () => {
		expect(formatUsd(1.234)).toBe("$1.23");
		expect(formatUsd(0)).toBe("$0.00");
		expect(formatUsd(0.0012)).toBe("$0.0012");
	});
});
