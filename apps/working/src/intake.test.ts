import {
	existsSync,
	mkdirSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ActivityEntry } from "./activity-log.ts";
import { openApprovalStore } from "./approval-store.ts";
import {
	type ChimeraImages,
	createAttachmentCollector,
} from "./attachments.ts";
import type { DiscordApi } from "./discord-rest.ts";
import { DISMISS_ASK } from "./dismiss.ts";
import { grantPathOf, guardDirOf } from "./guard/env.ts";
import { createLedger } from "./guard/ledger.ts";
import {
	backgroundRunning,
	createIntake,
	type IntakeDeps,
	isCloseRequest,
	isRestartRequest,
	seatStartFailedText,
} from "./intake.ts";
import { err, ok, type PartnerId } from "./lib/core.ts";
import { externalServiceUnavailable, rateLimited } from "./lib/errors.ts";
import { silentLogger } from "./logger.ts";
import { openSeatStore } from "./seat-store.ts";
import {
	aiCommand,
	BOT,
	EMOJI_TAGS,
	envelope,
	FORUM,
	fakeDiscord,
	fakeHishaku,
	fakeOrca,
	OWNER,
	press,
	say,
	seatMessage,
	TAGS,
	TEXT,
	tempDir,
} from "./test-support.ts";

const T0 = new Date("2026-11-05T08:00:00Z");
const PREAMBLE = "【人格】\n## 仕事のしかた\n【引き継ぎの指示】";
const AKARIN_PREAMBLE = "【あかりの人格】\n## 仕事のしかた";
const AKARIN_ROLE = "role-akarin";
const YUKARIN_ROLE = "role-yukarin";
const AKARIN_BOT = "akarin-bot";
const SYSTEM_BOT = "mizuya-bot";
const WRITES = new Set([
	"send",
	"createForumPost",
	"createMessage",
	"editMessage",
	"setTags",
	"addReaction",
	"removeReaction",
	"typing",
]);

/** 同じ Discord を別の bot として書く口。書き込みの呼び出しを bot ごとに残す。 */
const asBot = (api: DiscordApi, writes: string[]): DiscordApi =>
	new Proxy(api, {
		get: (target, key) => {
			const f = target[key as keyof DiscordApi];
			if (typeof f !== "function" || !WRITES.has(String(key))) return f;
			return (...args: unknown[]) => {
				writes.push(`${String(key)} ${String(args[0])}`);
				return (f as (...a: unknown[]) => unknown)(...args);
			};
		},
	});

const setup = async (
	opts: {
		seatLimit?: number;
		stateDir?: string;
		orca?: ReturnType<typeof fakeOrca>;
		seatsDir?: string;
		chimera?: ChimeraImages;
		akarin?: boolean;
		seatReplied?: () => void;
		hishaku?: ReturnType<typeof fakeHishaku>;
		findWorkBranches?: IntakeDeps["findWorkBranches"];
		/** 受付を作り直すときに、同じ Discord を渡す。 */
		d?: ReturnType<typeof fakeDiscord>;
		sys?: ReturnType<typeof fakeDiscord>;
	} = {},
) => {
	const stateDir = opts.stateDir ?? tempDir();
	const d = opts.d ?? fakeDiscord();
	// mizuya の bot が書くもの（ボタン）は、席の bot の書き込みと分けて見る
	const sys = opts.sys ?? fakeDiscord();
	const o = opts.orca ?? fakeOrca(opts.seatsDir);
	let clock = T0.getTime();
	const remembered: string[] = [];
	const rememberedBy: PartnerId[] = [];
	const activity: ActivityEntry[] = [];
	const writes = {
		yukarin: [] as string[],
		akarin: [] as string[],
		system: [] as string[],
	};
	const standup: {
		text: string;
		blocked: number;
		kind: string;
		partner: PartnerId;
	}[] = [];
	const seats = await openSeatStore(stateDir);
	const ledger = createLedger(guardDirOf(stateDir));
	let g = 0;
	const timers = new Set<() => void>();
	const delayed: { ms: number; fn: () => void }[] = [];
	const deps: IntakeDeps = {
		discord: asBot(d.api, writes.yukarin),
		akarin: opts.akarin
			? {
					discord: asBot(d.api, writes.akarin),
					botUserId: AKARIN_BOT,
					preamble: AKARIN_PREAMBLE,
				}
			: null,
		orca: o.orca,
		hishaku: opts.hishaku?.hishaku ?? null,
		findWorkBranches: opts.findWorkBranches ?? null,
		seats,
		approvals: await openApprovalStore(stateDir),
		ledger,
		summarize: vi.fn(async () => ok("請求書の整理")),
		collectAttachments: createAttachmentCollector({
			chimera: opts.chimera ?? null,
			logger: silentLogger,
		}),
		remember: async (s, partner) => {
			remembered.push(s);
			rememberedBy.push(partner);
		},
		recordActivity: async (e) => {
			activity.push(e);
		},
		standupDone: async (text, blocked, kind, partner) => {
			standup.push({ text, blocked: blocked.length, kind, partner });
		},
		preamble: PREAMBLE,
		botUserId: BOT,
		system: asBot(sys.api, writes.system),
		systemUserId: SYSTEM_BOT,
		roleIds: { yukarin: YUKARIN_ROLE, akarin: AKARIN_ROLE },
		ownerUserIds: new Set([OWNER]),
		workTextChannelId: TEXT,
		workForumChannelId: FORUM,
		seatLimit: opts.seatLimit ?? 6,
		sleepAfterMs: 2 * 60 * 60_000,
		doneLingerMs: 60 * 60_000,
		newGrantId: () => `g${++g}`,
		now: () => new Date(clock),
		every: (_ms, fn) => {
			timers.add(fn);
			return () => timers.delete(fn);
		},
		after: (ms, fn) => {
			delayed.push({ ms, fn });
		},
		logger: silentLogger,
		seatReplied: opts.seatReplied,
	};
	return {
		d,
		sys,
		o,
		seats,
		ledger,
		stateDir,
		remembered,
		rememberedBy,
		activity,
		writes,
		standup,
		intake: createIntake(deps),
		advance: (ms: number) => {
			clock += ms;
		},
		delayed,
		/** 待たせた呼び出しをすべて呼ぶ。 */
		fireDelayed: () => {
			for (const t of delayed.splice(0)) t.fn();
		},
		/** 入力中の表示のタイマーを 1 回分進める。 */
		tick: () => {
			for (const fn of timers) fn();
		},
	};
};

/** 完了したあと残している席が、残す時間（setup では 60 分）を過ぎて閉じるところまで進める。 */
const expireLinger = async (s: Awaited<ReturnType<typeof setup>>) => {
	s.advance(60 * 60_000);
	await s.intake.sleepIdle();
};

/** 人が仕事フォーラムに直接投稿し、席ができたところまで進める。 */
const openPost = async (
	s: Awaited<ReturnType<typeof setup>>,
	threadId = "p1",
	content = "README の誤字を直して",
) => {
	s.d.addThread(threadId, "README の誤字");
	await s.intake.handle(say(threadId, content, { first: true }));
	const seat = s.seats.get(threadId);
	if (!seat?.dispatchId) throw new Error("seat not started");
	return seat;
};

describe("新しい投稿", () => {
	it("仕事チャンネルの依頼から立てた投稿は、最初の発言で依頼者にメンションして通知する", async () => {
		const s = await setup();
		await s.intake.handle(envelope({}));
		expect(s.d.posts[0]?.content.startsWith(`<@${OWNER}> さんからの依頼`)).toBe(
			true,
		);
		expect(s.d.posts[0]?.notify).toEqual([OWNER]);
	});

	it("フォーラムの投稿への最初の返事でだけ、依頼者にメンションして通知する", async () => {
		const s = await setup();
		const seat = await openPost(s);
		await s.intake.onSeatMessage(
			seatMessage({
				type: "status",
				dispatchId: seat.dispatchId,
				body: "見ています",
			}),
		);
		await s.intake.onSeatMessage(
			seatMessage({
				type: "status",
				dispatchId: seat.dispatchId,
				body: "直しています",
			}),
		);
		expect(s.d.sent.filter((m) => m.channelId === "p1")).toEqual([
			{ channelId: "p1", content: `<@${OWNER}> 見ています`, notify: [OWNER] },
			{ channelId: "p1", content: "直しています" },
		]);
	});

	it("仕事チャンネルの依頼から投稿を立て、席を作って依頼を渡し、タグを作業中にする", async () => {
		const s = await setup();
		await s.intake.handle(envelope({}));

		expect(s.d.posts[0]).toEqual(
			expect.objectContaining({
				name: "請求書の整理",
				tagIds: ["tag-working"],
			}),
		);
		expect(s.d.sentTo(TEXT)[0]).toContain("フォーラムに立てました");
		const [start] = s.o.opsOf("startSeat") as {
			name: string;
			spec: string;
		}[];
		expect(start?.name).toBe("seat-thread1");
		// spec は人格・仕事のしかた・引き継ぎの指示の前置きに、依頼を続ける
		expect(start?.spec.startsWith(PREAMBLE)).toBe(true);
		expect(start?.spec).toContain("請求書を整理して");
		expect(s.seats.get("thread1")?.status).toBe("working");
		expect(s.d.tagsOf("thread1")).toEqual(["tag-working"]);
	});

	it("人が直接立てた投稿でも席を作る", async () => {
		const s = await setup();
		const seat = await openPost(s);
		expect(seat.path).toBe("/seats/seat-p1");
		const [start] = s.o.opsOf("startSeat") as { spec: string }[];
		expect(start?.spec).toContain("README の誤字を直して");
		expect(s.d.tagsOf("p1")).toEqual(["tag-working"]);
	});

	it("持ち主以外の人とほかの bot の発言では席を作らない", async () => {
		const s = await setup();
		s.d.addThread("p1", "x");
		await s.intake.handle(
			envelope({
				channel_id: "p1",
				message_id: "p1",
				author: { id: "other", display_name: "誰か", is_bot: false },
			}),
		);
		await s.intake.handle(
			envelope({ author: { id: OWNER, display_name: "bot", is_bot: true } }),
		);
		expect(s.o.opsOf("startSeat")).toEqual([]);
		expect(s.d.posts).toEqual([]);
	});

	it("席の数が上限なら順番待ちと書いて待たせ、空いたら始める", async () => {
		const s = await setup({ seatLimit: 1 });
		const first = await openPost(s, "p1");
		s.d.addThread("p2", "二つ目");
		await s.intake.handle(say("p2", "二つ目の依頼", { first: true }));
		expect(s.seats.get("p2")?.status).toBe("queued");
		expect(s.d.sentTo("p2")[0]).toContain("順番待ち");
		await s.intake.handle(say("p2", "追加でこれも"));

		await s.intake.onSeatMessage(
			seatMessage({
				type: "worker_done",
				dispatchId: first.dispatchId,
				body: "直しました\n状態: 完了",
			}),
		);
		await vi.waitFor(() => expect(s.seats.get("p2")?.status).toBe("working"));
		const starts = s.o.opsOf("startSeat") as { name: string; spec: string }[];
		expect(starts[1]?.name).toBe("seat-p2");
		expect(starts[1]?.spec).toContain("二つ目の依頼");
		expect(starts[1]?.spec).toContain("追加でこれも");
	});
});

describe("投稿への返事", () => {
	it("席が完了か質問を返したら seatReplied を呼び、途中経過では呼ばない", async () => {
		let replied = 0;
		const s = await setup({ seatReplied: () => replied++ });
		const seat = await openPost(s);
		await s.intake.onSeatMessage(
			seatMessage({
				type: "status",
				dispatchId: seat.dispatchId,
				body: "調べています",
			}),
		);
		expect(replied).toBe(0);
		await s.intake.onSeatMessage(
			seatMessage({
				type: "worker_done",
				dispatchId: seat.dispatchId,
				body: "見張りを止めました\n状態: 完了",
			}),
		);
		expect(replied).toBe(1);
	});

	it("作業中の席には send で渡し、続きの Dispatch を覚える", async () => {
		const s = await setup();
		const seat = await openPost(s);
		await s.intake.handle(say("p1", "ついでに CHANGELOG も"));
		const [send] = s.o.opsOf("send") as { dispatchId: string; body: string }[];
		expect(send?.dispatchId).toBe(seat.dispatchId);
		expect(send?.body).toContain("ちゃぬ: ついでに CHANGELOG も");
		const after = s.seats.get("p1");
		expect(after?.dispatchIds).toHaveLength(2);
		expect(after?.dispatchId).not.toBe(seat.dispatchId);
	});

	it("受付を作り直しても、volume の対応表から同じ席に渡す", async () => {
		const stateDir = tempDir();
		const orca = fakeOrca();
		const first = await setup({ stateDir, orca });
		const seat = await openPost(first);

		const again = await setup({ stateDir, orca });
		again.d.addThread("p1", "README の誤字");
		await again.intake.handle(say("p1", "まだですか"));
		const sends = orca.opsOf("send") as { dispatchId: string }[];
		expect(sends.at(-1)?.dispatchId).toBe(seat.dispatchId);
		expect(orca.opsOf("startSeat")).toHaveLength(1);
	});
});

describe("席の質問", () => {
	it("投稿に書いてタグを決めてほしいにし、返事を答えとして返す", async () => {
		const s = await setup();
		const seat = await openPost(s);
		const q = seatMessage({
			type: "question",
			dispatchId: seat.dispatchId,
			body: "どのブランチに push しますか？",
		});
		await s.intake.onSeatMessage(q);
		expect(s.d.sentTo("p1").at(-1)).toBe(
			`<@${OWNER}> どのブランチに push しますか？`,
		);
		expect(s.d.tagsOf("p1")).toEqual(["tag-decide"]);
		expect(s.seats.get("p1")?.status).toBe("asking");

		// ask のあとターンを終えた知らせは投稿に出さない
		await s.intake.onSeatMessage(
			seatMessage({
				type: "escalation",
				dispatchId: seat.dispatchId,
				stopReason: "finished",
				body: "端末の出力",
			}),
		);
		expect(s.d.sentTo("p1")).toHaveLength(1);

		await s.intake.handle(say("p1", "dev/typo で"));
		expect(s.o.opsOf("reply")).toEqual([
			{ messageId: q.id, body: expect.stringContaining("dev/typo で") },
		]);
		expect(s.seats.get("p1")?.status).toBe("working");
		expect(s.d.tagsOf("p1")).toEqual(["tag-working"]);
	});

	it("報告せずに止まった席は、止まったと書いて決めてほしいにし、次の返事は send で渡す", async () => {
		const s = await setup();
		const seat = await openPost(s);
		await s.intake.onSeatMessage(
			seatMessage({
				type: "escalation",
				dispatchId: seat.dispatchId,
				stopReason: "finished",
				body: "端末の出力",
			}),
		);
		expect(s.d.sentTo("p1").at(-1)).toContain("途中で止まりました");
		expect(s.d.sentTo("p1").join()).not.toContain("端末の出力");
		expect(s.d.tagsOf("p1")).toEqual(["tag-decide"]);
		await s.intake.handle(say("p1", "続けて"));
		expect(s.o.opsOf("send")).toHaveLength(1);
	});
});

