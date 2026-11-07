import { describe, expect, it } from "vitest";
import { addDays, billingPeriod, daysBetween } from "../src/period.ts";

describe("billingPeriod", () => {
	it("起点の日から翌月の起点の前日まで", () => {
		expect(billingPeriod(15, "2026-11-07")).toEqual({
			start: "2026-10-15",
			end: "2026-11-15",
		});
		expect(billingPeriod(15, "2026-11-15")).toEqual({
			start: "2026-11-15",
			end: "2026-12-15",
		});
	});

	it("1 日起点は暦の月", () => {
		expect(billingPeriod(1, "2026-12-31")).toEqual({
			start: "2026-12-01",
			end: "2027-01-01",
		});
	});

	it("年をまたぐ", () => {
		expect(billingPeriod(20, "2027-01-05")).toEqual({
			start: "2026-12-20",
			end: "2027-01-20",
		});
	});

	it("31 日起点は 30 日の月では末日から", () => {
		expect(billingPeriod(31, "2026-04-29")).toEqual({
			start: "2026-03-31",
			end: "2026-04-30",
		});
		expect(billingPeriod(31, "2026-04-30")).toEqual({
			start: "2026-04-30",
			end: "2026-05-31",
		});
	});

	it("31 日起点は 2 月では末日から（閏年も）", () => {
		expect(billingPeriod(31, "2026-02-15")).toEqual({
			start: "2026-01-31",
			end: "2026-02-28",
		});
		expect(billingPeriod(31, "2026-02-28")).toEqual({
			start: "2026-02-28",
			end: "2026-03-31",
		});
		expect(billingPeriod(30, "2028-02-29")).toEqual({
			start: "2028-02-29",
			end: "2028-03-30",
		});
	});

	it("期間は起点の日を含む", () => {
		const period = billingPeriod(9, "2026-11-09");
		expect(period.start).toBe("2026-11-09");
		expect(daysBetween(period.start, period.end)).toBe(30);
	});
});

describe("日付の計算", () => {
	it("addDays と daysBetween", () => {
		expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
		expect(daysBetween("2026-02-28", "2026-03-31")).toBe(31);
	});
});
