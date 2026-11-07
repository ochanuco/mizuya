import { toJstDate } from "./lib/core.ts";
import type { Logger } from "./logger.ts";

export type TimeOfDay = { hour: number; minute: number };

/**
 * 朝会は決めてほしいことの一覧、見回りは前の回から変わったことだけを見る軽い回。
 * event は GitHub の出来事 1 件、watch は見張り 1 件を見る回で、timer は回さない。
 */
export type RunKind = "standup" | "patrol" | "event" | "watch";

/** 時刻で回す回。 */
export type HeartbeatKind = Extract<RunKind, "standup" | "patrol">;

/** JST の時刻を 0:00 からの分で持つ。start > end なら日をまたぐ。 */
export type QuietHours = { startMinute: number; endMinute: number };

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_MINUTES = 24 * 60;

/** `now` より後で、いちばん近い `at`（JST）。曜日は見ない（個人開発なので毎日開く）。 */
export const nextStandupAt = (now: Date, at: TimeOfDay): Date => {
	const jst = toJstDate(now);
	const midnightUtc =
		Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate()) -
		JST_OFFSET_MS;
	const today = new Date(midnightUtc + (at.hour * 60 + at.minute) * 60_000);
	return today > now ? today : new Date(today.getTime() + DAY_MS);
};

/** profile の `living_rhythm.typical_sleep`（"26:00-08:00" のように 24 時を超えて書く）を読む。 */
export const parseQuietHours = (typicalSleep: string): QuietHours | null => {
	const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(typicalSleep);
	if (!m) return null;
	const [start, end] = [
		Number(m[1]) * 60 + Number(m[2]),
		Number(m[3]) * 60 + Number(m[4]),
	].map((x) => x % DAY_MINUTES);
	if (start === undefined || end === undefined || start === end) return null;
	return { startMinute: start, endMinute: end };
};

const jstMinuteOfDay = (at: Date) => {
	const jst = toJstDate(at);
	return jst.getUTCHours() * 60 + jst.getUTCMinutes();
};

export const inQuietHours = (at: Date, quiet: QuietHours): boolean => {
	const m = jstMinuteOfDay(at);
	return quiet.startMinute < quiet.endMinute
		? quiet.startMinute <= m && m < quiet.endMinute
		: m >= quiet.startMinute || m < quiet.endMinute;
};

export type HeartbeatPlan = {
	standupAt: TimeOfDay;
	/** null なら見回りをせず、朝会だけを回す。 */
	intervalMs: number | null;
	quiet: QuietHours | null;
};

/** `at` の見回りは、朝会と材料が重なるだけなので `standup` の朝会に任せるか。 */
const closeToStandup = (standup: Date, at: Date, intervalMs: number) =>
	standup.getTime() - at.getTime() < intervalMs / 2;

/**
 * 外から起こされた見回りを、`now` に回すか。寝ている時間帯と、朝会の直前の回は飛ばす。
 * 間隔は `nextHeartbeat` と同じく、朝会に寄せる幅を決めるのに使う。
 */
export const patrolDue = (now: Date, plan: HeartbeatPlan): boolean =>
	plan.intervalMs !== null &&
	!(plan.quiet && inQuietHours(now, plan.quiet)) &&
	!closeToStandup(nextStandupAt(now, plan.standupAt), now, plan.intervalMs);

/**
 * 次に回す時刻と種類。見回りは間隔ごとに回し、寝ている時間帯は起きる時刻まで飛ばす。
 * 朝会の直前の見回りは朝会と材料が重なるだけなので、間隔の半分より近ければ朝会に寄せる。
 */
export const nextHeartbeat = (
	now: Date,
	plan: HeartbeatPlan,
): { at: Date; kind: HeartbeatKind } => {
	const standup = nextStandupAt(now, plan.standupAt);
	if (plan.intervalMs === null) return { at: standup, kind: "standup" };
	let at = new Date(now.getTime() + plan.intervalMs);
	if (plan.quiet && inQuietHours(at, plan.quiet)) {
		const end = plan.quiet.endMinute;
		at = nextStandupAt(at, { hour: Math.floor(end / 60), minute: end % 60 });
	}
	return closeToStandup(standup, at, plan.intervalMs)
		? { at: standup, kind: "standup" }
		: { at, kind: "patrol" };
};

export type TimerDeps = {
	plan: HeartbeatPlan;
	run: (kind: HeartbeatKind) => Promise<void>;
	now?: () => Date;
	setTimer?: (fn: () => void, ms: number) => { cancel: () => void };
	logger: Logger;
};

const defaultSetTimer = (fn: () => void, ms: number) => {
	const t = setTimeout(fn, ms);
	return { cancel: () => clearTimeout(t) };
};

/** 朝会と見回りを回す。1 回が終わってから次を予約するので、長引いても重ならない。 */
export const startStandupTimer = (deps: TimerDeps): { stop: () => void } => {
	const now = deps.now ?? (() => new Date());
	const setTimer = deps.setTimer ?? defaultSetTimer;
	let current: { cancel: () => void } | null = null;
	let stopped = false;

	const schedule = () => {
		if (stopped) return;
		const next = nextHeartbeat(now(), deps.plan);
		deps.logger.info("heartbeat scheduled", {
			at: next.at.getTime(),
			kind: next.kind,
		});
		current = setTimer(
			() => {
				void deps
					.run(next.kind)
					.catch((e: unknown) =>
						deps.logger.error("heartbeat crashed", {
							kind: next.kind,
							error: String(e),
						}),
					)
					.finally(schedule);
			},
			Math.max(0, next.at.getTime() - now().getTime()),
		);
	};
	schedule();
	return {
		stop: () => {
			stopped = true;
			current?.cancel();
		},
	};
};