describe("取り消せない操作で止まったとき", () => {
	it("止めた操作を質問に書き添え、OK で席の hook に 1 回だけの許可を渡し、次の報告で使わなかった許可を失効させる", async () => {
		const s = await setup();
		const seat = await openPost(s);
		const op = { tool: "Bash", target: "gh pr merge 3" };
		s.ledger.addPending("p1", { operation: op, reason: "gh pr merge は…" });
		const q = seatMessage({
			type: "question",
			dispatchId: seat.dispatchId,
			body: "PR をマージしてよいですか",
		});
		await s.intake.onSeatMessage(q);
		const asked = s.d.sentTo("p1").at(-1) ?? "";
		expect(asked).toContain("PR をマージしてよいですか");
		expect(asked).toContain("決めてほしいこと");
		expect(asked).toContain("gh pr merge 3");
		expect(s.d.tagsOf("p1")).toEqual(["tag-decide"]);

		await s.intake.handle(say("p1", "OK"));
		const grantPath = grantPathOf(guardDirOf(s.stateDir), "p1");
		expect(JSON.parse(readFileSync(grantPath, "utf8"))).toEqual({
			grant_id: "g1",
			operations: [op],
		});
		const [reply] = s.o.opsOf("reply") as { body: string }[];
		expect(reply?.body).toContain("1 回だけ許可した");

		await s.intake.onSeatMessage(
			seatMessage({
				type: "worker_done",
				dispatchId: seat.dispatchId,
				body: "マージしました\n状態: 完了",
			}),
		);
		expect(existsSync(grantPath)).toBe(false);
		const events = readFileSync(
			join(guardDirOf(s.stateDir), "log.jsonl"),
			"utf8",
		)
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l).event);
		expect(events).toEqual(["requested", "granted", "expired"]);
	});

	it("決まった言い方以外の返事なら許可せず、返事としてそのまま渡す", async () => {
		const s = await setup();
		const seat = await openPost(s);
		s.ledger.addPending("p1", {
			operation: { tool: "Bash", target: "git push origin main" },
			reason: "main への push",
		});
		await s.intake.onSeatMessage(
			seatMessage({
				type: "question",
				dispatchId: seat.dispatchId,
				body: "push してよい？",
			}),
		);
		await s.intake.handle(say("p1", "いや、dev/ にして"));
		expect(existsSync(grantPathOf(guardDirOf(s.stateDir), "p1"))).toBe(false);
		const [reply] = s.o.opsOf("reply") as { body: string }[];
		expect(reply?.body).toContain("いや、dev/ にして");
		expect(reply?.body).not.toContain("許可した");
	});

	/** 止めた操作で質問させ、ボタンの付いた依頼のメッセージの ID を返す。 */
	const askApproval = async (s: Awaited<ReturnType<typeof setup>>) => {
		const seat = await openPost(s);
		s.ledger.addPending("p1", {
			operation: { tool: "Bash", target: "git push origin main" },
			reason: "main への push",
		});
		await s.intake.onSeatMessage(
			seatMessage({
				type: "question",
				dispatchId: seat.dispatchId,
				body: "push してよい？",
			}),
		);
		expect(s.d.sent.every((m) => m.buttons === undefined)).toBe(true);
		const at = s.sys.sent.findIndex((m) => m.buttons !== undefined);
		expect(s.sys.sent[at]?.buttons).toEqual([
			"approval:grant",
			"approval:deny",
			"thread:dismiss",
		]);
		return `sent${at + 1}`;
	};
	const events = (s: Awaited<ReturnType<typeof setup>>) =>
		readFileSync(join(guardDirOf(s.stateDir), "log.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l).event);

	it("許可のボタンは持ち主が押したときだけ効き、投稿を許可済みに書き換え、二度押しや後の OK では重ねて許可しない", async () => {
		const s = await setup();
		const asked = await askApproval(s);
		const grantPath = grantPathOf(guardDirOf(s.stateDir), "p1");

		await s.intake.press(press("p1", asked, "approval:grant", "someone"));
		expect(existsSync(grantPath)).toBe(false);
		expect(s.sys.edited.has(asked)).toBe(false);

		await s.intake.press(press("p1", asked, "approval:grant"));
		expect(JSON.parse(readFileSync(grantPath, "utf8")).grant_id).toBe("g1");
		expect(s.sys.edited.get(asked)?.content).toContain("許可済み");
		expect(s.d.sentTo("p1").join()).toContain("git push origin main");
		const [reply] = s.o.opsOf("reply") as { body: string }[];
		expect(reply?.body).toContain("1 回だけ許可した");

		await s.intake.press(press("p1", asked, "approval:grant"));
		await s.intake.handle(say("p1", "OK"));
		expect(events(s)).toEqual(["requested", "granted"]);
		expect(s.o.opsOf("reply")).toHaveLength(1);
	});

	it("却下のボタンは投稿を却下済みに書き換え、許可も席への返事もしない", async () => {
		const s = await setup();
		const asked = await askApproval(s);
		await s.intake.press(press("p1", asked, "approval:deny"));
		expect(s.sys.edited.get(asked)?.content).toContain("却下済み");
		expect(existsSync(grantPathOf(guardDirOf(s.stateDir), "p1"))).toBe(false);
		expect(s.o.opsOf("reply")).toEqual([]);
		expect(s.o.opsOf("send")).toEqual([]);
		expect(events(s)).toEqual(["requested", "dismissed"]);
	});

	it("文章で返事しても依頼のボタンは外れ、後からボタンを押しても許可しない", async () => {
		const s = await setup();
		const asked = await askApproval(s);
		await s.intake.handle(say("p1", "いや、dev/ にして"));
		expect(s.sys.edited.get(asked)?.content).toContain("却下済み");
		await s.intake.press(press("p1", asked, "approval:grant"));
		expect(existsSync(grantPathOf(guardDirOf(s.stateDir), "p1"))).toBe(false);
		expect(events(s)).toEqual(["requested", "dismissed"]);
	});

	it("不要のボタンは待っていた許可を却下として片付け、席を閉じる", async () => {
		const s = await setup();
		const asked = await askApproval(s);
		await s.intake.press(press("p1", asked, "thread:dismiss"));
		expect(s.sys.edited.get(asked)?.content).toContain("却下済み");
		expect(s.sys.edited.get(asked)?.content).toContain("不要として閉じました");
		expect(existsSync(grantPathOf(guardDirOf(s.stateDir), "p1"))).toBe(false);
		expect(events(s)).toEqual(["requested", "dismissed"]);
		expect(s.seats.get("p1")).toBeNull();
		expect(s.o.opsOf("reply")).toEqual([]);
	});

	it("止めた操作を残したまま報告してきたら、完了にせず許可を待つ", async () => {
		const s = await setup();
		const seat = await openPost(s);
		s.ledger.addPending("p1", {
			operation: { tool: "Bash", target: "wrangler deploy" },
			reason: "デプロイ",
		});
		await s.intake.onSeatMessage(
			seatMessage({
				type: "worker_done",
				dispatchId: seat.dispatchId,
				body: "デプロイ以外は済みました\n状態: 完了",
			}),
		);
		expect(s.d.sentTo("p1").at(-1)).toContain("wrangler deploy");
		expect(s.d.tagsOf("p1")).toEqual(["tag-decide"]);
		expect(s.seats.get("p1")?.status).toBe("waiting");
		expect(s.o.opsOf("removeWorktree")).toEqual([]);
		// 活動ログには道具の名前だけを残し、コマンドの本文は残さない
		expect(s.activity).toEqual([
			expect.objectContaining({
				kind: "blocked",
				threadId: "p1",
				title: "README の誤字",
				tools: ["Bash"],
			}),
		]);
		expect(JSON.stringify(s.activity)).not.toContain("wrangler");
	});
});

describe("席の完了報告", () => {
	it("投稿に書いてタグを完了にし、記憶に 1 行残し、しばらく残した席を時間がたったら閉じる", async () => {
		const s = await setup();
		const seat = await openPost(s);
		await s.intake.onSeatMessage(
			seatMessage({
				type: "worker_done",
				dispatchId: seat.dispatchId,
				body: "直して PR を出しました\n状態: 完了",
				outcome: "succeeded",
			}),
		);
		expect(s.d.sentTo("p1").at(-1)).toBe(`<@${OWNER}> 直して PR を出しました`);
		expect(s.d.tagsOf("p1")).toEqual(["tag-done"]);
		expect(s.remembered).toEqual(["仕事フォーラムの「README の誤字」を終えた"]);
		expect(s.activity).toEqual([
			{
				at: T0,
				kind: "done",
				threadId: "p1",
				title: "README の誤字",
				partner: "yukarin",
				tools: [],
			},
		]);
		expect(s.seats.get("p1")).toMatchObject({ status: "waiting", doneAt: T0 });
		expect(s.o.opsOf("stopSeat")).toEqual([]);
		expect(s.o.live.has(seat.terminal ?? "")).toBe(true);

		s.advance(59 * 60_000);
		await s.intake.sleepIdle();
		expect(s.o.opsOf("stopSeat")).toEqual([]);
		s.advance(60_000);
		await s.intake.sleepIdle();
		expect(s.o.opsOf("stopSeat")).toEqual([
			expect.objectContaining({
				dispatchId: seat.dispatchId,
				terminal: seat.terminal,
			}),
		]);
		expect(s.o.opsOf("removeWorktree")).toEqual(["/seats/seat-p1"]);
		expect(s.o.live.has(seat.terminal ?? "")).toBe(false);
		expect(s.seats.get("p1")).toBeNull();
	});

	it("Mac でやる必要があれば、タグを引き継ぎにして席を閉じる", async () => {
		const s = await setup();
		const seat = await openPost(s);
		await s.intake.onSeatMessage(
			seatMessage({
				type: "worker_done",
				dispatchId: seat.dispatchId,
				body: "申し送りを書きました https://github.com/o/r/issues/9\n状態: 引き継ぎ",
			}),
		);
		expect(s.d.tagsOf("p1")).toEqual(["tag-handoff"]);
		expect(s.remembered[0]).toContain("Mac に引き継いだ");
		expect(s.activity.map((e) => e.kind)).toEqual(["handoff"]);
		expect(s.seats.get("p1")).toBeNull();
	});

	it("見張りを登録したら、タグを見張り中にして席をしばらく残す", async () => {
		const s = await setup();
		const seat = await openPost(s);
		await s.intake.onSeatMessage(
			seatMessage({
				type: "worker_done",
				dispatchId: seat.dispatchId,
				body: "24 時間おきに見張ります\n状態: 見張り中",
			}),
		);
		expect(s.d.tagsOf("p1")).toEqual(["tag-watching"]);
		expect(s.remembered[0]).toContain("見張りを始めた");
		expect(s.activity.map((e) => e.kind)).toEqual(["done"]);
		expect(s.seats.get("p1")?.doneAt).toEqual(T0);
		await expireLinger(s);
		expect(s.seats.get("p1")).toBeNull();
		expect(s.d.tagsOf("p1")).toEqual(["tag-watching"]);
	});

	it("フォーラムに後から足したタグも、次に付け替えるときに使う", async () => {
		const s = await setup();
		const forum = s.d.channels.get(FORUM);
		if (!forum) throw new Error("no forum");
		s.d.channels.set(FORUM, {
			...forum,
			availableTags: TAGS.filter((t) => t.id !== "tag-watching"),
		});
		const seat = await openPost(s);
		expect(s.d.tagsOf("p1")).toEqual(["tag-working"]);
		s.d.channels.set(FORUM, forum);
		await s.intake.onSeatMessage(
			seatMessage({
				type: "worker_done",
				dispatchId: seat.dispatchId,
				body: "24 時間おきに見張ります\n状態: 見張り中",
			}),
		);
		expect(s.d.tagsOf("p1")).toEqual(["tag-watching"]);
	});

	it("決めてほしいで終えたら席を残し、次の返事を続きとして渡す", async () => {
		const s = await setup();
		const seat = await openPost(s);
		await s.intake.onSeatMessage(
			seatMessage({
				type: "worker_done",
				dispatchId: seat.dispatchId,
				body: "A と B のどちらにしますか\n状態: 決めてほしい",
			}),
		);
		expect(s.d.tagsOf("p1")).toEqual(["tag-decide"]);
		expect(s.seats.get("p1")?.status).toBe("waiting");
		await s.intake.handle(say("p1", "A で"));
		expect(s.o.opsOf("send")).toHaveLength(1);
		expect(s.d.tagsOf("p1")).toEqual(["tag-working"]);
	});

	it("完了して席を閉じたあとにまた書くと、同じ投稿に新しい席を作ってこれまでのやりとりを渡す", async () => {
		const s = await setup();
		const seat = await openPost(s);
		await s.intake.onSeatMessage(
			seatMessage({
				type: "worker_done",
				dispatchId: seat.dispatchId,
				body: "直しました\n状態: 完了",
			}),
		);
		await expireLinger(s);
		s.d.history.set("p1", [
			{
				id: "p1",
				authorId: OWNER,
				authorName: "ちゃぬ",
				isBot: false,
				content: "README の誤字を直して",
			},
			{
				id: "b1",
				authorId: BOT,
				authorName: "ゆかりん",
				isBot: true,
				content: "直しました",
			},
			{
				id: "m9",
				authorId: OWNER,
				authorName: "ちゃぬ",
				isBot: false,
				content: "もう一か所あった",
			},
		]);
		await s.intake.handle(say("p1", "もう一か所あった"));
		const starts = s.o.opsOf("startSeat") as { name: string; spec: string }[];
		expect(starts).toHaveLength(2);
		expect(starts[1]?.name).toBe("seat-p1");
		expect(starts[1]?.spec.startsWith(PREAMBLE)).toBe(true);
		expect(starts[1]?.spec).toContain("[あなた] 直しました");
		expect(starts[1]?.spec).toContain("[ちゃぬ] もう一か所あった");
		expect(s.d.tagsOf("p1")).toEqual(["tag-working"]);
	});
});

