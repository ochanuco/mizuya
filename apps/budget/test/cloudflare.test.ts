import { describe, expect, it } from "vitest";
import {
	anchorDayOf,
	parseBillingInfo,
	parseUsage,
} from "../src/cloudflare.ts";
import { billingInfo, envelope, record } from "./fixtures.ts";

describe("parseBillingInfo", () => {
	it("subscription の日時を読む", () => {
		const result = parseBillingInfo(200, billingInfo());
		if (!result.ok) throw new Error(result.error.message);
		expect(result.value.map((s) => s.id)).toEqual(["sub-old", "sub-active"]);
		expect(result.value[1]?.end_timestamp).toBeNull();
		expect(result.value[1]?.billing_cycle_anchor_timestamp.getUTCDate()).toBe(
			15,
		);
	});

	it("秒の数値の日時も読む", () => {
		const result = parseBillingInfo(
			200,
			envelope({
				covered: true,
				subscriptions: [
					{
						id: "sub",
						start_timestamp: 1_767_225_600,
						billing_cycle_anchor_timestamp: 1_767_225_600,
					},
				],
			}),
		);
		if (!result.ok) throw new Error(result.error.message);
		expect(result.value[0]?.billing_cycle_anchor_timestamp.toISOString()).toBe(
			"2026-01-01T00:00:00.000Z",
		);
	});

	it("success が false なら errors を返す", () => {
		const result = parseBillingInfo(403, {
			success: false,
			errors: [{ code: 10000, message: "Authentication error" }],
			messages: [],
			result: null,
		});
		expect(result).toEqual({
			ok: false,
			error: {
				type: "cloudflare_error",
				status: 403,
				message: "10000 Authentication error",
			},
		});
	});
});

describe("anchorDayOf", () => {
	const subs = (() => {
		const r = parseBillingInfo(200, billingInfo("2026-03-31T00:00:00Z"));
		if (!r.ok) throw new Error();
		return r.value;
	})();

	it("有効な subscription の起点の日", () => {
		expect(anchorDayOf(subs, new Date("2026-11-07T01:00:00Z"))).toBe(31);
	});

	it("終わった subscription は使わない", () => {
		expect(anchorDayOf(subs, new Date("2026-02-01T00:00:00Z"))).toBe(3);
	});

	it("subscription が無ければ 1 日起点", () => {
		expect(anchorDayOf([], new Date())).toBe(1);
	});
});

describe("parseUsage", () => {
	it("使う列だけを読み、ほかの列と null を許す", () => {
		const result = parseUsage(
			200,
			envelope([
				record("2026-11-01", 0.5),
				{
					...record("2026-11-02", 0.25),
					ServiceName: null,
					ConsumedQuantity: null,
					ConsumedUnit: null,
				},
				{ ...record("2026-11-03", 0), BilledCost: "0.125" },
			]),
		);
		if (!result.ok) throw new Error(result.error.message);
		expect(result.value).toHaveLength(3);
		expect(result.value[0]).toMatchObject({
			BilledCost: 0.5,
			ServiceFamilyName: "Workers",
			ServiceName: "Workers Standard",
			ConsumedQuantity: 1000,
		});
		expect(result.value[1]?.ServiceName).toBeNull();
		expect(result.value[2]?.BilledCost).toBe(0.125);
	});

	it("BilledCost が無い行は応答の形の誤りにする", () => {
		const { BilledCost: _, ...broken } = record("2026-11-01", 1);
		const result = parseUsage(200, envelope([broken]));
		expect(result.ok).toBe(false);
	});
});
