import type { UsageRecord } from "./cloudflare.ts";
import { addDays, daysBetween, type Period, toDay } from "./period.ts";

/** D1 の usage の 1 行。日・製品ごとに合計したもの */
export type UsageRow = {
	periodStart: string;
	chargeDate: string;
	serviceName: string;
	serviceFamily: string;
	cost: number;
	quantity: number | null;
	unit: string | null;
};

const UNKNOWN = "（不明）";

type Quantity = { quantity: number | null; unit: string | null };

// 単位が食い違う量は足せないので、量と単位を捨てる
function addQuantity(
	total: Quantity & { conflict: boolean },
	add: Quantity,
): void {
	if (add.quantity === null) return;
	if (total.unit !== null && add.unit !== null && total.unit !== add.unit)
		total.conflict = true;
	total.unit ??= add.unit;
	total.quantity = (total.quantity ?? 0) + add.quantity;
}

function settle<T extends Quantity & { conflict: boolean }>(
	total: T,
): Omit<T, "conflict"> {
	const { conflict, ...rest } = total;
	return conflict ? { ...rest, quantity: null, unit: null } : rest;
}

/** 同じ日・製品の行（SKU や resource ごと）を合計する */
export function toRows(
	records: UsageRecord[],
	periodStartOf: (day: string) => string,
): UsageRow[] {
	const rows = new Map<string, UsageRow & { conflict: boolean }>();
	for (const record of records) {
		const chargeDate = toDay(record.ChargePeriodStart);
		const serviceName =
			record.ServiceName ?? record.ServiceFamilyName ?? UNKNOWN;
		const periodStart = periodStartOf(chargeDate);
		const key = `${periodStart}\t${chargeDate}\t${serviceName}`;
		const quantity: Quantity = {
			quantity:
				record.ConsumedQuantity !== null &&
				Number.isFinite(record.ConsumedQuantity)
					? record.ConsumedQuantity
					: null,
			unit: record.ConsumedUnit,
		};
		const row = rows.get(key);
		if (row) {
			row.cost += record.BilledCost;
			addQuantity(row, quantity);
			continue;
		}
		rows.set(key, {
			periodStart,
			chargeDate,
			serviceName,
			serviceFamily: record.ServiceFamilyName ?? UNKNOWN,
			cost: record.BilledCost,
			...quantity,
			conflict: false,
		});
	}
	return [...rows.values()].map(settle);
}

export type ServiceTotal = {
	family: string;
	service: string;
	cost: number;
	quantity: number | null;
	unit: string | null;
};

export type Summary = {
	period: Period;
	/** 集計した日（取得した日、UTC） */
	today: string;
	daysInPeriod: number;
	elapsedDays: number;
	yesterday: number;
	periodToDate: number;
	forecast: number;
	budgetUsd: number;
	/** 累計の予算に対する割合（%） */
	percent: number;
	forecastPercent: number;
	/** 額の大きい順 */
	families: { family: string; cost: number }[];
	/** 額の大きい順 */
	services: ServiceTotal[];
	/** 期間の全日。まだ来ていない日は 0 */
	daily: { date: string; cost: number }[];
};

const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);

/** rows は今期の分。前日が前の期間に入るときのために、前日の行も混ぜてよい */
export function summarize(
	rows: UsageRow[],
	period: Period,
	today: string,
	budgetUsd: number,
): Summary {
	const current = rows.filter((r) => r.periodStart === period.start);
	const yesterdayDay = addDays(today, -1);
	const yesterday = sum(
		rows.filter((r) => r.chargeDate === yesterdayDay).map((r) => r.cost),
	);
	const periodToDate = sum(current.map((r) => r.cost));
	const daysInPeriod = daysBetween(period.start, period.end);
	// cron は日の初めに動き、当日の分はまだほとんど無いので、前日までを経過日数とする
	const elapsedDays = Math.min(
		daysInPeriod,
		Math.max(1, daysBetween(period.start, today)),
	);
	const forecast = (periodToDate / elapsedDays) * daysInPeriod;

	const families = new Map<string, number>();
	const services = new Map<string, ServiceTotal & { conflict: boolean }>();
	const daily = new Map<string, number>();
	for (const row of current) {
		families.set(
			row.serviceFamily,
			(families.get(row.serviceFamily) ?? 0) + row.cost,
		);
		daily.set(row.chargeDate, (daily.get(row.chargeDate) ?? 0) + row.cost);
		const key = `${row.serviceFamily}\t${row.serviceName}`;
		const total = services.get(key);
		if (total) {
			total.cost += row.cost;
			addQuantity(total, row);
			continue;
		}
		services.set(key, {
			family: row.serviceFamily,
			service: row.serviceName,
			cost: row.cost,
			quantity: row.quantity,
			unit: row.unit,
			conflict: false,
		});
	}

	return {
		period,
		today,
		daysInPeriod,
		elapsedDays,
		yesterday,
		periodToDate,
		forecast,
		budgetUsd,
		percent: (periodToDate / budgetUsd) * 100,
		forecastPercent: (forecast / budgetUsd) * 100,
		families: [...families]
			.map(([family, cost]) => ({ family, cost }))
			.sort((a, b) => b.cost - a.cost),
		services: [...services.values()]
			.map(settle)
			.sort((a, b) => b.cost - a.cost),
		daily: Array.from({ length: daysInPeriod }, (_, i) => {
			const date = addDays(period.start, i);
			return { date, cost: daily.get(date) ?? 0 };
		}),
	};
}

export function formatUsd(value: number): string {
	const digits = value !== 0 && Math.abs(value) < 0.01 ? 4 : 2;
	return `$${value.toFixed(digits)}`;
}

export function formatPercent(value: number): string {
	return `${value.toFixed(value < 10 ? 1 : 0)}%`;
}