describe("完了したあと残している席", () => {
	const done = (dispatchId: string | null, body: string) =>
		seatMessage({ type: "worker_done", dispatchId, body });
	const MAC = "mac-example";

	it("残している間に書かれた続きは、生きている席にそのまま渡す", async () => {
		const s = await setup();
		const seat = await openPost(s);
		await s.intake.onSeatMessage(
			done(seat.dispatchId, "直しました\n状態: 完了"),
		);
		expect(s.d.tagsOf("p1")).toEqual(["tag-done"]);
		s.advance(30 * 60_000);
		await s.intake.handle(say("p1", "もう一か所あった"));
		expect(s.o.opsOf("send")).toEqual([
			expect.objectContaining({
				dispatchId: seat.dispatchId,
				body: expect.stringContaining("もう一か所あった"),
			}),
		]);
		expect(s.o.opsOf("startSeat")).toHaveLength(1);
		expect(s.o.opsOf("resumeSeat")).toEqual([]);
		expect(s.seats.get("p1")).toMatchObject({
			status: "working",
			doneAt: null,
		});
		expect(s.d.tagsOf("p1")).toEqual(["tag-working"]);

		// 続きを受けた席は、残す時間を過ぎても閉じない
		s.advance(60 * 60_000);
		await s.intake.sleepIdle();
		expect(s.seats.get("p1")?.status).toBe("working");
		expect(s.o.opsOf("stopSeat")).toEqual([]);
	});

	it("残す時間を過ぎたら止めた席にせず、会話を預けて返し worktree ごと閉じる", async () => {
		const h = fakeHishaku();
		const s = await setup({ hishaku: h });
		const seat = await openPost(s);
		await s.intake.onSeatMessage(
			done(seat.dispatchId, "直しました\n状態: 完了"),
		);
		await expireLinger(s);
		expect(h.opsOf("push")).toEqual([
			{ number: 1234, generation: 1, cwd: "/seats/seat-p1", release: true },
		]);
		expect(s.o.opsOf("removeWorktree")).toEqual(["/seats/seat-p1"]);
		expect(s.seats.get("p1")).toBeNull();
		expect(s.d.tagsOf("p1")).toEqual(["tag-done"]);
	});

	it("席が上限なら、いちばん前に終えた残している席を閉じて新しい投稿を始める", async () => {
		const s = await setup({ seatLimit: 2 });
		const first = await openPost(s, "p1");
		const second = await openPost(s, "p2");
		await s.intake.onSeatMessage(
			done(first.dispatchId, "直しました\n状態: 完了"),
		);
		s.advance(60_000);
		await s.intake.onSeatMessage(
			done(second.dispatchId, "直しました\n状態: 完了"),
		);
		await openPost(s, "p3");
		expect(s.seats.get("p3")?.status).toBe("working");
		expect(s.d.sentTo("p3").join()).not.toContain("順番待ち");
		expect(s.seats.get("p1")).toBeNull();
		expect(s.o.opsOf("removeWorktree")).toEqual(["/seats/seat-p1"]);
		expect(s.seats.get("p2")?.status).toBe("waiting");
	});

	it("止めた席を起こすときも、残している席を閉じて空ける", async () => {
		const s = await setup({ seatLimit: 1 });
		const first = await openPost(s, "p1");
		await s.intake.onSeatMessage(
			seatMessage({
				type: "question",
				dispatchId: first.dispatchId,
				body: "?",
			}),
		);
		s.advance(3 * 60 * 60_000);
		await s.intake.sleepIdle();
		const second = await openPost(s, "p2");
		await s.intake.onSeatMessage(
			done(second.dispatchId, "直しました\n状態: 完了"),
		);
		await s.intake.handle(say("p1", "B で"));
		expect(s.o.opsOf("resumeSeat")).toHaveLength(1);
		expect(s.seats.get("p1")?.status).toBe("working");
		expect(s.seats.get("p2")).toBeNull();
	});

	it("朝会・見回りの席は残さず、すぐ閉じる", async () => {
		const s = await setup();
		const id = await s.intake.startStandup("見回りの spec", "patrol");
		await s.intake.onSeatMessage(
			done(s.seats.get(id)?.dispatchId ?? null, "```json\n{}\n```"),
		);
		expect(s.standup.map((x) => x.kind)).toEqual(["patrol"]);
		expect(s.seats.get(id)).toBeNull();
		expect(s.o.opsOf("removeWorktree")).toEqual([`/seats/seat-${id}`]);
	});

	it("残している席を Mac に頼まれたら、すぐ預けて返し貸し出し中にする", async () => {
		const h = fakeHishaku();
		const s = await setup({ hishaku: h });
		const seat = await openPost(s);
		await s.intake.onSeatMessage(
			done(seat.dispatchId, "直しました\n状態: 完了"),
		);
		h.behavior.renew = () => ok({ releaseRequestedBy: MAC });
		await s.intake.renewLeases();
		expect(h.opsOf("push")).toEqual([
			{ number: 1234, generation: 1, cwd: "/seats/seat-p1", release: true },
		]);
		expect(s.seats.get("p1")).toMatchObject({ status: "lent", doneAt: null });
		expect(s.d.tagsOf("p1")).toEqual(["tag-handoff"]);
	});

	it("作業中に Mac に頼まれていれば、完了したところで残さずに渡す", async () => {
		const h = fakeHishaku();
		const s = await setup({ hishaku: h });
		const seat = await openPost(s);
		h.behavior.renew = () => ok({ releaseRequestedBy: MAC });
		await s.intake.renewLeases();
		await s.intake.onSeatMessage(
			done(seat.dispatchId, "直しました\n状態: 完了"),
		);
		expect(h.opsOf("push")).toHaveLength(1);
		expect(s.seats.get("p1")?.status).toBe("lent");
	});

	it("受付を作り直しても終えた時刻を覚えていて、時間がたったら閉じる", async () => {
		const s = await setup();
		const seat = await openPost(s);
		await s.intake.onSeatMessage(
			done(seat.dispatchId, "直しました\n状態: 完了"),
		);
		const reopened = await openSeatStore(s.stateDir);
		expect(reopened.get("p1")).toMatchObject({
			status: "waiting",
			doneAt: T0,
			doneStatus: "完了",
		});

		const again = await setup({
			stateDir: s.stateDir,
			orca: s.o,
			d: s.d,
			sys: s.sys,
		});
		await again.intake.reconcile();
		expect(again.seats.get("p1")).toMatchObject({
			status: "waiting",
			doneAt: T0,
		});
		await expireLinger(again);
		expect(again.seats.get("p1")).toBeNull();
		expect(s.o.opsOf("removeWorktree")).toEqual(["/seats/seat-p1"]);
	});

	it("受付を作り直して席の Claude がいなくなっていたら、止めた席にせず閉じる", async () => {
		const s = await setup();
		const seat = await openPost(s);
		await s.intake.onSeatMessage(
			done(seat.dispatchId, "直しました\n状態: 完了"),
		);
		s.o.live.delete(seat.terminal ?? "");
		await s.intake.reconcile();
		expect(s.seats.get("p1")).toBeNull();
		expect(s.o.opsOf("removeWorktree")).toEqual(["/seats/seat-p1"]);
		expect(s.d.tagsOf("p1")).toEqual(["tag-done"]);
	});
});

describe("決めてほしいまま時間がたった席", () => {
	it("Claude だけ止め、返事が来たら前の会話のまま起こす", async () => {
		const s = await setup();
		const seat = await openPost(s);
		await s.intake.onSeatMessage(
			seatMessage({
				type: "question",
				dispatchId: seat.dispatchId,
				body: "どちらにしますか",
			}),
		);
		s.advance(60 * 60_000);
		await s.intake.sleepIdle();
		expect(s.o.opsOf("stopSeat")).toEqual([]);

		s.advance(60 * 60_000);
		await s.intake.sleepIdle();
		expect(s.o.opsOf("stopSeat")).toHaveLength(1);
		expect(s.o.opsOf("removeWorktree")).toEqual([]);
		expect(s.seats.get("p1")?.status).toBe("sleeping");
		expect(s.o.live.has(seat.terminal ?? "")).toBe(false);

		await s.intake.handle(say("p1", "B で"));
		const [resume] = s.o.opsOf("resumeSeat") as {
			path: string;
			spec: string;
		}[];
		expect(resume?.path).toBe("/seats/seat-p1");
		expect(resume?.spec).toContain("「どちらにしますか」");
		expect(resume?.spec).toContain("ちゃぬ: B で");
		expect(s.seats.get("p1")?.status).toBe("working");
		expect(s.d.tagsOf("p1")).toEqual(["tag-working"]);
	});

	it("止めた席の worktree が消えていたら、やりとりを読ませて新しい席で始める", async () => {
		const s = await setup();
		const seat = await openPost(s);
		await s.intake.onSeatMessage(
			seatMessage({
				type: "question",
				dispatchId: seat.dispatchId,
				body: "どちらにしますか",
			}),
		);
		s.advance(3 * 60 * 60_000);
		await s.intake.sleepIdle();
		s.o.worktrees.delete("/seats/seat-p1");

		await s.intake.handle(say("p1", "閉じて"));
		expect(s.o.opsOf("startSeat")).toHaveLength(2);
		expect(s.seats.get("p1")?.status).toBe("working");
		expect(s.d.sentTo("p1").join("\n")).not.toContain(
			"席を始められませんでした",
		);
		expect(s.d.tagsOf("p1")).toEqual(["tag-working"]);
	});

	it("止めた席は上限に数えない", async () => {
		const s = await setup({ seatLimit: 1 });
		const seat = await openPost(s, "p1");
		await s.intake.onSeatMessage(
			seatMessage({ type: "question", dispatchId: seat.dispatchId, body: "?" }),
		);
		s.advance(3 * 60 * 60_000);
		await s.intake.sleepIdle();
		await openPost(s, "p2");
		expect(s.seats.get("p2")?.status).toBe("working");
	});
});

describe("起動時の突き合わせ", () => {
	it("対応表に無い席の端末と worktree は片付け、対応表にある席は残す", async () => {
		const orca = fakeOrca();
		const s = await setup({ orca });
		const seat = await openPost(s);
		orca.worktrees.add("/seats/seat-old");
		orca.strayTerminals.push(
			{ handle: "t-old", path: "/seats/seat-old" },
			{ handle: seat.terminal ?? "", path: "/seats/seat-p1" },
			{ handle: "t-extra", path: "/seats/seat-p1" },
		);
		await s.intake.reconcile();
		expect(orca.opsOf("closeTerminal")).toEqual(["t-old", "t-extra"]);
		expect(orca.opsOf("removeWorktree")).toEqual(["/seats/seat-old"]);
		expect(s.seats.get("p1")?.status).toBe("working");
	});

	it("Claude がいなくなった席は止めた扱いにし、作業中だったなら投稿で知らせる", async () => {
		const orca = fakeOrca();
		const s = await setup({ orca });
		const seat = await openPost(s);
		orca.live.delete(seat.terminal ?? "");
		await s.intake.reconcile();
		expect(s.seats.get("p1")?.status).toBe("sleeping");
		expect(s.d.sentTo("p1").at(-1)).toContain("受付を作り直した");
		expect(s.d.tagsOf("p1")).toEqual(["tag-decide"]);
		await s.intake.handle(say("p1", "続けて"));
		expect(orca.opsOf("resumeSeat")).toHaveLength(1);
	});
});

describe("朝会の席", () => {
	it("朝会の席は聞かせず、報告を決めてほしいことに回して席を閉じる", async () => {
		const s = await setup();
		const id = await s.intake.startStandup("朝会の spec");
		const seat = s.seats.get(id);
		expect(seat?.standup).toBe(true);
		const [start] = s.o.opsOf("startSeat") as { name: string; spec: string }[];
		expect(start?.name).toBe(`seat-${id}`);

		const q = seatMessage({
			type: "question",
			dispatchId: seat?.dispatchId ?? null,
			body: "?",
		});
		await s.intake.onSeatMessage(q);
		expect(s.o.opsOf("reply")).toEqual([
			{
				messageId: q.id,
				body: expect.stringContaining("朝会と見回りでは持ち主に聞けない"),
			},
		]);

		s.ledger.addPending(id, {
			operation: { tool: "Bash", target: "gh pr merge 1" },
			reason: "merge",
		});
		await s.intake.onSeatMessage(
			seatMessage({
				type: "worker_done",
				dispatchId: seat?.dispatchId ?? null,
				body: "```json\n{}\n```",
			}),
		);
		expect(s.standup).toEqual([
			{
				text: "```json\n{}\n```",
				blocked: 1,
				kind: "standup",
				partner: "yukarin",
			},
		]);
		expect(s.seats.get(id)).toBeNull();
		expect(s.o.opsOf("removeWorktree")).toEqual([`/seats/seat-${id}`]);
	});

	it("見回りの席の報告は見回りとして返す", async () => {
		const s = await setup();
		const id = await s.intake.startStandup("見回りの spec", "patrol");
		expect(id.startsWith("patrol-")).toBe(true);
		await s.intake.onSeatMessage(
			seatMessage({
				type: "worker_done",
				dispatchId: s.seats.get(id)?.dispatchId ?? null,
				body: "x",
			}),
		);
		expect(s.standup).toEqual([
			{ text: "x", blocked: 0, kind: "patrol", partner: "yukarin" },
		]);
	});

	it("見張りの席の報告は見張りとして返す", async () => {
		const s = await setup();
		const id = await s.intake.startStandup("見張りの spec", "watch");
		expect(id.startsWith("watch-")).toBe(true);
		await s.intake.onSeatMessage(
			seatMessage({
				type: "worker_done",
				dispatchId: s.seats.get(id)?.dispatchId ?? null,
				body: "x",
			}),
		);
		expect(s.standup).toEqual([
			{ text: "x", blocked: 0, kind: "watch", partner: "yukarin" },
		]);
	});

	it("見張りの席は持ち主の Akarin が Codex で受け持ち、報告も Akarin の名で返す", async () => {
		const s = await setup({ akarin: true });
		const id = await s.intake.startStandup("見張りの spec", "watch", "akarin");
		const [start] = s.o.opsOf("startSeat") as { spec: string; agent: string }[];
		expect(start?.agent).toBe("codex");
		expect(start?.spec.startsWith(AKARIN_PREAMBLE)).toBe(true);
		expect(start?.spec).not.toContain(PREAMBLE);
		await s.intake.onSeatMessage(
			seatMessage({
				type: "worker_done",
				dispatchId: s.seats.get(id)?.dispatchId ?? null,
				body: "x",
			}),
		);
		expect(s.standup).toEqual([
			{ text: "x", blocked: 0, kind: "watch", partner: "akarin" },
		]);
		// 投稿を持たない席なので、閉じたら担当も残さない
		expect(s.seats.partnerOf(id)).toBeNull();
	});

	it("GitHub の出来事の席の報告は event として返す", async () => {
		const s = await setup();
		const id = await s.intake.startStandup("出来事の spec", "event");
		expect(id.startsWith("event-")).toBe(true);
		// 投稿を持たない席の ID を Discord のチャンネルとして引かない
		expect(s.d.api.getChannel).not.toHaveBeenCalledWith(id);
		await s.intake.onSeatMessage(
			seatMessage({
				type: "worker_done",
				dispatchId: s.seats.get(id)?.dispatchId ?? null,
				body: "x",
			}),
		);
		expect(s.standup).toEqual([
			{ text: "x", blocked: 0, kind: "event", partner: "yukarin" },
		]);
	});
});

describe("席を始められなかったとき", () => {
	it("止まった所が分かる短い文を投稿に書き、Orca の理由の文は出さない", async () => {
		const orca = fakeOrca();
		vi.mocked(orca.orca.startSeat).mockResolvedValueOnce({
			ok: false,
			error: {
				type: "OrcaFailed",
				command: "orchestration worker-start",
				reason:
					"Error: start_failed: agent_readiness: Agent startup blocked: agent-trust-workspace /home/worker/x",
			},
		});
		const s = await setup({ orca });
		s.d.addThread("p1", "x");
		await s.intake.handle(say("p1", "頼みます", { first: true }));
		expect(s.d.sentTo("p1")).toEqual([
			`<@${OWNER}> 席を始められませんでした（Claude の作業場所の確認で止まった）。返事をくれれば、もう一度始めます。`,
		]);
		expect(s.d.tagsOf("p1")).toEqual(["tag-decide"]);
	});

	it("理由ごとに文を分ける", () => {
		const of = (type: "OrcaFailed" | "SeatTrustFailed", reason: string) =>
			seatStartFailedText({ type, command: "c", reason });
		expect(of("SeatTrustFailed", "lock")).toContain(
			"Claude の作業場所を信頼済みにできなかった",
		);
		expect(
			of("OrcaFailed", "start_failed: agent_readiness: timeout"),
		).toContain("Claude が起動しきらなかった");
		expect(of("OrcaFailed", "selector_not_found")).toContain(
			"Orca が席を作れなかった",
		);
	});
});

