import * as v from "valibot";
import type { Result } from "./env.ts";

const API = "https://api.cloudflare.com/client/v4";

export type CloudflareError = {
	type: "cloudflare_error";
	status: number;
	message: string;
};

// 秒の数値でも ISO 文字列でも受ける
const TimestampSchema = v.pipe(
	v.union([v.string(), v.number()]),
	v.transform((t) =>
		typeof t === "number" ? new Date(t < 1e12 ? t * 1000 : t) : new Date(t),
	),
	v.check((d) => !Number.isNaN(d.getTime()), "日時が読めない"),
);

const OptionalTimestamp = v.optional(v.nullable(TimestampSchema), null);

const SubscriptionSchema = v.looseObject({
	id: v.string(),
	start_timestamp: OptionalTimestamp,
	billing_cycle_anchor_timestamp: TimestampSchema,
	end_timestamp: OptionalTimestamp,
});

const BillingInfoSchema = v.looseObject({
	covered: v.optional(v.boolean()),
	subscriptions: v.optional(v.nullable(v.array(SubscriptionSchema)), null),
});

// FOCUS 形式の行。使う列だけを確かめ、ほかの列は捨てる
const UsageRecordSchema = v.looseObject({
	BilledCost: v.pipe(
		v.union([v.number(), v.pipe(v.string(), v.transform(Number))]),
		v.number(),
		v.finite(),
	),
	BillingCurrency: v.optional(v.nullable(v.string()), null),
	ChargePeriodStart: TimestampSchema,
	ServiceFamilyName: v.optional(v.nullable(v.string()), null),
	ServiceName: v.optional(v.nullable(v.string()), null),
	ConsumedQuantity: v.optional(
		v.nullable(v.union([v.number(), v.pipe(v.string(), v.transform(Number))])),
		null,
	),
	ConsumedUnit: v.optional(v.nullable(v.string()), null),
});

const EnvelopeSchema = v.looseObject({
	success: v.boolean(),
	errors: v.optional(
		v.nullable(
			v.array(
				v.looseObject({
					code: v.optional(v.number()),
					message: v.optional(v.string()),
				}),
			),
		),
		null,
	),
	result: v.unknown(),
});

export type Subscription = v.InferOutput<typeof SubscriptionSchema>;
export type UsageRecord = v.InferOutput<typeof UsageRecordSchema>;

const shapeError = (status: number, what: string): CloudflareError => ({
	type: "cloudflare_error",
	status,
	message: `${what}の応答が想定と違う`,
});

function unwrap(
	status: number,
	json: unknown,
): Result<unknown, CloudflareError> {
	const envelope = v.safeParse(EnvelopeSchema, json);
	if (!envelope.success)
		return { ok: false, error: shapeError(status, "API ") };
	if (!envelope.output.success || status >= 400) {
		const messages = (envelope.output.errors ?? [])
			.map((e) => `${e.code ?? ""} ${e.message ?? ""}`.trim())
			.join("; ");
		return {
			ok: false,
			error: {
				type: "cloudflare_error",
				status,
				message: messages || "success が false",
			},
		};
	}
	return { ok: true, value: envelope.output.result };
}

export function parseBillingInfo(
	status: number,
	json: unknown,
): Result<Subscription[], CloudflareError> {
	const result = unwrap(status, json);
	if (!result.ok) return result;
	const parsed = v.safeParse(BillingInfoSchema, result.value);
	if (!parsed.success)
		return { ok: false, error: shapeError(status, "billable-usage/info ") };
	return { ok: true, value: parsed.output.subscriptions ?? [] };
}

export function parseUsage(
	status: number,
	json: unknown,
): Result<UsageRecord[], CloudflareError> {
	const result = unwrap(status, json);
	if (!result.ok) return result;
	const parsed = v.safeParse(v.array(UsageRecordSchema), result.value ?? []);
	if (!parsed.success)
		return { ok: false, error: shapeError(status, "billable-usage ") };
	return { ok: true, value: parsed.output };
}

/** 有効な subscription の起点の日。無ければ暦の月（1 日起点）とみなす */
export function anchorDayOf(subscriptions: Subscription[], now: Date): number {
	const t = now.getTime();
	const active = subscriptions.filter(
		(s) =>
			(s.start_timestamp === null || s.start_timestamp.getTime() <= t) &&
			(s.end_timestamp === null || s.end_timestamp.getTime() > t),
	);
	const chosen = active[0] ?? subscriptions.at(-1);
	return chosen ? chosen.billing_cycle_anchor_timestamp.getUTCDate() : 1;
}

async function get(
	path: string,
	token: string,
): Promise<Result<{ status: number; json: unknown }, CloudflareError>> {
	const res = await fetch(`${API}${path}`, {
		headers: { authorization: `Bearer ${token}` },
	});
	const text = await res.text();
	try {
		return { ok: true, value: { status: res.status, json: JSON.parse(text) } };
	} catch {
		return {
			ok: false,
			error: {
				type: "cloudflare_error",
				status: res.status,
				message: text.slice(0, 200),
			},
		};
	}
}

export async function fetchSubscriptions(
	accountId: string,
	token: string,
): Promise<Result<Subscription[], CloudflareError>> {
	const res = await get(`/accounts/${accountId}/billable-usage/info`, token);
	if (!res.ok) return res;
	return parseBillingInfo(res.value.status, res.value.json);
}

export async function fetchUsage(
	accountId: string,
	token: string,
	from: string,
	to: string,
): Promise<Result<UsageRecord[], CloudflareError>> {
	const query = new URLSearchParams({ from, to });
	const res = await get(
		`/accounts/${accountId}/billable-usage?${query}`,
		token,
	);
	if (!res.ok) return res;
	return parseUsage(res.value.status, res.value.json);
}
