import type { Summary } from "./usage.ts";

export type Alert = { kind: string; text: string };

export const FORECAST_KIND = "forecast:100";

/** 今期にまだ知らせていない、越えた閾値。累計の閾値は低い順、予測は最後 */
export function newAlerts(
	summary: Summary,
	thresholdsPercent: number[],
	notified: ReadonlySet<string>,
): Alert[] {
	const alerts: Alert[] = [];
	for (const threshold of thresholdsPercent) {
		const kind = `actual:${threshold}`;
		if (summary.percent >= threshold && !notified.has(kind)) {
			alerts.push({
				kind,
				text: `今期の累計が予算の ${threshold}% に達しました`,
			});
		}
	}
	if (summary.forecastPercent >= 100 && !notified.has(FORECAST_KIND)) {
		alerts.push({
			kind: FORECAST_KIND,
			text: "月末の予測が予算を超えています",
		});
	}
	return alerts;
}
