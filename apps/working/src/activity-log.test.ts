import { describe, expect, it, vi } from "vitest";
import {
	type ActivityEntry,
	type ActivityPrs,
	formatActivityLog,
	gatherActivityPrs,
	openActivityLog,
	postActivityLog,
	startDailyTimer,
} from "./activity-log.ts";
import type { Exec } from "./exec.ts";
import { silentLogger } from "./logger.ts";
import { fakeDiscord, tempDir } from "./test-support.ts";

const THREAD = "log-thread";
// 2026-11-06 23:30 JST
const NIGHT = new Date("2026-11-06T14:30:00Z");
const HOUR = 3600_000;

const entry = (over: Partial<ActivityEntry> = {}): ActivityEntry => ({
	at: new Date(NIGHT.getTime() - HOUR),
	kind: "done",
	threadId: "p1",
	title: "README の誤字",
	partner: "yukarin",
	tools: [],
	...over,
});

const pr = (n: number, title: string) => ({
	repo: "o/r",
	number: n,
	title,
	url: `https://github.com/o/r/pull/${n}`,
});

const NO_PRS: ActivityPrs = { merged: [], opened: [] };

describe("formatActivityLog", () => {
	it("何もなければ null", () => {
		expect(formatActivityLog({ until: NIGHT, entries: [], prs: NO_PRS })).toBe(
			null,
		);
		expect(formatActivityLog({ until: NIGHT, entries: [], prs: null })).toBe(
			null,
		);
	});

	it("仕事・止められた操作・PR を節に分け、止めた操作は道具の名前と件数だけを書く", () => {
		const text = formatActivityLog({
			until: NIGHT,
			entries: [
				entry(),
				entry({ kind: "handoff", threadId: "p2", title: "Mac の設定" }),
				entry({
					kind: "blocked",
					threadId: "p3",
					title: "デプロイ",
					partner: "akarin",
					tools: ["Bash", "Bash"],
				}),
				entry({
					kind: "blocked",
					threadId: "p3",
					title: "デプロイ",
					partner: "akarin",
					tools: ["Write"],
				}),
			],
			prs: { merged: [pr(1, "誤字を直す")], opened: [pr(2, "設定を足す")] },
		});
		expect(text).toBe(
			[
				"2026-11-06 の活動ログ",
				"",
				"終えた仕事",
				"- 「README の誤字」（Yukarin）",
				"",
				"Mac に引き継いだ仕事",
				"- 「Mac の設定」（Yukarin）",
				"",
				"止められた操作",
				"- 「デプロイ」（Akarin） Bash 2 件、Write 1 件",
				"",
				"マージされた PR",
				"- o/r#1 誤字を直す <https://github.com/o/r/pull/1>",
				"",
				"出した PR",
				"- o/r#2 設定を足す <https://github.com/o/r/pull/2>",
			].join("\n"),
		);
	});

	it("PR を取れなくても席の記録があれば出し、取れなかったと書く", () => {
		const text = formatActivityLog({
			until: NIGHT,
			entries: [entry()],
			prs: null,
		});
		expect(text).toContain("PR は取れなかった");
	});
});

describe("openActivityLog", () => {
	it("記録を範囲で引き、まとめた分を捨てる。開き直しても残る", async () => {
		const dir = tempDir();
		const log = openActivityLog(dir);
		await log.record(entry({ at: new Date(NIGHT.getTime() - 2 * HOUR) }));
		await log.record(entry({ at: new Date(NIGHT.getTime() + HOUR) }));
		expect(await log.postedUntil()).toBeNull();
		expect(
			await log.between(new Date(NIGHT.getTime() - 3 * HOUR), NIGHT),
		).toHaveLength(1);
		await log.markPosted(NIGHT);
		const reopened = openActivityLog(dir);
		expect(await reopened.postedUntil()).toEqual(NIGHT);
		expect(
			await reopened.between(new Date(0), new Date(NIGHT.getTime() * 2)),
		).toEqual([entry({ at: new Date(NIGHT.getTime() + HOUR) })]);
	});
});

