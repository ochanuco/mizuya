import * as v from "valibot";
import type { ActivityEntry } from "./activity-log.ts";
import { approvalRequestText } from "./approval.ts";
import type { ApprovalStore } from "./approval-store.ts";
import type { DiscordApi } from "./discord-rest.ts";
import type { Ledger, Pending } from "./guard/ledger.ts";
import {
	formatJstForPrompt,
	PARTNER_IDS,
	type PartnerId,
	toModelJson,
} from "./lib/core.ts";
import type { Logger } from "./logger.ts";
import { diffPatrol, type PatrolStore, patrolSources } from "./patrol.ts";
import {
	loginExpiryDecision,
	patrolPrompt,
	STANDUP_TITLE_LIMIT,
	standupPostFooter,
	standupPrompt,
	watchPrompt,
} from "./prompts.ts";
import {
	failed,
	memoryForSeat,
	type StandupMaterials,
	type Unavailable,
	type Watch,
} from "./standup-materials.ts";
import type { RunKind } from "./standup-timer.ts";
import { buttonMessage } from "./system.ts";

export type Decision = { title: string; body: string };

/** 見張りの新着を書く投稿（無ければ仕事チャンネル）と、書く名義のパートナー。 */
export type WatchTarget = { threadId: string | null; partner: string };

const noticeLine = v.pipe(
	v.string(),
	v.trim(),
	v.nonEmpty(),
	v.regex(/^[^\r\n]*$/),
);

const reportSchema = v.object({
	decisions: v.array(
		v.object({
			title: v.pipe(v.string(), v.trim(), v.nonEmpty()),
			body: v.pipe(v.string(), v.trim(), v.nonEmpty()),
		}),
	),
	notices: v.optional(
		v.array(
			v.union([
				noticeLine,
				v.object({ watch_id: v.optional(v.string()), text: noticeLine }),
			]),
		),
		[],
	),
});

/** 見張りの新着 1 行。watchId はどの見張りの新着か（書く先を決める）。 */
export type Notice = { watchId: string | null; text: string };

export type SeatReport = { decisions: Decision[]; notices: Notice[] };

