import { describe, expect, it } from "vitest";
import { parseBudgetConfig } from "../src/config.ts";

describe("parseBudgetConfig", () => {
	it("予算と閾値を読む。閾値は昇順で重複なし", () => {
		expect(
			parseBudgetConfig({
				BUDGET_MONTHLY_USD: "10",
				BUDGET_THRESHOLDS_PERCENT: "100, 50,90,50",
			}),
		).toEqual({
			ok: true,
			value: { monthlyUsd: 10, thresholdsPercent: [50, 90, 100] },
		});
	});

	it.each([
		["", "50"],
		["abc", "50"],
		["0", "50"],
		["10", ""],
		["10", "50,x"],
		["10", "50,,90"],
	])("不正な値は失敗にする（%s / %s）", (usd, thresholds) => {
		const result = parseBudgetConfig({
			BUDGET_MONTHLY_USD: usd,
			BUDGET_THRESHOLDS_PERCENT: thresholds,
		});
		expect(result.ok).toBe(false);
	});
});
