import type { Alert } from "./alerts.ts";
import type { MessageBody } from "./discord.ts";
import { DASHBOARD_URL } from "./env.ts";
import { addDays } from "./period.ts";
import { formatPercent, formatUsd, type Summary } from "./usage.ts";

const TOP_FAMILIES = 5;

const COLOR_OK = 0x2e7d32;
const COLOR_WARN = 0xf9a825;
const COLOR_OVER = 0xc62828;

function color(summary: Summary): number {
	if (summary.percent >= 100) return COLOR_OVER;
	if (summary.forecastPercent >= 100) return COLOR_WARN;
	return COLOR_OK;
}

function familyLines(summary: Summary): string {
	if (summary.families.length === 0) return "利用なし";
	const lines = summary.families
		.slice(0, TOP_FAMILIES)
		.map((f) => `${f.family}: ${formatUsd(f.cost)}`);
	const rest = summary.families.slice(TOP_FAMILIES);
	if (rest.length > 0) {
		const restCost = rest.reduce((a, f) => a + f.cost, 0);
		lines.push(`ほか ${rest.length} 件: ${formatUsd(restCost)}`);
	}
	return lines.join("\n");
}

/** 毎日の報告。閾値を越えた日だけ承認者に知らせる */
export function dailyMessage(
	summary: Summary,
	alerts: Alert[],
	approverUserId: string,
): MessageBody {
	const lastDay = addDays(summary.period.end, -1);
	const body: MessageBody = {
		embeds: [
			{
				title: `Cloudflare の利用額（${summary.today}）`,
				url: DASHBOARD_URL,
				description: `今期: ${summary.period.start} 〜 ${lastDay}（${summary.elapsedDays}/${summary.daysInPeriod} 日）`,
				color: color(summary),
				fields: [
					{
						name: "前日の額",
						value: formatUsd(summary.yesterday),
						inline: true,
					},
					{
						name: "今期の累計",
						value: `${formatUsd(summary.periodToDate)} / ${formatUsd(summary.budgetUsd)}（${formatPercent(summary.percent)}）`,
						inline: true,
					},
					{
						name: "月末の予測",
						value: `${formatUsd(summary.forecast)}（${formatPercent(summary.forecastPercent)}）`,
						inline: true,
					},
					{ name: "製品別", value: familyLines(summary) },
				],
			},
		],
		allowed_mentions: { parse: [] },
	};
	if (alerts.length === 0) return body;
	return {
		...body,
		content: `<@${approverUserId}> ${alerts.map((a) => a.text).join("。")}。`,
		allowed_mentions: { parse: [], users: [approverUserId] },
	};
}

/** 取得に失敗した日も、黙らないよう短く知らせる。誰にもメンションしない */
export function failureMessage(reason: string): MessageBody {
	return {
		content: `Cloudflare の利用額を取れませんでした: ${reason}\n${DASHBOARD_URL}`,
		embeds: [],
		allowed_mentions: { parse: [] },
	};
}
