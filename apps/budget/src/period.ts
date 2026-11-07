/** 請求期間。日付は UTC の YYYY-MM-DD で、end は含まない */
export type Period = { start: string; end: string };

const DAY_MS = 86_400_000;

export const toDay = (date: Date): string => date.toISOString().slice(0, 10);

const parseDay = (day: string): number => Date.parse(`${day}T00:00:00Z`);

export const addDays = (day: string, days: number): string =>
	toDay(new Date(parseDay(day) + days * DAY_MS));

export const daysBetween = (from: string, to: string): number =>
	Math.round((parseDay(to) - parseDay(from)) / DAY_MS);

const daysInMonth = (year: number, month: number): number =>
	new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

// 31 日起点の期間は、30 日までの月や 2 月ではその月の末日から始まる
const anchorIn = (year: number, month: number, anchorDay: number): number =>
	Date.UTC(year, month, Math.min(anchorDay, daysInMonth(year, month)));

/** anchorDay（毎月の起点の日）から、day を含む請求期間を求める */
export function billingPeriod(anchorDay: number, day: string): Period {
	const t = parseDay(day);
	const date = new Date(t);
	const year = date.getUTCFullYear();
	let month = date.getUTCMonth();
	if (t < anchorIn(year, month, anchorDay)) month -= 1;
	return {
		start: toDay(new Date(anchorIn(year, month, anchorDay))),
		end: toDay(new Date(anchorIn(year, month + 1, anchorDay))),
	};
}
