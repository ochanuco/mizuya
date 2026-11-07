import { newAlerts } from "./alerts.ts";
import {
	anchorDayOf,
	type CloudflareError,
	fetchSubscriptions,
	fetchUsage,
} from "./cloudflare.ts";
import { parseBudgetConfig } from "./config.ts";
import { createMessage, type MessageBody } from "./discord.ts";
import type { Bindings, Result } from "./env.ts";
import { dailyMessage, failureMessage } from "./message.ts";
import { addDays, billingPeriod, toDay } from "./period.ts";
import {
	notifiedKinds,
	recordFetched,
	recordNotified,
	replaceUsage,
} from "./store.ts";
import { summarize, toRows } from "./usage.ts";

const describe = (e: CloudflareError): string =>
	`Cloudflare API ${e.status}: ${e.message}`.slice(0, 500);

async function post(env: Bindings, body: MessageBody): Promise<boolean> {
	const res = await createMessage(
		env.DISCORD_BOT_TOKEN,
		env.DISCORD_BUDGET_CHANNEL_ID,
		body,
	);
	if (!res.ok) console.error("budget: Discord への投稿に失敗", res.error);
	return res.ok;
}

async function report(env: Bindings, now: Date): Promise<Result<null>> {
	const config = parseBudgetConfig(env);
	if (!config.ok) return config;

	const subscriptions = await fetchSubscriptions(
		env.CLOUDFLARE_ACCOUNT_ID,
		env.CLOUDFLARE_BILLING_TOKEN,
	);
	if (!subscriptions.ok)
		return { ok: false, error: describe(subscriptions.error) };

	const today = toDay(now);
	const anchorDay = anchorDayOf(subscriptions.value, now);
	const period = billingPeriod(anchorDay, today);
	// 期間の初日は前日が前の期間に入るので、前日の分まで取る
	const from = period.start === today ? addDays(today, -1) : period.start;
	const records = await fetchUsage(
		env.CLOUDFLARE_ACCOUNT_ID,
		env.CLOUDFLARE_BILLING_TOKEN,
		from,
		today,
	);
	if (!records.ok) return { ok: false, error: describe(records.error) };

	const currencies = new Set(
		records.value.flatMap((r) =>
			r.BillingCurrency === null ? [] : [r.BillingCurrency],
		),
	);
	currencies.delete("USD");
	if (currencies.size > 0) {
		return {
			ok: false,
			error: `USD 以外の通貨が混じっている: ${[...currencies].join(", ")}`,
		};
	}

	const rows = toRows(
		records.value,
		(day) => billingPeriod(anchorDay, day).start,
	);
	await replaceUsage(env.DB, from, today, rows);
	await recordFetched(env.DB, { at: now.toISOString(), period });

	const summary = summarize(rows, period, today, config.value.monthlyUsd);
	const alerts = newAlerts(
		summary,
		config.value.thresholdsPercent,
		await notifiedKinds(env.DB, period.start),
	);
	const posted = await post(
		env,
		dailyMessage(summary, alerts, env.DISCORD_APPROVER_USER_ID),
	);
	// 投稿できなかった閾値は記録せず、次の日にもう一度知らせる
	if (posted) {
		await recordNotified(
			env.DB,
			period.start,
			alerts.map((a) => a.kind),
			now,
		);
	}
	return { ok: true, value: null };
}

/** 毎日の取得と報告。失敗は記録して、黙らないようチャンネルにも短く出す。例外は外に出さない */
export async function runDaily(env: Bindings, now: Date): Promise<void> {
	let result: Result<null>;
	try {
		result = await report(env, now);
	} catch (e) {
		result = { ok: false, error: `想定外のエラー: ${String(e)}`.slice(0, 500) };
	}
	if (result.ok) return;
	console.error("budget:", result.error);
	try {
		await post(env, failureMessage(result.error));
	} catch (e) {
		console.error("budget: Discord への投稿に失敗", e);
	}
}