describe("裏の作業を待つ席", () => {
	const tail = (footer: string) =>
		`Worker t1 ended its turn without sending worker_done.\nLast output:\n● バックグラウンドで回しました。終わるまで待ちます。\n${footer}`;

	it("裏の shell を残してターンを終えた知らせは、止まったと書かない", async () => {
		const s = await setup();
		const seat = await openPost(s);
		await s.intake.onSeatMessage(
			seatMessage({
				type: "escalation",
				dispatchId: seat.dispatchId,
				stopReason: "finished",
				body: tail("✻ Worked for 7s · done 2:06 PM · 1 shell still running"),
			}),
		);
		expect(s.d.sentTo("p1")).toEqual([]);
		expect(s.seats.get("p1")?.status).toBe("working");
		expect(s.d.tagsOf("p1")).toEqual(["tag-working"]);
	});

	it("裏の作業を待つ間の書き込みには、最後の途中経過を添えて作業中と即答し、席にも渡す", async () => {
		const s = await setup();
		const seat = await openPost(s);
		await s.intake.onSeatMessage(
			seatMessage({
				type: "status",
				dispatchId: seat.dispatchId,
				body: "描画を待っています。\n5 分ほどです。",
			}),
		);
		await s.intake.onSeatMessage(
			seatMessage({
				type: "escalation",
				dispatchId: seat.dispatchId,
				stopReason: "finished",
				body: tail("✻ done · 1 shell still running"),
			}),
		);
		await s.intake.handle(say("p1", "止まってない？"));
		expect(s.d.sentTo("p1").at(-1)).toBe(
			"作業中です。（描画を待っています。 5 分ほどです。）",
		);
		const [sent] = s.o.opsOf("send") as { body: string }[];
		expect(sent?.body).toContain("手が空いたら status で答え");
		expect(sent?.body).toContain("止まってない？");
		// 席が答えるまでの次の書き込みにも即答する
		await s.intake.handle(say("p1", "まだ？"));
		expect(s.d.sentTo("p1").at(-1)).toBe(
			"作業中です。（描画を待っています。 5 分ほどです。）",
		);
		expect(s.seats.get("p1")?.status).toBe("working");
	});

	it("途中経過が無ければ、いまやっていることは省く。席が報告したら即答はやめる", async () => {
		const s = await setup();
		const seat = await openPost(s);
		await s.intake.onSeatMessage(
			seatMessage({
				type: "escalation",
				dispatchId: seat.dispatchId,
				stopReason: "finished",
				body: tail("· 2 shells ·"),
			}),
		);
		await s.intake.handle(say("p1", "どう？"));
		expect(s.d.sentTo("p1")).toEqual([`<@${OWNER}> 作業中です。`]);
		const current = s.seats.get("p1");
		await s.intake.onSeatMessage(
			seatMessage({
				type: "question",
				dispatchId: current?.dispatchId ?? null,
				body: "A と B のどちらにしますか",
			}),
		);
		await s.intake.handle(say("p1", "A で"));
		expect(s.d.sentTo("p1")).toEqual([
			`<@${OWNER}> 作業中です。`,
			"A と B のどちらにしますか",
		]);
	});

	it("裏の作業を待っていない席には即答しない", async () => {
		const s = await setup();
		await openPost(s);
		await s.intake.handle(say("p1", "ついでに C も"));
		expect(s.d.sentTo("p1")).toEqual([]);
		expect(s.o.opsOf("send")).toHaveLength(1);
	});

	it("裏の作業が残っているかを端末の末尾から見分ける", () => {
		expect(backgroundRunning(tail("✻ done · 1 shell still running"))).toBe(
			true,
		);
		expect(
			backgroundRunning(tail("⏵⏵ auto mode on · 2 shells · ↓ to manage")),
		).toBe(true);
		expect(backgroundRunning(tail("✻ Worked for 9s · done 10:41 AM"))).toBe(
			false,
		);
	});
});

describe("途中経過", () => {
	it("席の status は、完了を待たずにそのまま投稿に書き、状態とタグは変えない", async () => {
		const s = await setup();
		const seat = await openPost(s);
		await s.intake.onSeatMessage(
			seatMessage({
				type: "status",
				dispatchId: seat.dispatchId,
				body: "描画を待っています。5 分ほどです。",
			}),
		);
		// Dispatch を付けずに送られても、送り手の端末から席を引く
		await s.intake.onSeatMessage(
			seatMessage({
				type: "status",
				dispatchId: null,
				from: seat.terminal ?? "",
				body: "止まってはいません。描き終わったら続けます。",
			}),
		);
		expect(s.d.sentTo("p1")).toEqual([
			`<@${OWNER}> 描画を待っています。5 分ほどです。`,
			"止まってはいません。描き終わったら続けます。",
		]);
		expect(s.seats.get("p1")?.status).toBe("working");
		expect(s.d.tagsOf("p1")).toEqual(["tag-working"]);
	});
});

describe("起動し直して", () => {
	it("席の Claude を止めて、同じ worktree で前の会話のまま起こす", async () => {
		const s = await setup();
		const seat = await openPost(s);
		await s.intake.onSeatMessage(
			seatMessage({
				type: "question",
				dispatchId: seat.dispatchId,
				body: "どれにしますか",
			}),
		);
		await s.intake.handle(say("p1", "起動し直して"));
		expect(s.o.opsOf("stopSeat")).toEqual([
			expect.objectContaining({ terminal: seat.terminal }),
		]);
		const [resume] = s.o.opsOf("resumeSeat") as {
			path: string;
			spec: string;
		}[];
		expect(resume?.path).toBe("/seats/seat-p1");
		expect(resume?.spec).toContain("起動し直した");
		expect(resume?.spec).toContain("「どれにしますか」");
		expect(s.o.opsOf("send")).toEqual([]);
		expect(s.o.opsOf("reply")).toEqual([]);
		expect(s.d.sentTo("p1").at(-1)).toContain("起動し直します");
		expect(s.seats.get("p1")?.status).toBe("working");
		expect(s.d.tagsOf("p1")).toEqual(["tag-working"]);
	});

	it("決まった言い方だけを席を閉じる一言とみなす", () => {
		for (const t of [
			"終了",
			"クローズ",
			"Close",
			"CLOSE!",
			"閉じて。",
			"おわり！",
			" 終わり ",
			"<@1> 終了",
		]) {
			expect(isCloseRequest(t), t).toBe(true);
		}
		for (const t of ["終了したら教えて", "閉じないで", "closed", "OK"]) {
			expect(isCloseRequest(t), t).toBe(false);
		}
	});

	it("決まった言い方だけを起動し直す頼みとみなす", () => {
		for (const t of [
			"起動し直して",
			"起動しなおして。",
			"再起動して",
			"<@1> 再起動",
			"起動し直してください",
		]) {
			expect(isRestartRequest(t), t).toBe(true);
		}
		for (const t of ["起動し直してから A をやって", "再起動しないで", "OK"]) {
			expect(isRestartRequest(t), t).toBe(false);
		}
	});

	it("席が無い投稿では、ふつうの返事として新しい席を作る", async () => {
		const s = await setup();
		s.d.addThread("p9", "x");
		await s.intake.handle(say("p9", "起動し直して"));
		expect(s.o.opsOf("stopSeat")).toEqual([]);
		expect(s.o.opsOf("startSeat")).toHaveLength(1);
	});
});

describe("席の返事の添付", () => {
	const seatWithOut = async (chimera?: ChimeraImages) => {
		const root = tempDir();
		const s = await setup({ seatsDir: root, ...(chimera ? { chimera } : {}) });
		const seat = await openPost(s);
		const out = join(seat.path ?? "", "out");
		mkdirSync(out, { recursive: true });
		writeFileSync(join(out, "shot.png"), "png");
		writeFileSync(join(root, "secret.txt"), "secret");
		symlinkSync(join(root, "secret.txt"), join(out, "link.txt"));
		return { s, seat };
	};

	it("worker_done の添付の行を本文から外して投稿に付け、状態の行も読む", async () => {
		const { s, seat } = await seatWithOut();
		await s.intake.onSeatMessage(
			seatMessage({
				type: "worker_done",
				dispatchId: seat.dispatchId,
				outcome: "succeeded",
				body: "直しました。\n添付: out/shot.png\n状態: 完了\n添付: out/link.txt",
			}),
		);
		expect(s.d.sent.filter((m) => m.channelId === "p1")).toEqual([
			{
				channelId: "p1",
				content: `<@${OWNER}> 直しました。\n\n添付できなかったもの:\n- out/link.txt（out/ の外を指している）`,
				files: ["shot.png"],
				notify: [OWNER],
			},
		]);
		expect(s.d.tagsOf("p1")).toEqual(["tag-done"]);
	});

	it("ask と status の添付も付け、chimera の行は chimera から取って付ける", async () => {
		const chimera = vi.fn(async (id: string) =>
			ok({
				name: `${id}.png`,
				contentType: "image/png",
				data: new Uint8Array([1]),
			}),
		);
		const { s, seat } = await seatWithOut(chimera);
		await s.intake.onSeatMessage(
			seatMessage({
				type: "status",
				dispatchId: seat.dispatchId,
				body: "1 枚目です。\nchimera: abc123",
			}),
		);
		await s.intake.onSeatMessage(
			seatMessage({
				type: "question",
				dispatchId: seat.dispatchId,
				body: "どちらにしますか\nchimera: abc123\n添付: out/shot.png\n添付: ../secret.txt",
			}),
		);
		const posted = s.d.sent.filter((m) => m.channelId === "p1");
		expect(posted[0]).toEqual({
			channelId: "p1",
			content: `<@${OWNER}> 1 枚目です。`,
			files: ["abc123.png"],
			notify: [OWNER],
		});
		expect(posted[1]?.content).toBe(
			"どちらにしますか\n\n添付できなかったもの:\n- ../secret.txt（out/ の外のパス）",
		);
		expect(posted[1]?.files).toEqual(["abc123.png", "shot.png"]);
		// 席が覚える質問は添付の行を外した本文
		expect(s.seats.get("p1")?.question).toBe(posted[1]?.content);
		expect(chimera).toHaveBeenCalledTimes(2);
	});
});

describe("作業中かを Discord で見せる", () => {
	it("席の Claude が動いている間だけ、投稿に入力中の表示を送り続ける", async () => {
		const s = await setup();
		const seat = await openPost(s);
		expect(s.d.typing).toEqual(["p1"]);
		s.tick();
		s.tick();
		expect(s.d.typing).toEqual(["p1", "p1", "p1"]);

		await s.intake.onSeatMessage(
			seatMessage({
				type: "question",
				dispatchId: seat.dispatchId,
				body: "どちらにしますか",
			}),
		);
		s.tick();
		expect(s.d.typing).toHaveLength(3);

		await s.intake.handle(say("p1", "A で"));
		expect(s.d.typing).toHaveLength(4);
	});

	it("依頼メッセージのリアクションを受付・作業中・決めてほしいで付け替え、新しい返事に移す", async () => {
		const s = await setup();
		const seat = await openPost(s);
		expect(s.d.reactionsOn("p1", "p1")).toEqual(["⏳"]);

		await s.intake.onSeatMessage(
			seatMessage({
				type: "question",
				dispatchId: seat.dispatchId,
				body: "どちらにしますか",
			}),
		);
		expect(s.d.reactionsOn("p1", "p1")).toEqual(["❓"]);

		const answer = say("p1", "A で");
		await s.intake.handle(answer);
		expect(s.d.reactionsOn("p1", "p1")).toEqual([]);
		expect(s.d.reactionsOn("p1", answer.payload.message_id)).toEqual(["⏳"]);
	});

	it("仕事チャンネルの依頼には受付の絵文字を先に付け、完了で ✅ にする", async () => {
		const s = await setup();
		const req = envelope({});
		await s.intake.handle(req);
		expect(s.d.reactionsOn(TEXT, req.payload.message_id)).toEqual(["⏳"]);

		const seat = s.seats.get("thread1");
		await s.intake.onSeatMessage(
			seatMessage({
				type: "worker_done",
				dispatchId: seat?.dispatchId ?? "",
				body: "整理しました\n状態: 完了",
			}),
		);
		expect(s.d.reactionsOn(TEXT, req.payload.message_id)).toEqual(["✅"]);
	});

	it("順番待ちの席は受付のまま待たせる", async () => {
		const s = await setup({ seatLimit: 1 });
		await openPost(s);
		s.d.addThread("p2", "二つ目");
		await s.intake.handle(say("p2", "こっちも", { first: true }));
		expect(s.d.reactionsOn("p2", "p2")).toEqual(["👀"]);
		expect(s.d.typing).not.toContain("p2");
	});

	it("席を開いて作業し、完了しても、状態だけを書いたメッセージは投稿しない", async () => {
		const s = await setup();
		const seat = await openPost(s);
		await s.intake.onSeatMessage(
			seatMessage({
				type: "status",
				dispatchId: seat.dispatchId,
				body: "誤字を探しています",
			}),
		);
		await s.intake.onSeatMessage(
			seatMessage({
				type: "worker_done",
				dispatchId: seat.dispatchId,
				body: "直しました\n状態: 完了",
			}),
		);
		await expireLinger(s);
		expect(
			s.writes.system.filter((w) => w.startsWith("createMessage")),
		).toEqual([]);
		expect(vi.mocked(s.sys.api.editMessage)).not.toHaveBeenCalled();
		const posted = [
			...s.d.sentTo("p1"),
			...s.sys.sentTo("p1"),
			...[...s.sys.edited.values()].map((m) => m.content),
		];
		expect(posted.filter((t) => t.startsWith("状態:"))).toEqual([]);
		expect(s.d.reactionsOn("p1", "p1")).toEqual(["✅"]);
		expect(s.d.tagsOf("p1")).toEqual(["tag-done"]);
	});

	it("状態の欄を持っていた前の seats.json も読める", async () => {
		const dir = tempDir();
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, "seats.json"),
			JSON.stringify({
				run_id: null,
				reception: null,
				seats: {
					p1: {
						status: "waiting",
						path: "/seats/seat-p1",
						terminal: "t1",
						dispatch_id: "d1",
						dispatch_ids: ["d1"],
						question_id: null,
						question: null,
						expect_stop: false,
						waiting_since: null,
						pending: [],
						queued_at: null,
						standup: false,
						panel_id: "m1",
						panel_text: "状態: 決めてほしい",
						panel_at: 0,
						label: "決めてほしい",
						label_since: 0,
					},
				},
			}),
		);
		const store = await openSeatStore(dir);
		expect(store.get("p1")).toMatchObject({
			status: "waiting",
			dispatchId: "d1",
		});
		expect(store.get("p1")).not.toHaveProperty("panelId");
	});

	it("作業中の席の数を数える。朝会と待っている席は数えない", async () => {
		const s = await setup();
		const seat = await openPost(s);
		s.d.addThread("p2", "二つ目");
		await s.intake.handle(say("p2", "こっちも", { first: true }));
		await s.intake.startStandup("朝会");
		expect(s.intake.summary()).toEqual({
			working: 2,
			partners: { yukarin: 2, akarin: 0 },
		});

		await s.intake.onSeatMessage(
			seatMessage({
				type: "question",
				dispatchId: seat.dispatchId,
				body: "どちらにしますか",
			}),
		);
		expect(s.intake.summary()).toEqual({
			working: 1,
			partners: { yukarin: 1, akarin: 0 },
		});
	});
});