/** Claude の返事の最後の ```json ブロックから、決めてほしいことと見張りの知らせを読む。読めなければ null。 */
export const parseReport = (text: string): SeatReport | null => {
	const blocks = [...text.matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
	const last = blocks.at(-1)?.[1];
	if (last === undefined) return null;
	let json: unknown;
	try {
		json = JSON.parse(last);
	} catch {
		return null;
	}
	const parsed = v.safeParse(reportSchema, json);
	if (!parsed.success) return null;
	return {
		decisions: parsed.output.decisions.map((d) => ({
			title:
				d.title.length > STANDUP_TITLE_LIMIT
					? `${d.title.slice(0, STANDUP_TITLE_LIMIT)}…`
					: d.title,
			body: d.body,
		})),
		notices: parsed.output.notices.map((n) =>
			typeof n === "string"
				? { watchId: null, text: n }
				: { watchId: n.watch_id ?? null, text: n.text },
		),
	};
};

/** 決めてほしいことだけを読む。 */
export const parseDecisions = (text: string): Decision[] | null =>
	parseReport(text)?.decisions ?? null;

export type StandupDeps = {
	/** Yukarin の bot。投稿を立て、知らせを書く。ほかのパートナーの bot が無いときは代わりに書く。 */
	discord: DiscordApi;
	/** mizuya の bot。投稿に許可と不要のボタンを出す。 */
	system: DiscordApi;
	/** 投稿で判断を待つ持ち主。投稿の最初の発言でメンションして通知する。 */
	ownerUserId: string;
	approvals: ApprovalStore;
	ledger: Ledger;
	workForumChannelId: string;
	/** 見張りの知らせを書くチャンネル。 */
	workTextChannelId: string;
	/** 朝会・見回り・GitHub の知らせの席が止められた操作を、活動ログに 1 行残す。 */
	recordActivity?: (entry: ActivityEntry) => Promise<void>;
	now?: () => Date;
	/** Yukarin 以外のパートナーの bot。見張りの持ち主の名で書く。無いパートナーは Yukarin の bot で書く。 */
	speakers?: Partial<Record<PartnerId, DiscordApi>>;
	/** 立てた投稿の担当を決める。返事を、投稿を書いたパートナーの席が受けるようにする。 */
	assign?: (threadId: string, partner: PartnerId) => Promise<void>;
	/**
	 * 見張りの id → 新着を書く先と持ち主。朝会と見回りを始めるときに覚え、終わったときに引く。
	 * 再起動で消えたら、仕事チャンネルに回の持ち主の名で書く。
	 */
	watchThreads?: Map<string, WatchTarget>;
	/** 見張りの知らせをやり直すまで待つ。テストで差し替える。 */
	sleep?: (ms: number) => Promise<void>;
	logger: Logger;
};

/** 見張りの新着は席が記憶に知らせ済みと残したあとに届くので、書けないと次の回には出ない。間をおいてやり直す。 */
const NOTICE_RETRY_MS = [10_000, 60_000];

const DECIDE_TAG = "決めてほしい";

export type StandupReport = { posted: string[]; failed: number };

const RUN_NAME: Record<RunKind, string> = {
	standup: "朝会",
	patrol: "見回り",
	event: "GitHub の知らせ",
	watch: "見張り",
};

/** 投稿の最後に足す「どの回から」。朝会は日付、見回りは時刻で見分ける。 */
const runLabel = (kind: RunKind, now: Date) => {
	const jst = formatJstForPrompt(now);
	return `${kind === "standup" ? jst.slice(0, 10) : jst.slice(11, 16)} の${RUN_NAME[kind]}`;
};

/** そのパートナーの名で書く bot。bot が無いパートナーは Yukarin が代わりに書き、担当も Yukarin にする。 */
const voiceOf = (
	deps: StandupDeps,
	partner: string,
): { partner: PartnerId; discord: DiscordApi } => {
	const id = PARTNER_IDS.find((p) => p === partner);
	const discord = id === undefined ? undefined : deps.speakers?.[id];
	return id !== undefined && discord !== undefined
		? { partner: id, discord }
		: { partner: "yukarin", discord: deps.discord };
};

/** 決めてほしいこと 1 件ごとに仕事フォーラムへ投稿する。投稿への返事は、その投稿の新しい席が受ける。 */
export const postDecisions = async (
	deps: StandupDeps,
	decisions: readonly Decision[],
	blocked: readonly Pending[],
	kind: RunKind = "standup",
	partner = "yukarin",
): Promise<StandupReport> => {
	const log = deps.logger;
	const now = (deps.now ?? (() => new Date()))();
	const report: StandupReport = { posted: [], failed: 0 };
	if (decisions.length === 0 && blocked.length === 0) return report;
	const voice = voiceOf(deps, partner);

	const forum = await voice.discord.getChannel(deps.workForumChannelId);
	const tagId = forum.ok
		? forum.value.availableTags.find((t) => t.name === DECIDE_TAG)?.id
		: undefined;
	if (!tagId) log.warn("forum tag missing", { tag: DECIDE_TAG });
	const from = runLabel(kind, now);

	/** 投稿を立て、その中に mizuya の bot でボタンを出す。ボタンのメッセージの ID も返す。 */
	const post = async (d: Decision, approval = false) => {
		const created = await voice.discord.createForumPost(
			deps.workForumChannelId,
			{
				name: d.title,
				content: `<@${deps.ownerUserId}> ${d.body}${standupPostFooter(from)}`,
				tagIds: tagId ? [tagId] : [],
				notify: [deps.ownerUserId],
			},
		);
		if (!created.ok) {
			report.failed++;
			log.error("standup post failed", { error: created.error.type });
			return null;
		}
		const threadId = created.value.threadId;
		report.posted.push(threadId);
		// 担当の無い投稿は Yukarin が受けるので、ほかのパートナーの投稿だけ担当を決める
		if (voice.partner !== "yukarin")
			await deps.assign?.(threadId, voice.partner);
		const m = buttonMessage({ approval, dismiss: true });
		const buttons = await deps.system.send(
			threadId,
			m.content,
			undefined,
			[],
			m.buttons,
		);
		if (!buttons.ok) {
			log.error("standup buttons failed", {
				thread_id: threadId,
				error: buttons.error.type,
			});
		}
		return {
			threadId,
			buttonMessageIds: buttons.ok ? buttons.value.messageIds : [],
		};
	};

	for (const d of decisions) await post(d);

	if (blocked.length > 0) {
		const title = `${RUN_NAME[kind]}で止めた操作`;
		const posted = await post(
			{ title, body: approvalRequestText(blocked) },
			true,
		);
		if (posted !== null) {
			const { threadId } = posted;
			const operations = blocked.map((b) => b.operation);
			await deps
				.recordActivity?.({
					at: now,
					kind: "blocked",
					threadId,
					title,
					partner: voice.partner,
					tools: operations.map((o) => o.tool),
				})
				.catch((e: unknown) =>
					log.warn("activity record failed", { error: String(e) }),
				);
			// フォーラム投稿の最初のメッセージは投稿と同じ ID を持つ
			await deps.approvals.set(threadId, {
				messageIds: [threadId, ...posted.buttonMessageIds],
				operations,
			});
			deps.ledger.log({
				event: "requested",
				thread_id: threadId,
				message_id: threadId,
				operations,
			});
		}
	}
	return report;
};

/** 時間が来た見張り。記憶を読めなかった回は 0 件として、次の回に回す。 */
export const dueWatches = (m: StandupMaterials): Watch[] =>
	failed(m.watches) ? [] : m.watches.filter((w) => w.due);

/** 新着を書く先と名義を、席の報告が届くまで覚えておく。 */
const rememberThreads = (deps: StandupDeps, watches: readonly Watch[]) => {
	for (const w of watches) {
		deps.watchThreads?.set(w.id, {
			threadId: w.notify_thread_id,
			partner: w.partner,
		});
	}
};
/** 書く先は受付が決めるので、席には渡さない。 */
const forSeat = ({ notify_thread_id: _omit, ...w }: Watch) => w;

/**
 * 見張り 1 件の席を、`due` によらず立てる。Dkron がその見張りの間隔で起こす。
 * 席は見張りの持ち主のパートナーが受け持つ。
 * 記憶に無い（止められた、期限が切れた）見張りと、記憶を読めなかった回は席を立てない。
 * 席を立てたら席の ID、立てなかったら null を返す。
 */
export const startWatch = async (input: {
	deps: StandupDeps;
	partner: PartnerId;
	watchId: string;
	read: (partner: string) => Promise<Watch[] | Unavailable>;
	start: (spec: string, kind: RunKind, partner: PartnerId) => Promise<string>;
}): Promise<string | null> => {
	const { deps, partner, watchId } = input;
	const now = (deps.now ?? (() => new Date()))();
	const watches = await input.read(partner);
	if (failed(watches)) {
		deps.logger.warn("watch skipped", {
			partner,
			watch_id: watchId,
			reason: watches.unavailable,
		});
		return null;
	}
	const watch = watches.find((w) => w.id === watchId);
	if (watch === undefined) {
		deps.logger.info("watch gone", { partner, watch_id: watchId });
		return null;
	}
	rememberThreads(deps, [watch]);
	const id = await input.start(
		watchPrompt({
			now,
			materials: toModelJson({ due_watches: [forSeat(watch)] }),
		}),
		"watch",
		partner,
	);
	deps.logger.info("watch started", {
		seat: id,
		partner,
		watch_id: watchId,
	});
	return id;
};

/**
 * 朝会か見回りを始める。材料を集めて席に渡す。席は取り消せることを済ませ、決めてほしいことを worker_done で返す。
 * 見回りは前の回から変わった件と時間が来た見張りだけを渡し、どちらも無ければ席を立てない（トークン代を使わない）。
 * ログインの期限は Claude の返事によらないので、朝会のときにここで先に投稿する。
 * 席を立てたら席の ID、立てなかったら null を返す。
 */
export const startStandup = async (input: {
	deps: StandupDeps;
	kind: RunKind;
	gather: () => Promise<StandupMaterials>;
	store: PatrolStore;
	start: (spec: string, kind: RunKind) => Promise<string>;
}): Promise<string | null> => {
	const { deps, kind } = input;
	const log = deps.logger;
	const now = (deps.now ?? (() => new Date()))();
	const materials = await input.gather();
	const prev = await input.store.load();
	const { changes, next } = diffPatrol(prev ?? {}, patrolSources(materials));

	const due = dueWatches(materials);
	rememberThreads(deps, due);
	const watches = due.map(forSeat);

	if (kind === "patrol") {
		// 初めての回は前の回が無く、全部が新着に見える。朝会で見る分を二度投稿しないよう、覚えるだけにする
		const seen = prev === null ? {} : changes;
		if (Object.keys(seen).length === 0 && watches.length === 0) {
			await input.store.save(next);
			log.info("patrol quiet", { first: prev === null });
			return null;
		}
		const id = await input.start(
			patrolPrompt({
				now,
				materials: toModelJson({
					changes: seen,
					due_watches: watches,
					memory: memoryForSeat(materials.memory),
					mac_state: materials.mac_state,
				}),
			}),
			kind,
		);
		await input.store.save(next);
		log.info("patrol started", {
			seat: id,
			changes: Object.fromEntries(
				Object.entries(seen).map(([k, xs]) => [k, xs.length]),
			),
			watches: watches.length,
		});
		return id;
	}

	if (
		materials.claude_login.expires_soon &&
		materials.claude_login.expires_at
	) {
		await postDecisions(
			deps,
			[loginExpiryDecision(materials.claude_login.expires_at)],
			[],
		);
	}
	const id = await input.start(
		standupPrompt({
			now,
			materials: toModelJson({
				...materials,
				memory: memoryForSeat(materials.memory),
				watches: undefined,
				due_watches: watches,
			}),
		}),
		kind,
	);
	await input.store.save(next);
	log.info("standup started", { seat: id });
	return id;
};

/**
 * 見張りの新着を 1 件 1 行で、見張りの持ち主の名で書く。席から登録した見張りはその投稿に、ほかは仕事チャンネルに書く。
 * 持ち主が分からない新着は、回を受け持ったパートナーの名で書く。
 * 無ければ何も書かない。全部書けたら true。
 */
export const postNotices = async (
	deps: StandupDeps,
	notices: readonly Notice[],
	partner = "yukarin",
): Promise<boolean> => {
	const groups = new Map<
		string,
		{ discord: DiscordApi; channelId: string; lines: string[] }
	>();
	for (const n of notices) {
		const target =
			n.watchId === null ? undefined : deps.watchThreads?.get(n.watchId);
		const voice = voiceOf(deps, target?.partner ?? partner);
		const channelId = target?.threadId ?? deps.workTextChannelId;
		const key = `${voice.partner}/${channelId}`;
		const group = groups.get(key) ?? {
			discord: voice.discord,
			channelId,
			lines: [],
		};
		group.lines.push(n.text);
		groups.set(key, group);
	}
	let ok = true;
	for (const g of groups.values()) {
		if (!(await sendNotice(deps, g.discord, g.channelId, g.lines))) ok = false;
	}
	return ok;
};

const sendNotice = async (
	deps: StandupDeps,
	discord: DiscordApi,
	channelId: string,
	lines: readonly string[],
): Promise<boolean> => {
	const sleep =
		deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
	for (let attempt = 0; ; attempt++) {
		const sent = await discord.send(channelId, lines.join("\n"));
		if (sent.ok) return true;
		const wait = NOTICE_RETRY_MS[attempt];
		if (wait === undefined || !sent.error.retryable) {
			deps.logger.error("watch notice failed", {
				error: sent.error.type,
				attempts: attempt + 1,
				notices: lines.length,
			});
			return false;
		}
		deps.logger.warn("watch notice retry", { error: sent.error.type });
		await sleep(wait);
	}
};

/** 朝会か見回りの席の報告を読み、決めてほしいことを回を受け持ったパートナーの名で投稿にし、見張りの新着を知らせる。 */
export const finishStandup = async (
	deps: StandupDeps,
	text: string,
	blocked: readonly Pending[],
	kind: RunKind = "standup",
	partner: PartnerId = "yukarin",
): Promise<StandupReport> => {
	const parsed = parseReport(text);
	if (parsed === null) {
		deps.logger.error("standup decisions unreadable", {});
	}
	const notified = await postNotices(deps, parsed?.notices ?? [], partner);
	const report = await postDecisions(
		deps,
		parsed?.decisions ?? [],
		blocked,
		kind,
		partner,
	);
	deps.logger.info("standup done", {
		kind,
		decisions: (parsed?.decisions ?? []).length,
		notices: (parsed?.notices ?? []).length,
		notices_failed: !notified,
		blocked: blocked.length,
		...report,
	});
	return report;
};
