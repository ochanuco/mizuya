import { vi } from "vitest";
import type { Bindings } from "../src/env.ts";
import { memoryD1 } from "./d1.ts";

export const ACCOUNT_ID = "00000000000000000000000000000000";
export const APPROVER_ID = "100000000000000001";
export const CHANNEL_ID = "200000000000000001";

export function makeEnv(overrides: Partial<Bindings> = {}) {
	const d1 = memoryD1();
	const env: Bindings = {
		DB: d1.db,
		CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
		BUDGET_MONTHLY_USD: "10",
		BUDGET_THRESHOLDS_PERCENT: "50,90,100",
		CLOUDFLARE_BILLING_TOKEN: "test-billing-token",
		DISCORD_BOT_TOKEN: "test-bot-token",
		DISCORD_APPROVER_USER_ID: APPROVER_ID,
		DISCORD_BUDGET_CHANNEL_ID: CHANNEL_ID,
		...overrides,
	};
	return { env, raw: d1.raw };
}

export function billingInfo(anchor = "2026-03-15T00:00:00Z") {
	return {
		success: true,
		errors: [],
		messages: [],
		result: {
			covered: true,
			subscriptions: [
				{
					id: "sub-old",
					start_timestamp: "2025-01-15T00:00:00Z",
					billing_cycle_anchor_timestamp: "2025-01-03T00:00:00Z",
					end_timestamp: "2026-03-01T00:00:00Z",
				},
				{
					id: "sub-active",
					start_timestamp: "2026-03-15T00:00:00Z",
					billing_cycle_anchor_timestamp: anchor,
				},
			],
		},
	};
}

/** FOCUS 形式の 1 行。使わない列も実物に合わせて入れる */
export function record(
	day: string,
	cost: number,
	{
		family = "Workers",
		service = "Workers Standard",
		quantity = 1000 as number | null,
		unit = "Requests" as string | null,
	} = {},
) {
	return {
		BilledCost: cost,
		BillingCurrency: "USD",
		BillingAccountId: ACCOUNT_ID,
		ChargePeriodStart: `${day}T00:00:00Z`,
		ChargePeriodEnd: `${day}T23:59:59Z`,
		ServiceFamilyName: family,
		ServiceName: service,
		ConsumedQuantity: quantity,
		ConsumedUnit: unit,
		CumulatedContractedCost: null,
		ResourceId: "resource-0001",
		Tags: { env: "test" },
	};
}

export const envelope = (result: unknown) => ({
	success: true,
	errors: [],
	messages: [],
	result,
});

export type Call = { method: string; url: URL; body: unknown };

/** fetch をモックし、呼ばれた順に記録する。handler が undefined を返したら 404 */
export function mockFetch(
	handler: (call: Call) => Response | undefined,
): Call[] {
	const calls: Call[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL, init?: RequestInit) => {
			const body =
				typeof init?.body === "string" ? JSON.parse(init.body) : null;
			const call = {
				method: init?.method ?? "GET",
				url: new URL(String(input)),
				body,
			};
			calls.push(call);
			return handler(call) ?? new Response("not found", { status: 404 });
		}),
	);
	return calls;
}