describe("Akarin の席", () => {
	it("仕事チャンネルで Akarin へのメンションがあれば、Akarin の話し手で投稿を立て、Codex の席に Akarin の前置きを渡す", async () => {
		const s = await setup({ akarin: true });
		await s.intake.handle(
			envelope({
				content: "<@1> 請求書を整理して",
				mentions: [],
				mention_roles: [AKARIN_ROLE],
			}),
		);
		const [start] = s.o.opsOf("startSeat") as { spec: string; agent: string }[];
		expect(start?.agent).toBe("codex");
		expect(start?.spec.startsWith(AKARIN_PREAMBLE)).toBe(true);
		expect(s.seats.partnerOf("thread1")).toBe("akarin");
		expect(s.writes.akarin).toEqual(
			expect.arrayContaining([
				`createForumPost ${FORUM}`,
				`send ${TEXT}`,
				`addReaction ${TEXT}`,
				"typing thread1",
			]),
		);
		expect(s.writes.yukarin).toEqual([]);
		expect(s.intake.summary()).toEqual({
			working: 1,
			partners: { yukarin: 0, akarin: 1 },
		});
	});

	it("仕事チャンネルで Yukarin の role へのメンションがあれば Yukarin が受ける", async () => {
		const s = await setup({ akarin: true });
		await s.intake.handle(
			envelope({ mentions: [], mention_roles: [YUKARIN_ROLE] }),
		);
		expect(s.seats.partnerOf("thread1")).toBe("yukarin");
		expect(s.writes.akarin).toEqual([]);
	});

	it("仕事チャンネルで Yukarin の bot へのメンションがあれば Yukarin が受ける", async () => {
		const s = await setup({ akarin: true });
		await s.intake.handle(envelope({ mentions: [BOT] }));
		expect(s.seats.partnerOf("thread1")).toBe("yukarin");
		expect(s.writes.akarin).toEqual([]);
	});

	it("仕事チャンネルで mizuya の bot へのメンションがあれば Yukarin が受ける", async () => {
		const s = await setup({ akarin: true });
		await s.intake.handle(envelope({ mentions: [SYSTEM_BOT] }));
		expect(s.seats.partnerOf("thread1")).toBe("yukarin");
	});

	it("席の bot と mizuya の bot の発言では席を作らない", async () => {
		const s = await setup({ akarin: true });
		for (const id of [BOT, AKARIN_BOT, SYSTEM_BOT]) {
			await s.intake.handle(
				envelope({
					author: { id, display_name: "bot", is_bot: true },
					mentions: [BOT],
				}),
			);
		}
		expect(s.o.opsOf("startSeat")).toEqual([]);
	});

	it("仕事チャンネルで Akarin の bot へのメンションがあれば Akarin が受ける", async () => {
		const s = await setup({ akarin: true });
		await s.intake.handle(envelope({ mentions: [AKARIN_BOT] }));
		expect(s.seats.partnerOf("thread1")).toBe("akarin");
		expect(s.writes.yukarin).toEqual([]);
	});

	it("フォーラムの新しい投稿で Akarin の bot へのメンションがあれば Akarin が受ける", async () => {
		const s = await setup({ akarin: true });
		s.d.addThread("p1", "README の誤字");
		await s.intake.handle(
			envelope({
				channel_id: "p1",
				message_id: "p1",
				content: "README の誤字を直して",
				mentions: [AKARIN_BOT],
			}),
		);
		expect(s.seats.partnerOf("p1")).toBe("akarin");
	});

	it("メンションが無くても、Akarin の bot の発言への返信なら Akarin が受ける", async () => {
		const s = await setup({ akarin: true });
		s.d.messages.set("a1", {
			id: "a1",
			authorId: AKARIN_BOT,
			authorName: "あかりん",
			isBot: true,
			content: "終わりました",
		});
		await s.intake.handle(
			envelope({ mentions: [], reply_to_message_id: "a1" }),
		);
		expect(s.seats.partnerOf("thread1")).toBe("akarin");
	});

	it("同じ名前でも席の bot でない人の発言への返信では席を作らない", async () => {
		const s = await setup({ akarin: true });
		s.d.messages.set("a1", {
			id: "a1",
			authorId: "someone",
			authorName: "あかりん",
			isBot: false,
			content: "こんにちは",
		});
		await s.intake.handle(
			envelope({ mentions: [], reply_to_message_id: "a1" }),
		);
		expect(s.o.opsOf("startSeat")).toEqual([]);
	});

	it("Yukarin と Akarin の両方へのメンションなら Akarin が受ける", async () => {
		const s = await setup({ akarin: true });
		await s.intake.handle(
			envelope({ mentions: [BOT], mention_roles: [AKARIN_ROLE] }),
		);
		expect(s.seats.partnerOf("thread1")).toBe("akarin");
	});

	it("Akarin の席が無ければ、Akarin へのメンションだけの依頼では席を作らない", async () => {
		const s = await setup();
		await s.intake.handle(
			envelope({ mentions: [], mention_roles: [AKARIN_ROLE] }),
		);
		expect(s.o.opsOf("startSeat")).toEqual([]);
	});

	it("Akarin 宛ての投稿は、返事も完了の報告も Akarin の話し手で書き、完了のあとも Akarin の Codex の席で続ける", async () => {
		const s = await setup({ akarin: true });
		s.d.addThread("p1", "README の誤字");
		await s.intake.handle(
			envelope({
				channel_id: "p1",
				message_id: "p1",
				content: "README の誤字を直して",
				mentions: [],
				mention_roles: [AKARIN_ROLE],
			}),
		);
		const seat = s.seats.get("p1");
		if (!seat?.dispatchId) throw new Error("seat not started");
		await s.intake.onSeatMessage(
			seatMessage({
				type: "worker_done",
				dispatchId: seat.dispatchId,
				body: "直しました\n状態: 完了",
			}),
		);
		expect(s.rememberedBy).toEqual(["akarin"]);
		await expireLinger(s);
		expect(s.seats.get("p1")).toBeNull();

		await s.intake.handle(say("p1", "もう一か所お願い"));
		const starts = s.o.opsOf("startSeat") as { spec: string; agent: string }[];
		expect(starts.map((x) => x.agent)).toEqual(["codex", "codex"]);
		expect(starts[1]?.spec.startsWith(AKARIN_PREAMBLE)).toBe(true);
		expect(s.writes.yukarin).toEqual([]);
		expect(s.writes.akarin).toContain("send p1");
	});

	it("止めた Akarin の席は Codex で前の会話のまま起こす", async () => {
		const s = await setup({ akarin: true });
		s.d.addThread("p1", "README の誤字");
		await s.intake.handle(
			envelope({
				channel_id: "p1",
				message_id: "p1",
				content: "README の誤字を直して",
				mentions: [],
				mention_roles: [AKARIN_ROLE],
			}),
		);
		const seat = s.seats.get("p1");
		if (!seat?.dispatchId) throw new Error("seat not started");
		await s.intake.onSeatMessage(
			seatMessage({
				type: "worker_done",
				dispatchId: seat.dispatchId,
				body: "どちらにしますか\n状態: 決めてほしい",
			}),
		);
		s.advance(3 * 60 * 60_000);
		await s.intake.sleepIdle();
		expect(s.seats.get("p1")?.status).toBe("sleeping");
		await s.intake.handle(say("p1", "A で"));
		const [resume] = s.o.opsOf("resumeSeat") as { agent: string }[];
		expect(resume?.agent).toBe("codex");
	});

	it("担当を volume の対応表に残し、受付を作り直しても同じ担当が受ける", async () => {
		const stateDir = tempDir();
		const first = await openSeatStore(stateDir);
		await first.assign("p1", "akarin");
		const again = await openSeatStore(stateDir);
		expect(again.partnerOf("p1")).toBe("akarin");
		expect(again.partnerOf("p2")).toBeNull();
	});
});

describe("不要のボタン", () => {
	/** 席に質問させ、不要のボタンが付いたメッセージの ID を返す。 */
	const ask = async (s: Awaited<ReturnType<typeof setup>>) => {
		const seat = await openPost(s);
		await s.intake.onSeatMessage(
			seatMessage({
				type: "question",
				dispatchId: seat.dispatchId,
				body: "定期の確認です。対応しますか？",
			}),
		);
		expect(s.d.sent.every((m) => m.buttons === undefined)).toBe(true);
		const at = s.sys.sent.findIndex((m) => m.buttons !== undefined);
		expect(s.sys.sent[at]?.buttons).toEqual(["thread:dismiss"]);
		return `sent${at + 1}`;
	};

	it("持ち主が押すと席の Claude を通さずに席を閉じ、タグを完了にしてボタンを外す", async () => {
		const s = await setup();
		const asked = await ask(s);
		const path = s.seats.get("p1")?.path;
		await s.intake.press(press("p1", asked, "thread:dismiss"));
		expect(s.seats.get("p1")).toBeNull();
		expect(s.o.opsOf("removeWorktree")).toEqual([path]);
		expect(s.o.opsOf("reply")).toEqual([]);
		expect(s.d.tagsOf("p1")).toEqual(["tag-done"]);
		expect(s.sys.edited.get(asked)?.content).toBe(
			`${DISMISS_ASK}\n\n不要として閉じました。`,
		);
		expect(s.activity.map((a) => a.kind)).toEqual(["done"]);
	});

	it("持ち主以外が押しても何も起きない", async () => {
		const s = await setup();
		const asked = await ask(s);
		await s.intake.press(press("p1", asked, "thread:dismiss", "someone"));
		expect(s.seats.get("p1")).not.toBeNull();
		expect(s.sys.edited.has(asked)).toBe(false);
	});

	it("席の無い投稿では、タグを完了にしてボタンを外すだけ", async () => {
		const s = await setup();
		s.d.addThread("p2", "朝会で決めてほしいこと");
		await s.intake.press(press("p2", "p2", "thread:dismiss"));
		expect(s.d.tagsOf("p2")).toEqual(["tag-done"]);
		expect(s.o.opsOf("stopSeat")).toEqual([]);
		expect(s.activity).toEqual([]);
	});

	it("完了の報告には付けない", async () => {
		const s = await setup();
		const seat = await openPost(s);
		await s.intake.onSeatMessage(
			seatMessage({
				type: "worker_done",
				dispatchId: seat.dispatchId,
				body: "直しました\n状態: 完了",
				outcome: "succeeded",
			}),
		);
		expect(s.d.sent.some((m) => m.buttons !== undefined)).toBe(false);
	});
});

describe("/ai コマンド", () => {
	const request = (
		agent: "claude" | "codex",
		model: string,
		content = "請求書を整理して\n先月分も",
	) => aiCommand({ type: "request", agent, model, content });
	const change = (threadId: string, agent: "claude" | "codex", model: string) =>
		aiCommand({ type: "model", agent, model, channelId: threadId });
	const replyOf = (
		s: Awaited<ReturnType<typeof setup>>,
		e: ReturnType<typeof aiCommand>,
	) => s.sys.interactionReplies.get(e.payload.token);

	/** 席を決めてほしい（手を止めた）ところまで進める。 */
	const pause = async (
		s: Awaited<ReturnType<typeof setup>>,
		dispatchId: string | null,
	) => {
		await s.intake.onSeatMessage(
			seatMessage({
				type: "worker_done",
				dispatchId,
				body: "A と B のどちらにしますか\n状態: 決めてほしい",
			}),
		);
	};

	it("投稿の外の依頼は、要約した件名と状態・モデルのタグで投稿を立て、そのモデルで席を開いて本人への返事にリンクを書く", async () => {
		const s = await setup();
		const e = request("claude", "sonnet");
		await s.intake.command(e);
		expect(s.d.posts).toEqual([
			{
				name: "請求書の整理",
				content: `<@${OWNER}> さんからの依頼\n\n> 請求書を整理して\n> 先月分も`,
				tagIds: ["tag-working", "tag-sonnet"],
				notify: [OWNER],
			},
		]);
		expect(replyOf(s, e)).toBe(
			"フォーラムに立てました → https://discord.com/channels/g/thread1",
		);
		expect(s.seats.partnerOf("thread1")).toBe("yukarin");
		const [start] = s.o.opsOf("startSeat") as {
			agent: string;
			model: string | null;
			spec: string;
		}[];
		expect(start).toMatchObject({ agent: "claude", model: "sonnet" });
		expect(start?.spec).toContain("ちゃぬ さんから依頼があり");
		expect(start?.spec).not.toContain("元のメッセージ");
		// チャンネルにはメッセージも受付の絵文字も残さない
		expect(s.d.sentTo(TEXT)).toEqual([]);
		expect(s.writes.yukarin.some((w) => w.startsWith("addReaction"))).toBe(
			false,
		);
	});

	it("選んだモデルは、止めた席を起こすときにも渡す", async () => {
		const s = await setup();
		await s.intake.command(request("claude", "opus"));
		const seat = s.seats.get("thread1");
		await pause(s, seat?.dispatchId ?? null);
		s.advance(3 * 60 * 60_000);
		await s.intake.sleepIdle();
		await s.intake.handle(say("thread1", "A で"));
		const [resume] = s.o.opsOf("resumeSeat") as { model: string | null }[];
		expect(resume?.model).toBe("opus");
	});

	it("メンションで立てた投稿の席は、モデルを渡さない", async () => {
		const s = await setup();
		await s.intake.handle(envelope({}));
		const [start] = s.o.opsOf("startSeat") as { model: string | null }[];
		expect(start?.model).toBeNull();
	});

	it("Codex の依頼は Akarin が受け、Codex の席をそのモデルで開く", async () => {
		const s = await setup({ akarin: true });
		await s.intake.command(request("codex", "terra"));
		expect(s.seats.partnerOf("thread1")).toBe("akarin");
		const [start] = s.o.opsOf("startSeat") as {
			agent: string;
			model: string;
		}[];
		expect(start).toMatchObject({ agent: "codex", model: "terra" });
		expect(s.d.posts[0]?.tagIds).toEqual(["tag-working", "tag-terra"]);
	});

	it("Akarin の席が無ければ、Codex の依頼は投稿を立てずに断る", async () => {
		const s = await setup();
		const e = request("codex", "terra");
		await s.intake.command(e);
		expect(s.d.posts).toEqual([]);
		expect(replyOf(s, e)).toBe("あかりちゃんの席はいま開いていません。");
	});

	it("持ち主以外のコマンドは断り、何もしない", async () => {
		const s = await setup();
		const e = aiCommand({
			type: "request",
			agent: "claude",
			model: "opus",
			content: "依頼",
			userId: "stranger",
		});
		await s.intake.command(e);
		expect(s.d.posts).toEqual([]);
		expect(replyOf(s, e)).toBe("このコマンドは持ち主だけが使えます。");
	});

	it("仕事フォーラムの外のスレッドでは、モデルを変えずに断る", async () => {
		const s = await setup();
		s.d.channels.set("elsewhere", {
			id: "elsewhere",
			name: "雑談",
			parentId: TEXT,
			appliedTagIds: [],
			availableTags: [],
		});
		const e = change("elsewhere", "claude", "opus");
		await s.intake.command(e);
		expect(s.seats.modelOf("elsewhere")).toBeNull();
		expect(replyOf(s, e)).toContain("仕事フォーラムの投稿の中で");
	});

	it("担当と違う相手のコマンドは、本人にだけ見える返事で断る", async () => {
		const s = await setup({ akarin: true });
		await openPost(s);
		const e = change("p1", "codex", "sol");
		await s.intake.command(e);
		expect(replyOf(s, e)).toBe(
			"この投稿はゆかりさんが担当しています。モデルは `/ai claude …` で変えられます。",
		);
		expect(s.seats.modelOf("p1")).toBeNull();
		expect(s.o.opsOf("switchModel")).toEqual([]);
	});

	it("手を止めた Claude の席は、端末に /model を送ってすぐ切り替え、投稿に残してモデルのタグを差し替える", async () => {
		const s = await setup();
		const seat = await openPost(s);
		await pause(s, seat.dispatchId);
		const e = change("p1", "claude", "haiku");
		await s.intake.command(e);
		expect(s.o.opsOf("switchModel")).toEqual([
			{ terminal: seat.terminal, model: "haiku" },
		]);
		expect(replyOf(s, e)).toBe("Haiku に切り替えました。");
		expect(s.sys.sentTo("p1").at(-1)).toBe(
			"ちゃぬ がモデルを 既定のモデル → Haiku に変えました",
		);
		expect(s.seats.get("p1")?.model).toBe("haiku");
		// モデルのタグを足しても状態のタグは残る
		expect(s.d.tagsOf("p1")).toEqual(["tag-decide", "tag-haiku"]);

		const again = change("p1", "claude", "opus");
		await s.intake.command(again);
		expect(s.sys.sentTo("p1").at(-1)).toBe(
			"ちゃぬ がモデルを Haiku → Opus に変えました",
		);
		expect(s.d.tagsOf("p1")).toEqual(["tag-decide", "tag-opus"]);

		// 状態のタグを差し替えてもモデルのタグは残る
		await s.intake.handle(say("p1", "A で"));
		expect(s.d.tagsOf("p1")).toEqual(["tag-opus", "tag-working"]);
	});

	it("作業中の席は手が止まるまで待ち、止まったら切り替える", async () => {
		const s = await setup();
		const seat = await openPost(s);
		const e = change("p1", "claude", "sonnet");
		await s.intake.command(e);
		expect(replyOf(s, e)).toBe("今の手が止まったら Sonnet に切り替えます。");
		expect(s.o.opsOf("switchModel")).toEqual([]);
		expect(s.sys.sentTo("p1")).not.toContain(
			"ちゃぬ がモデルを 既定のモデル → Sonnet に変えました",
		);

		await s.intake.onSeatMessage(
			seatMessage({
				type: "question",
				dispatchId: seat.dispatchId,
				body: "どちらにしますか",
			}),
		);
		expect(s.o.opsOf("switchModel")).toEqual([
			{ terminal: seat.terminal, model: "sonnet" },
		]);
		expect(s.sys.sentTo("p1").at(-1)).toBe(
			"ちゃぬ がモデルを 既定のモデル → Sonnet に変えました",
		);
		expect(s.seats.get("p1")).toMatchObject({
			status: "asking",
			model: "sonnet",
			modelChange: null,
		});
	});

	it("作業中に元のモデルを選び直したら、切り替えを取りやめる", async () => {
		const s = await setup();
		await s.intake.command(request("claude", "opus"));
		const seat = s.seats.get("thread1");
		await s.intake.command(change("thread1", "claude", "sonnet"));
		const back = change("thread1", "claude", "opus");
		await s.intake.command(back);
		expect(replyOf(s, back)).toBe("すでに Opus で動いています。");
		await pause(s, seat?.dispatchId ?? null);
		expect(s.o.opsOf("switchModel")).toEqual([]);
		expect(s.seats.get("thread1")?.model).toBe("opus");
	});

	it("手を止めた Codex の席は止め、次の返事で選んだモデルのまま起こし直す", async () => {
		const s = await setup({ akarin: true });
		await s.intake.command(request("codex", "terra"));
		const seat = s.seats.get("thread1");
		await pause(s, seat?.dispatchId ?? null);
		const e = change("thread1", "codex", "luna");
		await s.intake.command(e);
		expect(replyOf(s, e)).toBe("Luna に切り替えました。");
		expect(s.o.opsOf("switchModel")).toEqual([]);
		expect(s.o.opsOf("stopSeat")).toHaveLength(1);
		expect(s.seats.get("thread1")).toMatchObject({
			status: "sleeping",
			model: "luna",
		});
		expect(s.sys.sentTo("thread1").at(-1)).toBe(
			"ちゃぬ がモデルを Terra → Luna に変えました",
		);
		expect(s.d.tagsOf("thread1")).toEqual(["tag-decide", "tag-luna"]);

		await s.intake.handle(say("thread1", "A で"));
		const [resume] = s.o.opsOf("resumeSeat") as {
			agent: string;
			model: string;
		}[];
		expect(resume).toMatchObject({ agent: "codex", model: "luna" });
	});

	it("席の無い投稿は、選んだモデルを残して次に開く席をそのモデルで動かす", async () => {
		const s = await setup();
		const seat = await openPost(s);
		await s.intake.onSeatMessage(
			seatMessage({
				type: "worker_done",
				dispatchId: seat.dispatchId,
				body: "直しました\n状態: 完了",
			}),
		);
		await expireLinger(s);
		const e = change("p1", "claude", "opus");
		await s.intake.command(e);
		expect(replyOf(s, e)).toBe("Opus に切り替えました。");
		expect(s.sys.sentTo("p1").at(-1)).toBe(
			"ちゃぬ がモデルを 既定のモデル → Opus に変えました",
		);
		await s.intake.handle(say("p1", "もう一つ直して"));
		const starts = s.o.opsOf("startSeat") as { model: string | null }[];
		expect(starts.at(-1)?.model).toBe("opus");
	});
});

