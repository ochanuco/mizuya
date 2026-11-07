import type { PartnerId } from "./lib/core.ts";
import { PARTNER_IDS, toJstDate } from "./lib/core.ts";
import type { Logger } from "./logger.ts";
import type { Usage, UsageWindow } from "./usage.ts";

export const WORK_ACTIVITY_INTERVAL_MS = 60_000;
export const USAGE_BIO_INTERVAL_MS = 15 * 60_000;

/** 状態表示と自己紹介欄で席を表す一文字。 */
export const PARTNER_MARK: Record<PartnerId, string> = {
	yukarin: "ゆ",
	akarin: "あ",
};

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

const clock = (at: Date): string => {
	const d = toJstDate(at);
	return `${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
};

const jstDay = (at: Date) => Math.floor(toJstDate(at).getTime() / DAY_MS);

/**
 * リセット時刻。今日なら時刻だけ、別の日なら曜日を付ける。どちらの枠も 7 日以内に戻るので、日付は書かなくても読める。
 * API は 18:59:59 や 19:00:00.6 のように前後にぶれた値を返すので、近いほうの分に丸めて 19:00 と書く。
 */
const resetLabel = (resetsAt: number, now: Date): string => {
	const at = new Date(Math.round(resetsAt / MINUTE_MS) * MINUTE_MS);
	if (jstDay(at) === jstDay(now)) return clock(at);
	return `${WEEKDAYS[toJstDate(at).getUTCDay()]} ${clock(at)}`;
};

const percent = (w: UsageWindow) => `${Math.round(w.usedPercent)}%`;

export type ActivitySnapshot = {
	/** 席ごとの作業中の数。 */
	partners: Record<PartnerId, number>;
	/** 席で動く CLI の使用率。読めていない席は持たない。 */
	usage: Partial<Record<PartnerId, Usage>>;
};

/**
 * bot のステータスに出す文。席ごとに作業中の数と使用率を並べ、どちらもない席は出さない。
 * mizuya の bot 1 つで両方の席を受け持つので、席の印で分ける。
 */
export const workActivityText = (s: ActivitySnapshot): string | null => {
	const segments = PARTNER_IDS.flatMap((partner) => {
		const parts: string[] = [];
		const working = s.partners[partner];
		if (working > 0) parts.push(`作業中 ${working}件`);
		const usage = s.usage[partner];
		if (usage) {
			parts.push(
				`5h ${percent(usage.fiveHour)}`,
				`週 ${percent(usage.weekly)}`,
			);
		}
		return parts.length > 0
			? [`${PARTNER_MARK[partner]} ${parts.join(" · ")}`]
			: [];
	});
	return segments.length > 0 ? segments.join(" ／ ") : null;
};

const windowText = (label: string, w: UsageWindow, now: Date): string => {
	const reset = w.resetsAt == null ? "" : `・${resetLabel(w.resetsAt, now)}`;
	return `${label} ${percent(w)}${reset}`;
};

/**
 * 自己紹介欄に出す使用率の本文。読めている席ごとに 1 行。読めていなければ空にする。
 * プロフィールの小窓は頭の 3 行しか出さないので、席ごとに 1 行、書いた時刻で 1 行に収める。
 */
export const usageBioBody = (
	usage: Partial<Record<PartnerId, Usage>>,
	now: Date,
): string =>
	PARTNER_IDS.flatMap((partner) => {
		const u = usage[partner];
		return u
			? [
					`${PARTNER_MARK[partner]} ${windowText("5h", u.fiveHour, now)} ${windowText("W", u.weekly, now)}`,
				]
			: [];
	}).join("\n");

type WorkActivityOptions = {
	snapshot: () => ActivitySnapshot;
	/** null で消す。 */
	setActivity: (text: string | null) => void;
	/** 自己紹介欄を書き換える。失敗したら false。 */
	setBio?: (text: string) => Promise<boolean>;
	logger: Logger;
	intervalMs?: number;
	bioIntervalMs?: number;
	now?: () => Date;
};

/**
 * 作業中の席の数と使用率を、bot のステータスと自己紹介欄に出し続ける。止める関数を返す。
 * 自己紹介欄はアプリの説明文で、書き換えの頻度の制限が公開されていない。本文が変わったときだけ、bioIntervalMs に一度まで書く。
 */
export const startWorkActivity = (opts: WorkActivityOptions): (() => void) => {
	const now = opts.now ?? (() => new Date());
	const bioIntervalMs = opts.bioIntervalMs ?? USAGE_BIO_INTERVAL_MS;
	let shown: string | null = null;
	let bioShown: string | null = null;
	let bioWrittenAt = Number.NEGATIVE_INFINITY;
	let bioWriting = false;
	const updateBio = async (usage: ActivitySnapshot["usage"]) => {
		if (!opts.setBio || bioWriting) return;
		const at = now();
		const body = usageBioBody(usage, at);
		// 起動直後は使用率をまだ読めていないことが多い。空で書くと次に書けるまで待たされる
		if (body === "" && bioShown === null) return;
		if (body === bioShown || at.getTime() - bioWrittenAt < bioIntervalMs) {
			return;
		}
		// 何分前の値かが分かるよう、書いた時刻を添える
		const text = body === "" ? "" : `${body}\n${clock(at)} 時点`;
		bioWriting = true;
		const written = await opts.setBio(text);
		bioWriting = false;
		if (!written) return;
		bioShown = body;
		bioWrittenAt = at.getTime();
	};
	const update = async () => {
		const s = opts.snapshot();
		const text = workActivityText(s);
		if (text !== shown) {
			shown = text;
			opts.setActivity(text);
		}
		await updateBio(s.usage);
	};
	const run = () =>
		void update().catch((e: unknown) => {
			opts.logger.warn("work activity update failed", { error: String(e) });
		});
	run();
	const timer = setInterval(run, opts.intervalMs ?? WORK_ACTIVITY_INTERVAL_MS);
	timer.unref();
	return () => clearInterval(timer);
};