describe("postActivityLog", () => {
	const setup = async (prs: ActivityPrs | null) => {
		const log = openActivityLog(tempDir());
		const d = fakeDiscord();
		const gatherPrs = vi.fn(async () => prs);
		const post = () =>
			postActivityLog({
				log,
				gatherPrs,
				discord: d.api,
				threadId: THREAD,
				now: () => NIGHT,
				logger: silentLogger,
			});
		return { log, d, gatherPrs, post };
	};

	it("初めての回は 24 時間前から見て 1 投稿にまとめ、ここまでを残す", async () => {
		const s = await setup(NO_PRS);
		await s.log.record(entry());
		await s.post();
		expect(s.d.sentTo(THREAD)).toHaveLength(1);
		expect(s.d.sentTo(THREAD)[0]).toContain("README の誤字");
		expect(s.gatherPrs).toHaveBeenCalledWith(
			new Date(NIGHT.getTime() - 24 * HOUR),
			NIGHT,
		);
		expect(await s.log.postedUntil()).toEqual(NIGHT);
	});

	it("前の回のあとからの分だけを見る", async () => {
		const s = await setup(NO_PRS);
		const last = new Date(NIGHT.getTime() - 48 * HOUR);
		await s.log.markPosted(last);
		await s.post();
		expect(s.gatherPrs).toHaveBeenCalledWith(last, NIGHT);
	});

	it("何もなかった日は投稿しない", async () => {
		const s = await setup(NO_PRS);
		await s.post();
		expect(s.d.sentTo(THREAD)).toEqual([]);
		expect(await s.log.postedUntil()).toEqual(NIGHT);
	});

	it("PR を取れず席の記録も無ければ、投稿せず次の回に同じ範囲を見直す", async () => {
		const s = await setup(null);
		await s.post();
		expect(s.d.sentTo(THREAD)).toEqual([]);
		expect(await s.log.postedUntil()).toBeNull();
	});

	it("投稿に失敗したら、まとめた印を残さない", async () => {
		const s = await setup(NO_PRS);
		s.d.refuseSendTo.add(THREAD);
		await s.log.record(entry());
		await s.post();
		expect(await s.log.postedUntil()).toBeNull();
	});
});

describe("gatherActivityPrs", () => {
	const ok = (stdout: unknown) => ({
		code: 0,
		stdout: JSON.stringify(stdout),
		stderr: "",
	});
	const since = new Date(NIGHT.getTime() - 24 * HOUR);
	const inside = new Date(NIGHT.getTime() - HOUR).toISOString();
	const before = new Date(since.getTime() - HOUR).toISOString();

	it("dev/ ブランチの PR を、範囲内にマージされたものと出したものに分ける", async () => {
		const exec = vi.fn<Exec>(async (_bin, args) => {
			if (args[0] === "search") {
				return ok([
					{ repository: { nameWithOwner: "o/r" } },
					{ repository: { nameWithOwner: "o/r" } },
				]);
			}
			return ok([
				{
					number: 1,
					title: "マージ済み",
					url: "u1",
					headRefName: "dev/a",
					createdAt: before,
					mergedAt: inside,
				},
				{
					number: 2,
					title: "出した",
					url: "u2",
					headRefName: "dev/b",
					createdAt: inside,
					mergedAt: null,
				},
				{
					number: 3,
					title: "前から開いている",
					url: "u3",
					headRefName: "dev/c",
					createdAt: before,
					mergedAt: null,
				},
				{
					number: 4,
					title: "Mac で出した",
					url: "u4",
					headRefName: "feature/d",
					createdAt: inside,
					mergedAt: null,
				},
			]);
		});
		const r = await gatherActivityPrs({
			exec,
			env: {},
			cwd: "/w",
			owner: "o",
			since,
			until: NIGHT,
			logger: silentLogger,
		});
		expect(r).toEqual({
			merged: [{ repo: "o/r", number: 1, title: "マージ済み", url: "u1" }],
			opened: [{ repo: "o/r", number: 2, title: "出した", url: "u2" }],
		});
		// 同じ repo は 1 回だけ引く
		expect(exec).toHaveBeenCalledTimes(2);
	});

	it("gh が失敗したら null", async () => {
		const exec: Exec = async () => ({ code: 1, stdout: "", stderr: "x" });
		expect(
			await gatherActivityPrs({
				exec,
				env: {},
				cwd: "/w",
				owner: "o",
				since,
				until: NIGHT,
				logger: silentLogger,
			}),
		).toBeNull();
	});
});

describe("startDailyTimer", () => {
	it("毎日決まった時刻に回し、終わってから次を予約する", async () => {
		let clock = new Date("2026-11-06T12:00:00Z").getTime();
		const timers: { fn: () => void; ms: number }[] = [];
		const run = vi.fn(async () => {});
		const t = startDailyTimer({
			at: { hour: 23, minute: 30 },
			run,
			now: () => new Date(clock),
			setTimer: (fn, ms) => {
				timers.push({ fn, ms });
				return { cancel: () => {} };
			},
			logger: silentLogger,
		});
		expect(timers[0]?.ms).toBe(2.5 * HOUR);
		clock += 2.5 * HOUR;
		timers[0]?.fn();
		await vi.waitFor(() => expect(timers).toHaveLength(2));
		expect(run).toHaveBeenCalledTimes(1);
		expect(timers[1]?.ms).toBe(24 * HOUR);
		t.stop();
	});
});