describe("GitHub の issue", () => {
	const ISSUE = {
		repo: "example/repo",
		number: 7,
		title: "設定の読み込みが落ちる",
		url: "https://github.com/example/repo/issues/7",
		body: "起動すると落ちる",
	};

	it("issue から作業中の投稿を立て、指定した席で作業を始める", async () => {
		const s = await setup({ akarin: true });
		const r = await s.intake.startFromIssue(ISSUE, "akarin");
		expect(r).toEqual({ ok: true, value: { threadId: "thread1" } });
		expect(s.d.posts[0]).toMatchObject({
			name: "repo#7 設定の読み込みが落ちる",
			tagIds: ["tag-working"],
		});
		expect(s.d.posts[0]?.content).toContain(ISSUE.url);
		expect(s.seats.partnerOf("thread1")).toBe("akarin");
		const [start] = s.o.opsOf("startSeat") as { spec: string; agent: string }[];
		expect(start?.agent).toBe("codex");
		expect(start?.spec).toContain("Closes example/repo#7");
		expect(start?.spec).toContain("起動すると落ちる");
		expect(s.writes.yukarin).toEqual([]);
	});

	it("席が上限なら、投稿を立てて順番待ちにする", async () => {
		const s = await setup({ seatLimit: 0 });
		const r = await s.intake.startFromIssue(ISSUE, "yukarin");
		expect(r.ok).toBe(true);
		expect(s.seats.get("thread1")?.status).toBe("queued");
		expect(s.o.opsOf("startSeat")).toEqual([]);
	});
});

describe("hishaku の番号", () => {
	const done = (dispatchId: string | null, body: string) =>
		seatMessage({ type: "worker_done", dispatchId, body });
	const ID = "11111111-2222-4333-8444-555555555555";

	it("席を作るときに番号を取って投稿ごとに残し、件名の頭に付け、その番号の ID で起こす", async () => {
		const h = fakeHishaku();
		const s = await setup({ hishaku: h });
		await openPost(s);
		expect(h.opsOf("createSession")).toEqual([
			{
				postId: "p1",
				agent: "claude",
				title: "README の誤字",
				repo: null,
				branch: null,
			},
		]);
		expect(s.seats.numberOf("p1")).toBe(1234);
		expect(s.d.channels.get("p1")?.name).toBe("[1234] README の誤字");
		expect(h.opsOf("prepare")).toEqual([
			{ number: 1234, cwd: "/seats/seat-p1" },
		]);
		const [start] = s.o.opsOf("startSeat") as {
			how: unknown;
			spec: string;
			title: string;
		}[];
		expect(start?.how).toEqual({ sessionId: ID, resume: false });
		expect(start?.spec).toContain("この投稿の hishaku の番号: 1234");
		// 席の端末の題には番号を付けない
		expect(start?.title).toBe("README の誤字");
		expect(s.seats.get("p1")?.lease).toBe(1);
		// 受付を作り直しても同じ番号を使う
		const reopened = await openSeatStore(s.stateDir);
		expect(reopened.numberOf("p1")).toBe(1234);
	});

	it("仕事チャンネルの依頼から立てた投稿は、要約の件名の頭に番号を付ける", async () => {
		const h = fakeHishaku();
		const s = await setup({ hishaku: h });
		await s.intake.handle(envelope({}));
		expect(s.d.posts[0]?.name).toBe("請求書の整理");
		expect(s.d.channels.get("thread1")?.name).toBe("[1234] 請求書の整理");
	});

	it("Manager に届かなければ番号なしで今の起動のまま始める", async () => {
		const h = fakeHishaku();
		h.behavior.create = () =>
			err({ type: "HishakuFailed", reason: "POST /v1/sessions 503" });
		const s = await setup({ hishaku: h });
		await openPost(s);
		expect(s.seats.numberOf("p1")).toBeNull();
		expect(s.d.channels.get("p1")?.name).toBe("README の誤字");
		expect(h.opsOf("prepare")).toEqual([]);
		const [start] = s.o.opsOf("startSeat") as { how: unknown; spec: string }[];
		expect(start?.how).toBe("start");
		expect(start?.spec).not.toContain("hishaku の番号");
	});

	it("hs prepare が失敗したら warn を残して今の起動に戻す", async () => {
		const h = fakeHishaku();
		h.behavior.prepare = () =>
			err({ type: "HishakuFailed", reason: "hs: Manager に届きません" });
		const s = await setup({ hishaku: h });
		await openPost(s);
		const [start] = s.o.opsOf("startSeat") as { how: unknown }[];
		expect(start?.how).toBe("start");
		expect(s.seats.get("p1")?.lease).toBeNull();
		expect(s.seats.get("p1")?.status).toBe("working");
	});

	it("他の機械が借りていれば席を起こさず、書き込みを溜めて取り戻すボタンを出す", async () => {
		const h = fakeHishaku();
		h.behavior.prepare = () =>
			err({
				type: "LeaseHeld",
				holder: "mac-example",
				leaseExpiresAt: "2026-11-05T08:02:00.000Z",
			});
		const s = await setup({ hishaku: h });
		s.d.addThread("p1", "README の誤字");
		await s.intake.handle(say("p1", "README の誤字を直して", { first: true }));
		expect(s.o.opsOf("startSeat")).toHaveLength(1);
		const seat = s.seats.get("p1");
		expect(seat?.status).toBe("lent");
		expect(seat?.pending.join()).toContain("README の誤字を直して");
		expect(s.sys.sent.at(-1)).toMatchObject({
			content:
				"いまは Mac で作業中です（1234）。この書き込みは Mac が返したあとに席へ渡します。すぐこちらで続けるなら「取り戻す」を押してください。",
			buttons: ["lend:takeback"],
		});
		expect(s.d.tagsOf("p1")).toEqual(["tag-handoff"]);
	});

	it("持ち主が自分のままなら（前の受付が返さずに落ちた）取り直して起こす", async () => {
		const h = fakeHishaku();
		let n = 0;
		h.behavior.prepare = () =>
			n++ === 0
				? err({ type: "LeaseHeld", holder: "box01", leaseExpiresAt: "" })
				: ok({ agent: "claude", sessionId: ID, resume: true, generation: 5 });
		const s = await setup({ hishaku: h });
		await openPost(s);
		expect(h.opsOf("prepare")).toEqual([
			{ number: 1234, cwd: "/seats/seat-p1" },
			{ number: 1234, cwd: "/seats/seat-p1", takeover: true },
		]);
		expect(s.seats.get("p1")?.lease).toBe(5);
	});

	it("完了で閉じるときは会話を預けて貸し出しを返してから worktree を消す", async () => {
		const h = fakeHishaku();
		const s = await setup({ hishaku: h });
		const seat = await openPost(s);
		await s.intake.onSeatMessage(
			done(seat.dispatchId, "直しました\n状態: 完了"),
		);
		expect(h.opsOf("push")).toEqual([]);
		await expireLinger(s);
		expect(h.opsOf("push")).toEqual([
			{ number: 1234, generation: 1, cwd: "/seats/seat-p1", release: true },
		]);
		const ops = s.o.calls.map((c) => c.op);
		expect(ops.indexOf("stopSeat")).toBeLessThan(ops.indexOf("removeWorktree"));
		expect(s.seats.numberOf("p1")).toBe(1234);
	});

	it("完了のあとにまた書くと同じ番号の会話を続け、やりとりの代わりに返事だけを渡す", async () => {
		const h = fakeHishaku();
		const s = await setup({ hishaku: h });
		const seat = await openPost(s);
		await s.intake.onSeatMessage(
			done(seat.dispatchId, "直しました\n状態: 完了"),
		);
		await expireLinger(s);
		h.behavior.prepare = () =>
			ok({ agent: "claude", sessionId: ID, resume: true, generation: 2 });
		await s.intake.handle(say("p1", "もう一か所あった"));
		expect(h.opsOf("createSession")).toHaveLength(1);
		const starts = s.o.opsOf("startSeat") as { how: unknown; spec: string }[];
		expect(starts[1]?.how).toEqual({ sessionId: ID, resume: true });
		expect(starts[1]?.spec).toContain("もう一か所あった");
		expect(starts[1]?.spec).not.toContain(PREAMBLE);
		expect(starts[1]?.spec).not.toContain("--- ここまで ---");
	});

	it("完了のあとに Manager に届かなければ、これまでのやりとりを渡す", async () => {
		const h = fakeHishaku();
		const s = await setup({ hishaku: h });
		const seat = await openPost(s);
		await s.intake.onSeatMessage(
			done(seat.dispatchId, "直しました\n状態: 完了"),
		);
		await expireLinger(s);
		h.behavior.prepare = () =>
			err({ type: "HishakuFailed", reason: "hs: Manager に届きません" });
		await s.intake.handle(say("p1", "もう一か所あった"));
		const starts = s.o.opsOf("startSeat") as { how: unknown; spec: string }[];
		expect(starts[1]?.how).toBe("start");
		expect(starts[1]?.spec.startsWith(PREAMBLE)).toBe(true);
		expect(starts[1]?.spec).toContain("--- ここまで ---");
	});

	it("起動し直すときは会話を預けて返してから、同じ番号を借り直して起こす", async () => {
		const h = fakeHishaku();
		const s = await setup({ hishaku: h });
		await openPost(s);
		h.behavior.prepare = () =>
			ok({ agent: "claude", sessionId: ID, resume: true, generation: 2 });
		await s.intake.handle(say("p1", "起動し直して"));
		expect(h.calls.map((c) => c.op)).toEqual([
			"createSession",
			"prepare",
			"push",
			"prepare",
		]);
		const [resume] = s.o.opsOf("resumeSeat") as { how: unknown }[];
		expect(resume?.how).toEqual({ sessionId: ID, resume: true });
		expect(s.seats.get("p1")?.lease).toBe(2);
	});

	it("引き継ぎでは会話を預けて返したことを確かめ、返事に hs open を付ける", async () => {
		const h = fakeHishaku();
		const s = await setup({ hishaku: h });
		const seat = await openPost(s);
		await s.intake.onSeatMessage(
			done(
				seat.dispatchId,
				"わかりました。席はここで止めて、続きは Mac で開けるようにしました。\nhttps://github.com/example/app/issues/9\n状態: 引き継ぎ",
			),
		);
		expect(h.opsOf("push")).toEqual([
			{ number: 1234, generation: 1, cwd: "/seats/seat-p1", release: true },
		]);
		const reply = s.d.sentTo("p1").at(-1) ?? "";
		expect(
			reply.endsWith(
				"https://github.com/example/app/issues/9\n\n`hs open 1234`",
			),
		).toBe(true);
		expect(s.d.tagsOf("p1")).toEqual(["tag-handoff"]);
		expect(s.activity.map((e) => e.kind)).toEqual(["handoff"]);
		expect(s.seats.get("p1")?.status).toBe("lent");
		expect(s.o.opsOf("removeWorktree")).toEqual(["/seats/seat-p1"]);
	});

	it("引き継ぎでは預ける前に作業ブランチを meta に書き、書けなくても止める流れを続ける", async () => {
		const h = fakeHishaku();
		h.behavior.update = () =>
			err({ type: "HishakuFailed", reason: "PATCH /v1/sessions/1234 503" });
		const dirs: string[] = [];
		const s = await setup({
			hishaku: h,
			findWorkBranches: async (dir) => {
				dirs.push(dir);
				return [{ repo: "example/app", branch: "dev/fix" }];
			},
		});
		const seat = await openPost(s);
		await s.intake.onSeatMessage(
			done(seat.dispatchId, "Mac に引き継ぎます\n状態: 引き継ぎ"),
		);
		expect(dirs).toEqual(["/seats/seat-p1"]);
		const ops = h.calls.map((c) => c.op);
		expect(ops.slice(ops.indexOf("update"))).toEqual(["update", "push"]);
		expect(h.opsOf("update")).toEqual([
			{ number: 1234, repo: "example/app", branch: "dev/fix" },
		]);
		expect(s.d.sentTo("p1").at(-1)).toContain("`hs open 1234`");
		expect(s.seats.get("p1")?.status).toBe("lent");
	});

	it("引き継ぎで会話を預けられなければ hs open を付けず、そう書き添える", async () => {
		const h = fakeHishaku();
		h.behavior.push = () =>
			err({ type: "HishakuFailed", reason: "hs: Manager に届きません" });
		const s = await setup({ hishaku: h });
		const seat = await openPost(s);
		await s.intake.onSeatMessage(
			done(seat.dispatchId, "Mac に引き継ぎます\n状態: 引き継ぎ"),
		);
		const reply = s.d.sentTo("p1").at(-1) ?? "";
		expect(reply).not.toContain("hs open");
		expect(reply).toContain("申し送り issue から始めます");
	});

	it("寝かせる席は会話を預けて返し、起こすときに借り直す", async () => {
		const h = fakeHishaku();
		const s = await setup({ hishaku: h });
		const seat = await openPost(s);
		await s.intake.onSeatMessage(
			done(seat.dispatchId, "どちらにしますか\n状態: 決めてほしい"),
		);
		s.advance(3 * 60 * 60_000);
		await s.intake.sleepIdle();
		expect(s.seats.get("p1")?.status).toBe("sleeping");
		expect(s.seats.get("p1")?.lease).toBeNull();
		expect(h.opsOf("push")).toHaveLength(1);
		await s.intake.handle(say("p1", "A で"));
		expect(h.opsOf("prepare")).toHaveLength(2);
		expect(s.seats.get("p1")?.status).toBe("working");
	});

	it("貸し出しを延ばし、取られていたら投稿に一言書いて以後は預けない", async () => {
		const h = fakeHishaku();
		const s = await setup({ hishaku: h });
		await openPost(s);
		await s.intake.renewLeases();
		expect(h.opsOf("renew")).toEqual([{ number: 1234, generation: 1 }]);
		h.behavior.renew = () => err({ type: "LeaseStolen" });
		await s.intake.renewLeases();
		expect(s.seats.get("p1")?.lease).toBeNull();
		expect(s.d.sentTo("p1").at(-1)).toContain("別の機械で開かれました");
		await s.intake.renewLeases();
		expect(h.opsOf("renew")).toHaveLength(2);
	});

	it("朝会の席は番号を取らない", async () => {
		const h = fakeHishaku();
		const s = await setup({ hishaku: h });
		await s.intake.startStandup("朝会の材料");
		expect(h.calls).toEqual([]);
	});
});

describe("Mac への貸し出しと取り戻し", () => {
	const done = (dispatchId: string | null, body: string) =>
		seatMessage({ type: "worker_done", dispatchId, body });
	const ID = "11111111-2222-4333-8444-555555555555";
	const MAC = "mac-example";
	const macHolds = (
		h: ReturnType<typeof fakeHishaku>,
		generation: number,
		pushedAt: string | null = null,
	) => {
		h.behavior.meta = () =>
			ok({
				holder: MAC,
				generation,
				leaseExpiresAt: new Date("2026-11-05T09:00:00Z"),
				pushedAt: pushedAt === null ? null : new Date(pushedAt),
				repo: null,
				branch: null,
			});
	};
	const macReturned = (
		h: ReturnType<typeof fakeHishaku>,
		generation: number,
	) => {
		h.behavior.meta = () =>
			ok({
				holder: null,
				generation,
				leaseExpiresAt: null,
				pushedAt: null,
				repo: null,
				branch: null,
			});
	};
	const asked = (h: ReturnType<typeof fakeHishaku>) => {
		h.behavior.renew = () => ok({ releaseRequestedBy: MAC });
	};
	/** Mac に頼まれ、手が止まっている席を渡したところまで進める。 */
	const lend = async () => {
		const h = fakeHishaku();
		const s = await setup({ hishaku: h });
		const seat = await openPost(s);
		await s.intake.onSeatMessage(
			done(seat.dispatchId, "どちらにしますか\n状態: 決めてほしい"),
		);
		asked(h);
		await s.intake.renewLeases();
		return { h, s };
	};

	it("頼まれても作業中なら渡さず、ターンの終わりを待って預けて返し、席を閉じて貸し出し中にする", async () => {
		const h = fakeHishaku();
		const s = await setup({ hishaku: h });
		const seat = await openPost(s);
		asked(h);
		await s.intake.renewLeases();
		expect(h.opsOf("push")).toEqual([]);
		expect(s.seats.get("p1")?.status).toBe("working");
		expect(s.seats.get("p1")?.releaseRequested).toBe(MAC);
		await s.intake.onSeatMessage(
			done(seat.dispatchId, "ここまで直しました\n状態: 決めてほしい"),
		);
		expect(h.opsOf("push")).toEqual([
			{ number: 1234, generation: 1, cwd: "/seats/seat-p1", release: true },
		]);
		const ops = s.o.calls.map((c) => c.op);
		expect(ops.indexOf("stopSeat")).toBeLessThan(ops.indexOf("removeWorktree"));
		expect(s.seats.get("p1")?.status).toBe("lent");
		expect(s.sys.sent.at(-1)).toMatchObject({
			content: "Mac に貸し出しました（1234）。席は止めています。",
			buttons: ["lend:takeback"],
		});
		expect(s.d.tagsOf("p1")).toEqual(["tag-handoff"]);
	});

	it("手が止まっている席は頼まれたらすぐ渡す。自分の Commander の頼みは渡さない", async () => {
		const h = fakeHishaku();
		const s = await setup({ hishaku: h });
		const seat = await openPost(s);
		await s.intake.onSeatMessage(
			done(seat.dispatchId, "どちらにしますか\n状態: 決めてほしい"),
		);
		h.behavior.renew = () => ok({ releaseRequestedBy: "box01" });
		await s.intake.renewLeases();
		expect(s.seats.get("p1")?.status).toBe("waiting");
		asked(h);
		await s.intake.renewLeases();
		expect(h.opsOf("push")).toHaveLength(1);
		expect(s.seats.get("p1")?.status).toBe("lent");
	});

	it("貸し出し中は meta を見て、Mac が借りたら再開を、返したら戻ったことを 1 度ずつ書いて状態を戻す", async () => {
		const { h, s } = await lend();
		await s.intake.watchLends();
		expect(s.sys.sentTo("p1").filter((t) => t.startsWith("Mac で"))).toEqual(
			[],
		);
		macHolds(h, 2);
		s.advance(5 * 60_000);
		await s.intake.watchLends();
		await s.intake.watchLends();
		expect(s.sys.sentTo("p1").filter((t) => t.startsWith("Mac で"))).toEqual([
			"Mac で再開しました（17:05）。",
		]);
		macReturned(h, 2);
		await s.intake.watchLends();
		await s.intake.watchLends();
		expect(
			s.sys.sentTo("p1").filter((t) => t.startsWith("Mac から戻りました")),
		).toEqual([
			"Mac から戻りました。この投稿に書けば、席が前の会話のまま続けます。",
		]);
		expect(s.seats.get("p1")).toBeNull();
		expect(s.d.tagsOf("p1")).toEqual(["tag-decide"]);
		h.behavior.prepare = () =>
			ok({ agent: "claude", sessionId: ID, resume: true, generation: 3 });
		await s.intake.handle(say("p1", "続きをお願い"));
		const starts = s.o.opsOf("startSeat") as { how: unknown; spec: string }[];
		expect(starts[1]?.how).toEqual({ sessionId: ID, resume: true });
		expect(starts[1]?.spec).toContain("続きをお願い");
	});

	it("引き継ぎの貸し出し待ちは、見回りの合間に Mac が借りて返しても世代が進んでいれば戻ったと分かる", async () => {
		const h = fakeHishaku();
		const s = await setup({ hishaku: h });
		const seat = await openPost(s);
		await s.intake.onSeatMessage(
			done(seat.dispatchId, "Mac に引き継ぎます\n状態: 引き継ぎ"),
		);
		macReturned(h, 1);
		await s.intake.watchLends();
		expect(s.seats.get("p1")?.status).toBe("lent");
		macReturned(h, 2);
		await s.intake.watchLends();
		expect(s.seats.get("p1")).toBeNull();
		expect(s.sys.sentTo("p1").at(-1)).toBe(
			"Mac から戻りました。この投稿に書けば、席が前の会話のまま続けます。",
		);
	});

	it("貸し出し中に書かれたら席に渡さずに溜め、Mac が返したら溜めた分を渡して席を起こす", async () => {
		const { h, s } = await lend();
		macHolds(h, 2);
		await s.intake.watchLends();
		await s.intake.handle(say("p1", "B でお願い"));
		expect(s.o.opsOf("startSeat")).toHaveLength(1);
		expect(s.o.opsOf("send")).toEqual([]);
		expect(s.sys.sent.at(-1)).toMatchObject({
			content:
				"いまは Mac で作業中です（1234）。この書き込みは Mac が返したあとに席へ渡します。すぐこちらで続けるなら「取り戻す」を押してください。",
			buttons: ["lend:takeback"],
		});
		macReturned(h, 2);
		h.behavior.prepare = () =>
			ok({ agent: "claude", sessionId: ID, resume: true, generation: 3 });
		await s.intake.watchLends();
		const starts = s.o.opsOf("startSeat") as { how: unknown; spec: string }[];
		expect(starts).toHaveLength(2);
		expect(starts[1]?.how).toEqual({ sessionId: ID, resume: true });
		expect(starts[1]?.spec).toContain(
			"Mac に貸している間に持ち主が投稿に書いたこと",
		);
		expect(starts[1]?.spec).toContain("B でお願い");
		expect(s.sys.sentTo("p1")).toContain(
			"Mac から戻りました。貸し出し中の書き込みを席に渡して、前の会話のまま続けます。",
		);
		expect(s.seats.get("p1")?.status).toBe("working");
		expect(s.seats.get("p1")?.lend).toBeNull();
	});

	it("取り戻すは確かめてから貸し出しを奪い、席を前の会話のまま起こして両方の bot で知らせる", async () => {
		const { h, s } = await lend();
		macHolds(h, 2, "2026-11-05T07:40:00.000Z");
		await s.intake.watchLends();
		await s.intake.press(press("p1", "x", "lend:takeback"));
		expect(s.sys.sent.at(-1)).toMatchObject({
			content:
				"Mac はまだ 1234 を持っています（最後に預けたのは 16:40）。取り戻すと、Mac でそのあとに進んだ分は正本に入らず、枝として残ります。",
			buttons: ["lend:confirm", "lend:cancel"],
		});
		expect(h.opsOf("prepare")).toHaveLength(1);
		const confirm = `sent${s.sys.sent.length}`;
		h.behavior.prepare = () =>
			ok({ agent: "claude", sessionId: ID, resume: true, generation: 3 });
		await s.intake.press(press("p1", confirm, "lend:confirm"));
		expect(h.opsOf("prepare").at(-1)).toEqual({
			number: 1234,
			cwd: "/seats/seat-p1",
			takeover: true,
		});
		const starts = s.o.opsOf("startSeat") as { how: unknown; spec: string }[];
		expect(starts[1]?.how).toEqual({ sessionId: ID, resume: true });
		expect(starts[1]?.spec).toContain("Mac からこの投稿の会話を取り戻した");
		expect(s.sys.sentTo("p1")).toContain(
			"取り戻しました（世代 3）。席を前の会話のまま起こします。",
		);
		expect(s.d.sentTo("p1").at(-1)).toBe(
			"戻りました。Mac で 16:40 までに進めたところから続けますね。",
		);
		expect(s.seats.get("p1")?.status).toBe("working");
		expect(s.seats.get("p1")?.lease).toBe(3);
		expect(s.seats.get("p1")?.takeback).toBeNull();
		expect(s.sys.edited.get(confirm)?.content).toContain("取り戻すと");
		// 二度押しても何も起きない
		await s.intake.press(press("p1", confirm, "lend:confirm"));
		expect(h.opsOf("prepare")).toHaveLength(2);
	});

	it("Mac が置いた時刻を Manager が知らせなければ、受付が最後に預けた時刻を見せる", async () => {
		const { h, s } = await lend();
		macHolds(h, 2);
		await s.intake.press(press("p1", "x", "lend:takeback"));
		expect(s.sys.sent.at(-1)?.content).toContain("最後に預けたのは 17:00");
	});

	it("やめるなら何もせずボタンを外す。持ち主以外の押下は無視する", async () => {
		const { h, s } = await lend();
		macHolds(h, 2);
		await s.intake.press(press("p1", "x", "lend:takeback", "someone"));
		expect(s.sys.sentTo("p1").some((t) => t.startsWith("Mac はまだ"))).toBe(
			false,
		);
		await s.intake.press(press("p1", "x", "lend:takeback"));
		const confirm = `sent${s.sys.sent.length}`;
		await s.intake.press(press("p1", confirm, "lend:confirm", "someone"));
		await s.intake.press(press("p1", confirm, "lend:cancel"));
		expect(s.sys.edited.get(confirm)?.content).toContain(
			"取り戻すのをやめました。",
		);
		expect(h.opsOf("prepare")).toHaveLength(1);
		expect(s.seats.get("p1")?.status).toBe("lent");
	});

	it("取り戻すを押したときに Mac がもう返していれば、奪わずに戻す", async () => {
		const { h, s } = await lend();
		macReturned(h, 2);
		await s.intake.press(press("p1", "x", "lend:takeback"));
		expect(s.sys.sentTo("p1").at(-1)).toBe(
			"Mac から戻りました。この投稿に書けば、席が前の会話のまま続けます。",
		);
		expect(s.seats.get("p1")).toBeNull();
	});

	it("貸し出し中の席は受付を作り直しても貸し出し中のまま読み直す", async () => {
		const { s } = await lend();
		const reopened = await openSeatStore(s.stateDir);
		expect(reopened.get("p1")?.status).toBe("lent");
		expect(reopened.get("p1")?.lend).toEqual({
			number: 1234,
			savedAt: T0,
			generation: 1,
			mac: false,
			requested: true,
			buttons: [`sent${s.sys.sent.length}`],
			confirms: [],
		});
	});

	/** 貸し出しで出したメッセージのうち、ボタンを外した（本文はそのままで書き換えた）もの。 */
	const cleared = (s: Awaited<ReturnType<typeof setup>>) =>
		s.sys.sent
			.map((m, i) => ({ id: `sent${i + 1}`, content: m.content }))
			.filter((m) => s.sys.edited.get(m.id)?.content === m.content)
			.map((m) => m.id);
	const lastSent = (s: Awaited<ReturnType<typeof setup>>) =>
		`sent${s.sys.sent.length}`;

	it("Mac から戻ったら、受付を作り直したあとでも、貸し出しで出した取り戻すのボタンをすべて外す", async () => {
		const { h, s } = await lend();
		const lent = lastSent(s);
		macHolds(h, 2);
		await s.intake.watchLends();
		await s.intake.handle(say("p1", "B でお願い"));
		const held = lastSent(s);
		const r = await setup({
			hishaku: h,
			stateDir: s.stateDir,
			d: s.d,
			sys: s.sys,
			orca: s.o,
		});
		macReturned(h, 2);
		await r.intake.watchLends();
		expect(r.seats.get("p1")?.status).toBe("working");
		expect(cleared(s)).toEqual([lent, held]);
		expect(s.sys.edited.get(lent)?.content).toBe(
			"Mac に貸し出しました（1234）。席は止めています。",
		);
	});

	it("取り戻すを確定したら、取り戻すと確認のボタンをすべて外す", async () => {
		const { h, s } = await lend();
		const lent = lastSent(s);
		macHolds(h, 2);
		await s.intake.watchLends();
		await s.intake.press(press("p1", lent, "lend:takeback"));
		const first = lastSent(s);
		await s.intake.press(press("p1", lent, "lend:takeback"));
		const second = lastSent(s);
		h.behavior.prepare = () =>
			ok({ agent: "claude", sessionId: ID, resume: true, generation: 3 });
		await s.intake.press(press("p1", second, "lend:confirm"));
		expect(s.seats.get("p1")?.status).toBe("working");
		expect(cleared(s)).toEqual([lent, first, second]);
	});

	it("やめたら確認のボタンをすべて外し、貸し出しは続くので取り戻すのボタンは残す", async () => {
		const { h, s } = await lend();
		const lent = lastSent(s);
		macHolds(h, 2);
		await s.intake.press(press("p1", lent, "lend:takeback"));
		const first = lastSent(s);
		await s.intake.press(press("p1", lent, "lend:takeback"));
		const second = lastSent(s);
		await s.intake.press(press("p1", second, "lend:cancel"));
		expect(cleared(s)).toEqual([first]);
		expect(s.sys.edited.get(second)?.content).toContain(
			"取り戻すのをやめました。",
		);
		expect(s.sys.edited.has(lent)).toBe(false);
		expect(s.seats.get("p1")?.lend?.confirms).toEqual([]);
		expect(s.seats.get("p1")?.lend?.buttons).toEqual([lent]);
	});

	it("貸し出し中の投稿を閉じたら、取り戻すのボタンを外す", async () => {
		const { s } = await lend();
		const lent = lastSent(s);
		await s.intake.press(press("p1", "x", "thread:dismiss"));
		expect(s.seats.get("p1")).toBeNull();
		expect(cleared(s)).toEqual([lent]);
	});

	it("ボタンを外せなくても、Mac から戻る流れは止めない", async () => {
		const { h, s } = await lend();
		vi.mocked(s.sys.api.editMessage).mockResolvedValueOnce(
			err(externalServiceUnavailable({ service: "discord" })),
		);
		macReturned(h, 2);
		await s.intake.watchLends();
		expect(s.seats.get("p1")).toBeNull();
		expect(s.sys.sentTo("p1").at(-1)).toBe(
			"Mac から戻りました。この投稿に書けば、席が前の会話のまま続けます。",
		);
	});
});

describe("件名の状態の絵文字", () => {
	const done = (dispatchId: string | null, body: string) =>
		seatMessage({ type: "worker_done", dispatchId, body });
	/** 状態のタグに絵文字を付けたフォーラムで受付を作る。 */
	const emojiSetup = async (
		opts: { hishaku?: ReturnType<typeof fakeHishaku>; seatLimit?: number } = {},
	) => {
		const d = fakeDiscord();
		const forum = d.channels.get(FORUM);
		if (!forum) throw new Error("no forum");
		d.channels.set(FORUM, { ...forum, availableTags: EMOJI_TAGS });
		return setup({ d, ...opts });
	};
	const nameOf = (s: Awaited<ReturnType<typeof setup>>, threadId = "p1") =>
		s.d.channels.get(threadId)?.name;
	const renames = (s: Awaited<ReturnType<typeof setup>>) =>
		vi.mocked(s.d.api.renameThread).mock.calls.length;

	it.each([
		["決めてほしい", "🤔[1234] README の誤字"],
		["引き継ぎ", "👨‍💼[1234] README の誤字"],
	])("%s になったら件名の頭に絵文字を付ける", async (status, title) => {
		const s = await emojiSetup({ hishaku: fakeHishaku() });
		const seat = await openPost(s);
		expect(nameOf(s)).toBe("[1234] README の誤字");
		await s.intake.onSeatMessage(
			done(seat.dispatchId, `済みました\n状態: ${status}`),
		);
		expect(nameOf(s)).toBe(title);
		expect(s.seats.pendingTitleOf("p1")).toBeNull();
	});

	it.each([
		["完了", "tag-done", "🎉[1234] README の誤字"],
		["見張り中", "tag-watching", "👀[1234] README の誤字"],
	])(
		"%s で残している間はタグだけ変え、席を閉じるときに件名の頭に絵文字を付ける",
		async (status, tag, title) => {
			const s = await emojiSetup({ hishaku: fakeHishaku() });
			const seat = await openPost(s);
			const before = renames(s);
			await s.intake.onSeatMessage(
				done(seat.dispatchId, `済みました\n状態: ${status}`),
			);
			expect(s.d.tagsOf("p1")).toEqual([tag]);
			expect(nameOf(s)).toBe("[1234] README の誤字");
			expect(renames(s)).toBe(before);
			await expireLinger(s);
			expect(nameOf(s)).toBe(title);
			expect(s.seats.get("p1")).toBeNull();
		},
	);

	it("残している間に続きを書かれても、件名は一度も変えない", async () => {
		const s = await emojiSetup({ hishaku: fakeHishaku() });
		const seat = await openPost(s);
		const before = renames(s);
		await s.intake.onSeatMessage(
			done(seat.dispatchId, "済みました\n状態: 完了"),
		);
		await s.intake.handle(say("p1", "もう少し聞きたい"));
		await s.intake.onSeatMessage(
			done(seat.dispatchId, "答えました\n状態: 完了"),
		);
		await s.intake.handle(say("p1", "もう一つ"));
		expect(s.d.tagsOf("p1")).toEqual(["tag-working"]);
		expect(renames(s)).toBe(before);
	});

	it("席が足りなくて残している席を閉じるときも、件名に絵文字を付ける", async () => {
		const s = await emojiSetup({ hishaku: fakeHishaku(), seatLimit: 1 });
		const seat = await openPost(s);
		await s.intake.onSeatMessage(
			done(seat.dispatchId, "済みました\n状態: 完了"),
		);
		await openPost(s, "p2");
		expect(s.seats.get("p1")).toBeNull();
		expect(nameOf(s)).toBe("🎉[1234] README の誤字");
	});

	it("順番待ちがあってすぐ閉じるときは、その場で件名に絵文字を付ける", async () => {
		const s = await emojiSetup({ hishaku: fakeHishaku(), seatLimit: 1 });
		const seat = await openPost(s);
		s.d.addThread("p2", "二つ目");
		await s.intake.handle(say("p2", "二つ目の依頼", { first: true }));
		expect(s.seats.get("p2")?.status).toBe("queued");
		await s.intake.onSeatMessage(
			done(seat.dispatchId, "済みました\n状態: 完了"),
		);
		expect(s.seats.get("p1")).toBeNull();
		expect(nameOf(s)).toBe("🎉[1234] README の誤字");
	});

	it("残している席に閉じる一言が書かれたら、席に渡さずに件名に絵文字を付けて閉じる", async () => {
		const h = fakeHishaku();
		const s = await emojiSetup({ hishaku: h });
		const seat = await openPost(s);
		await s.intake.onSeatMessage(
			done(seat.dispatchId, "済みました\n状態: 完了"),
		);
		const word = say("p1", "終了。");
		await s.intake.handle(word);
		expect(s.o.opsOf("send")).toEqual([]);
		expect(s.seats.get("p1")).toBeNull();
		expect(nameOf(s)).toBe("🎉[1234] README の誤字");
		expect(h.opsOf("push")).toEqual([
			{ number: 1234, generation: 1, cwd: "/seats/seat-p1", release: true },
		]);
		expect(s.o.opsOf("removeWorktree")).toEqual(["/seats/seat-p1"]);
		expect(s.d.reactionsOn("p1", word.payload.message_id)).toEqual(["✅"]);
		expect(s.d.reactionsOn("p1", "p1")).toEqual([]);
		expect(s.d.tagsOf("p1")).toEqual(["tag-done"]);
	});

	it("席が作業中なら、閉じる一言もふつうの返事として渡す", async () => {
		const s = await emojiSetup({ hishaku: fakeHishaku() });
		await openPost(s);
		await s.intake.handle(say("p1", "終了"));
		expect(s.o.opsOf("send")).toHaveLength(1);
		expect(s.seats.get("p1")?.status).toBe("working");
	});

	it("作業中に戻っても件名は前の絵文字のまま", async () => {
		const s = await emojiSetup({ hishaku: fakeHishaku() });
		const seat = await openPost(s);
		await s.intake.onSeatMessage(
			done(seat.dispatchId, "どちらにしますか\n状態: 決めてほしい"),
		);
		expect(nameOf(s)).toBe("🤔[1234] README の誤字");
		const calls = vi.mocked(s.d.api.renameThread).mock.calls.length;
		await s.intake.handle(say("p1", "A で"));
		expect(s.d.tagsOf("p1")).toEqual(["tag-working"]);
		expect(nameOf(s)).toBe("🤔[1234] README の誤字");
		expect(vi.mocked(s.d.api.renameThread).mock.calls).toHaveLength(calls);
	});

	it.each([
		["完了", "済みました"],
		["見張り中", "見張りを登録しました"],
	])(
		"%s で閉じたあとまた書かれて作業中に戻ったら、終わった絵文字を外す",
		async (status, body) => {
			const s = await emojiSetup({ hishaku: fakeHishaku() });
			const seat = await openPost(s);
			await s.intake.onSeatMessage(
				done(seat.dispatchId, `${body}\n状態: ${status}`),
			);
			await expireLinger(s);
			expect(nameOf(s)).not.toBe("[1234] README の誤字");
			await s.intake.handle(say("p1", "もう少し聞きたい"));
			expect(s.d.tagsOf("p1")).toEqual(["tag-working"]);
			expect(nameOf(s)).toBe("[1234] README の誤字");
		},
	);

	it("制限で 🎉 を付けられずに待っている間に作業中に戻ったら、🎉 を付けない", async () => {
		const s = await emojiSetup({ hishaku: fakeHishaku() });
		const seat = await openPost(s);
		const rename = vi.mocked(s.d.api.renameThread);
		rename.mockImplementationOnce(async () =>
			err(rateLimited({ retryAfterMs: 300_000 })),
		);
		await s.intake.onSeatMessage(
			done(seat.dispatchId, "済みました\n状態: 完了"),
		);
		await expireLinger(s);
		expect(s.seats.pendingTitleOf("p1")).toBe("🎉[1234] README の誤字");
		await s.intake.handle(say("p1", "もう少し聞きたい"));
		expect(s.seats.pendingTitleOf("p1")).toBe("[1234] README の誤字");
		s.fireDelayed();
		await vi.waitFor(() => expect(s.seats.pendingTitleOf("p1")).toBeNull());
		expect(nameOf(s)).toBe("[1234] README の誤字");
	});

	it("番号の無い投稿は絵文字と件名の間に空白を置く", async () => {
		const s = await emojiSetup();
		const seat = await openPost(s);
		await s.intake.onSeatMessage(
			done(seat.dispatchId, "直しました\n状態: 完了"),
		);
		await expireLinger(s);
		expect(nameOf(s)).toBe("🎉 README の誤字");
	});

	it("絵文字の無いタグやカスタム絵文字のタグでは絵文字を付けず、前の絵文字も外す", async () => {
		const d = fakeDiscord();
		const forum = d.channels.get(FORUM);
		if (!forum) throw new Error("no forum");
		d.channels.set(FORUM, {
			...forum,
			availableTags: EMOJI_TAGS.map((t) =>
				t.name === "完了" ? { ...t, emoji: null } : t,
			),
		});
		const s = await setup({ d, hishaku: fakeHishaku() });
		s.d.addThread("p1", "🤔[1234] README の誤字");
		await s.intake.handle(say("p1", "README の誤字を直して", { first: true }));
		const seat = s.seats.get("p1");
		await s.intake.onSeatMessage(
			done(seat?.dispatchId ?? null, "直しました\n状態: 完了"),
		);
		await expireLinger(s);
		expect(nameOf(s)).toBe("[1234] README の誤字");
	});

	it("同じ件名なら名前を変えない", async () => {
		const s = await emojiSetup({ hishaku: fakeHishaku() });
		const seat = await openPost(s);
		await s.intake.onSeatMessage(
			seatMessage({
				type: "question",
				dispatchId: seat.dispatchId,
				body: "A か B か",
			}),
		);
		expect(nameOf(s)).toBe("🤔[1234] README の誤字");
		const calls = vi.mocked(s.d.api.renameThread).mock.calls.length;
		await s.intake.onSeatMessage(
			done(seat.dispatchId, "やはり聞きたい\n状態: 決めてほしい"),
		);
		expect(vi.mocked(s.d.api.renameThread).mock.calls).toHaveLength(calls);
	});

	it("名前の変更の制限に当たったら、待ってから最後に覚えた件名だけを付ける", async () => {
		const s = await emojiSetup({ hishaku: fakeHishaku() });
		const seat = await openPost(s);
		const rename = vi.mocked(s.d.api.renameThread);
		rename.mockImplementationOnce(async () =>
			err(rateLimited({ retryAfterMs: 300_000 })),
		);
		await s.intake.onSeatMessage(
			seatMessage({
				type: "question",
				dispatchId: seat.dispatchId,
				body: "A か B か",
			}),
		);
		expect(nameOf(s)).toBe("[1234] README の誤字");
		// タグは止めない
		expect(s.d.tagsOf("p1")).toEqual(["tag-decide"]);
		expect(s.delayed.map((t) => t.ms)).toEqual([300_000]);
		await s.intake.handle(say("p1", "A で"));
		await s.intake.onSeatMessage(
			done(s.seats.get("p1")?.dispatchId ?? null, "直しました\n状態: 完了"),
		);
		await expireLinger(s);
		// 待っている間は呼ばず、付けたい件名だけを覚え直す
		expect(rename.mock.calls.map((c) => c[1])).toEqual([
			"[1234] README の誤字",
			"🤔[1234] README の誤字",
		]);
		const reopened = await openSeatStore(s.stateDir);
		expect(reopened.pendingTitleOf("p1")).toBe("🎉[1234] README の誤字");
		s.fireDelayed();
		await vi.waitFor(() => expect(nameOf(s)).toBe("🎉[1234] README の誤字"));
		expect(rename.mock.calls.map((c) => c[1])).toEqual([
			"[1234] README の誤字",
			"🤔[1234] README の誤字",
			"🎉[1234] README の誤字",
		]);
		await vi.waitFor(() => expect(s.seats.pendingTitleOf("p1")).toBeNull());
	});

	it("起動時に、前の受付が付けられなかった件名を付ける", async () => {
		const d = fakeDiscord();
		const forum = d.channels.get(FORUM);
		if (!forum) throw new Error("no forum");
		d.channels.set(FORUM, { ...forum, availableTags: EMOJI_TAGS });
		const stateDir = tempDir();
		const store = await openSeatStore(stateDir);
		await store.setPendingTitle("p1", "🎉[1234] README の誤字");
		d.addThread("p1", "[1234] README の誤字");
		const s = await setup({ d, stateDir });
		await s.intake.reconcile();
		await vi.waitFor(() => expect(nameOf(s)).toBe("🎉[1234] README の誤字"));
	});
});
