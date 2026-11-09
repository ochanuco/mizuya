import { randomUUID } from "node:crypto";
import type { ActivityEntry, ActivityKind } from "./activity-log.ts";
import {
	type ApprovalAnswer,
	approvalAnswerOf,
	approvalRequestText,
	approvedNote,
	approvedPrompt,
	isApproval,
	settledApprovalText,
	uniquePending,
} from "./approval.ts";
import type { ApprovalRequest, ApprovalStore } from "./approval-store.ts";
import {
	type AttachmentCollector,
	takeAttachRefs,
	withNote,
} from "./attachments.ts";
import type { Summarizer } from "./claude-cli.ts";
import type {
	ButtonPressEvent,
	CommandEvent,
	WorkMessageEvent,
} from "./discord-events.ts";
import type {
	Attachment,
	Button,
	DiscordApi,
	PostedMessage,
} from "./discord-rest.ts";
import { dismissedText, isDismissButton } from "./dismiss.ts";
import { seatNameOf } from "./guard/env.ts";
import type { Ledger, Pending } from "./guard/ledger.ts";
import type { Operation } from "./guard/operation.ts";
import type { Hishaku, SessionMeta } from "./hishaku.ts";
import { createKeyedQueue } from "./keyed-queue.ts";
import {
	backFromMacText,
	CONFIRM_BUTTONS,
	heldText,
	type LendPress,
	lendPressOf,
	lentText,
	MAC_RETURNED_TEXT,
	MAC_RETURNED_WITH_HELD_TEXT,
	macResumedText,
	RETURNED_NOTE,
	TAKEBACK_BUTTON,
	TAKEBACK_CANCELLED_TEXT,
	takebackConfirmText,
	takebackNote,
	takenBackText,
} from "./lend.ts";
import { PARTNER_IDS, type PartnerId } from "./lib/core.ts";
import { err, ok, type Result } from "./lib/result.ts";
import type { Logger } from "./logger.ts";
import type {
	Orca,
	OrcaError,
	SeatAgent,
	SeatHow,
	SeatMessage,
	SeatPrepare,
} from "./orca.ts";
import {
	backgroundReplyNote,
	composeTitle,
	fallbackTitle,
	forumPostBody,
	forumStarterPrompt,
	HANDOFF_UNSAVED_NOTE,
	handoffOpenLine,
	historyPrompt,
	issuePostBody,
	issuePrompt,
	issueThreadName,
	LEASE_STOLEN_TEXT,
	messageLink,
	numberedTitle,
	numberNote,
	type PickedIssue,
	parseTitle,
	replyPrompt,
	requestPrompt,
	restartNote,
	seatSpec,
	unnumberedTitle,
	wakeNote,
} from "./prompts.ts";
import {
	MODEL_TAGS,
	modelChangedText,
	modelLabel,
	modelName,
	otherPartnerText,
	partnerName,
	replaceModelTag,
} from "./seat-model.ts";
import { PANEL_REFRESH_MS, panelText, REACTION_OF } from "./seat-panel.ts";
import {
	type MessageRef,
	newSeat,
	type Seat,
	type SeatLabel,
	type SeatStore,
} from "./seat-store.ts";
import type { RunKind } from "./standup-timer.ts";
import { buttonMessage } from "./system.ts";
import {
	type FindWorkBranches,
	recordWorkBranchQuietly,
} from "./work-branch.ts";
import {
	replaceStatusTag,
	takeStatus,
	WORK_STATUSES,
	type WorkStatus,
} from "./work-status.ts";

type StatusTag = { id: string; emoji: string | null };

/** 席を受け持つパートナーの bot と、その席に渡す前置き。 */
export type SeatPartner = {
	/** 返事・投稿・タグ・リアクション・入力中の表示をこの bot で書く。 */
	discord: DiscordApi;
	botUserId: string;
	/** 新しい席に最初に渡す前置き（人格、仕事のしかた、引き継ぎの指示）。 */
	preamble: string;
};

export type IntakeDeps = {
	/**
	 * 席が返事（完了か質問）を書いた後に呼ぶ。席は作業中に記憶の見張りを足したり止めたりするので、
	 * スケジューラのジョブをその場で合わせ、返事と Dkron の表示がずれないようにする。
	 */
	seatReplied?: () => void;
	/** Yukarin の bot。読むのもこの bot で行う。 */
	discord: DiscordApi;
	/** mizuya の bot。許可と不要のボタン、状態の欄を書く。 */
	system: DiscordApi;
	/** mizuya の bot のユーザー。メンションされたら Yukarin 宛てとみなす。 */
	systemUserId: string;
	orca: Orca;
	/**
	 * 席の agent のセッションを預ける hishaku。あれば投稿ごとに番号を取り、席の会話を Manager に預けて同じ番号で続ける。
	 * 無いか Manager に届かなければ、席は手元の会話だけで動く。
	 */
	hishaku?: Hishaku | null;
	/** 席の worktree の clone から作業ブランチを探す。あれば会話を預けて返す前に hishaku の meta に書く。 */
	findWorkBranches?: FindWorkBranches | null;
	seats: SeatStore;
	/** 投稿で許可を待っている操作。 */
	approvals: ApprovalStore;
	/** hook が止めた操作と、許可の記録。 */
	ledger: Ledger;
	summarize: Summarizer;
	/** 席の返事の添付の行を読み、投稿に付けるファイルを集める。 */
	collectAttachments: AttachmentCollector;
	/** 終わった仕事を、席を受け持ったパートナーの記憶に 1 行残す。 */
	remember: (summary: string, partner: PartnerId) => Promise<void>;
	/** 席がしたこと（閉じた・止められた）を活動ログに 1 行残す。 */
	recordActivity?: (entry: ActivityEntry) => Promise<void>;
	/** 朝会か見回りの席が返した決めてほしいことを投稿にする。 */
	standupDone: (
		text: string,
		blocked: readonly Pending[],
		kind: RunKind,
		partner: PartnerId,
	) => Promise<void>;
	/** 新しい席に最初に渡す前置き（人格、仕事のしかた、引き継ぎの指示）。 */
	preamble: string;
	/** Yukarin の bot のユーザー。 */
	botUserId: string;
	/** Akarin の席。あれば Akarin 宛ての依頼に Codex CLI の席を作る。無ければすべて Yukarin が受ける。 */
	akarin?: SeatPartner | null;
	/** 依頼の宛先の席を決める role。メンションされた role の席に渡す。 */
	roleIds: { yukarin: string | null; akarin: string | null };
	/** この人たちの発言だけで作業する。 */
	ownerUserIds: ReadonlySet<string>;
	workTextChannelId: string;
	workForumChannelId: string;
	/** 同時に Claude を動かしておく席の上限。止めた席と順番待ちは数えない。 */
	seatLimit: number;
	/** 決めてほしいままこれだけたった席は Claude を止める。 */
	sleepAfterMs: number;
	/**
	 * 完了か見張り中で手を止めた投稿の席を、これだけ閉じずに残す。
	 * 起こし直すと system prompt が変わってキャッシュが効かないので、すぐ続きを書かれたら同じ Claude に渡す。
	 */
	doneLingerMs: number;
	newGrantId?: () => string;
	now?: () => Date;
	/** ms ごとに fn を呼び、止める関数を返す。入力中の表示を送り続けるのに使う。 */
	every?: (ms: number, fn: () => void) => () => void;
	/** ms たったら fn を 1 回呼ぶ。件名の変更の制限が解けるのを待つのに使う。 */
	after?: (ms: number, fn: () => void) => void;
	logger: Logger;
};

/** Discord の入力中の表示は約 10 秒で消えるので、それより短い間隔で送り直す。 */
export const TYPING_EVERY_MS = 8_000;

/** Discord はスレッドの名前の変更を 1 スレッドあたり 10 分に 2 回までに抑える。待つ長さが分からないときはこれだけ待つ。 */
const RENAME_WINDOW_MS = 10 * 60_000;

const defaultAfter = (ms: number, fn: () => void) => {
	setTimeout(fn, ms).unref();
};

const defaultEvery = (ms: number, fn: () => void) => {
	const timer = setInterval(fn, ms);
	timer.unref();
	return () => clearInterval(timer);
};

type Payload = WorkMessageEvent["payload"];

const HISTORY_LIMIT = 100;
const FAILURE_TEXT =
	"うまく進められませんでした。少し置いてから、もう一度声をかけてください。";
const QUEUED_TEXT =
	"いまは席がすべてふさがっているので、順番待ちにしました。空いたら始めます。";
const STOPPED_TEXT =
	"作業が途中で止まりました。返事をくれれば、そこから続けます。";
const RESTARTED_TEXT =
	"受付を作り直したので、作業が途中で止まりました。返事をくれれば、そこから続けます。";
const STANDUP_NO_ASK =
	"朝会と見回りでは持ち主に聞けない。聞きたいことは決めてほしいことに入れて、JSON で返す。";

/** 朝会と見回りの席は、席の ID の頭で見分ける。受付が作り直されても分かる。 */
const runKindOf = (seat: Seat): RunKind =>
	seat.threadId.startsWith("patrol-")
		? "patrol"
		: seat.threadId.startsWith("event-")
			? "event"
			: seat.threadId.startsWith("watch-")
				? "watch"
				: "standup";

/**
 * 席を始められなかったときに投稿に書く文。持ち主が次に何をすればよいか分かるよう、止まった所だけを短く書く。
 * Orca の理由の文はパスや ID を含むので、そのまま出さない。
 */
export const seatStartFailedText = (error: OrcaError) => {
	const where =
		error.type === "SeatTrustFailed"
			? "Claude の作業場所を信頼済みにできなかった"
			: error.reason.includes("agent-trust-workspace")
				? "Claude の作業場所の確認で止まった"
				: error.reason.includes("agent_readiness")
					? "Claude が起動しきらなかった"
					: "Orca が席を作れなかった";
	return `席を始められませんでした（${where}）。返事をくれれば、もう一度始めます。`;
};

const RESTARTING_TEXT =
	"席の Claude を起動し直します。前の会話のまま続けます。";

const MENTION = /<@[!&]?\d+>/g;

/** 席を起動し直す頼み。ほかの返事と取り違えないよう、決まった言い方だけにする。 */
export const isRestartRequest = (content: string) =>
	/^(起動し(直|なお)して(ください)?|再起動して(ください)?|再起動)$/.test(
		content
			.replace(MENTION, "")
			.normalize("NFKC")
			.trim()
			.replace(/[。.!！]+$/, ""),
	);

/** 残している席を閉じる一言。席の Claude に渡さずに受付が閉じるので、決まった言い方だけにする。 */
export const isCloseRequest = (content: string) =>
	/^(終了|クローズ|close|閉じて|おわり|終わり)$/i.test(
		content
			.replace(MENTION, "")
			.normalize("NFKC")
			.trim()
			.replace(/[。!！]+$/, ""),
	);

/**
 * escalation の本文（席の端末の末尾）に、裏で動いている shell やタスクが出ているか。
 * Claude CLI は裏の作業が残っていると「1 shell still running」「· 2 shells ·」のように書く。
 */
export const backgroundRunning = (body: string) =>
	/\b\d+ (?:background )?(?:shells?|tasks?|monitors?)(?: still)? running\b|· \d+ (?:shells?|tasks?|monitors?) ·/i.test(
		body,
	);

const ALIVE = new Set(["working", "asking", "waiting"]);

const STATUS_SUMMARY_LIMIT = 200;

/** 裏の作業を待っている席に持ち主が書いたとき、受付がすぐ返す文。 */
export const busyText = (lastStatus: string | null) => {
	const doing = (lastStatus ?? "").replace(/\s+/g, " ").trim();
	if (doing === "") return "作業中です。";
	const short =
		doing.length > STATUS_SUMMARY_LIMIT
			? `${doing.slice(0, STATUS_SUMMARY_LIMIT)}…`
			: doing;
	return `作業中です。（${short}）`;
};

export type Intake = {
	/** 受け付けた仕事が終わるまで待つ Promise を返す。HTTP は待たずに 202 を返す。 */
	handle: (envelope: WorkMessageEvent) => Promise<void>;
	/** 投稿のボタンが押された。許可の依頼のボタンだけを扱う。 */
	press: (envelope: ButtonPressEvent) => Promise<void>;
	/** `/ai` の依頼で投稿を立てるか、投稿の席のモデルを変える。 */
	command: (envelope: CommandEvent) => Promise<void>;
	/** 席から届いたメッセージ（質問、完了の報告、止まった知らせ）を投稿に運ぶ。 */
	onSeatMessage: (msg: SeatMessage) => Promise<void>;
	/** 朝会か見回りの席を作る。見張りの席は持ち主のパートナーが受け持つ。席の名前にする ID を返す。 */
	startStandup: (
		spec: string,
		kind?: RunKind,
		partner?: PartnerId,
	) => Promise<string>;
	/** label の付いた GitHub の issue から投稿を立て、partner の席で作業させる。 */
	startFromIssue: (
		issue: PickedIssue,
		partner: PartnerId,
	) => Promise<Result<{ threadId: string }, { type: string }>>;
	/** 決めてほしいまま時間がたった席の Claude を止め、完了したあと残していた席を時間がたったら閉じる。 */
	sleepIdle: () => Promise<void>;
	/** 起動時に、対応表と Orca の席を突き合わせる。 */
	reconcile: () => Promise<void>;
	/** 作業中の席の状態の欄の経過時間を書き換える。前に書いてから間がなければ書かない。 */
	refreshPanels: () => Promise<void>;
	/** 作業中の席の数。gateway が自分のパートナーの数を bot のステータスに出す。 */
	summary: () => SeatSummary;
	/** 席が借りている hishaku のセッションの貸し出しを延ばす。Mac が返してほしいと頼んでいれば、ターンの終わりに渡す。 */
	renewLeases: () => Promise<void>;
	/** Mac に貸している投稿の meta を読み、Mac が借りた・返したことを投稿に書く。返していれば席を起こす。 */
	watchLends: () => Promise<void>;
};

export type SeatSummary = {
	/** すべてのパートナーの合計。 */
	working: number;
	partners: Record<PartnerId, number>;
};

/** 席で動かす CLI。Akarin は Codex CLI で作業する。 */
export const agentOf = (partner: PartnerId): SeatAgent =>
	partner === "akarin" ? "codex" : "claude";

export const createIntake = (deps: IntakeDeps): Intake => {
	const log = deps.logger;
	const now = deps.now ?? (() => new Date());
	const newGrantId = deps.newGrantId ?? randomUUID;
	const queue = createKeyedQueue();
	const parentOf = new Map<string, string | null>();
	let statusTagInfo: Map<WorkStatus, StatusTag> | null = null;
	let modelTagIds: Map<string, string> | null = null;
	const every = deps.every ?? defaultEvery;
	const after = deps.after ?? defaultAfter;

	const yukarin: SeatPartner = {
		discord: deps.discord,
		botUserId: deps.botUserId,
		preamble: deps.preamble,
	};
	/** 投稿の担当。Akarin の bot が無ければ、Akarin の投稿も Yukarin が受ける。 */
	const partnerOf = (threadId: string): PartnerId =>
		deps.akarin && deps.seats.partnerOf(threadId) === "akarin"
			? "akarin"
			: "yukarin";
	const speaker = (partner: PartnerId): SeatPartner =>
		partner === "akarin" && deps.akarin ? deps.akarin : yukarin;
	/** どの席の bot が書いたメッセージか。 */
	const spokenBy = (m: PostedMessage): PartnerId | null => {
		if (deps.akarin && m.authorId === deps.akarin.botUserId) return "akarin";
		return m.authorId === deps.botUserId ? "yukarin" : null;
	};
	/** その席の role か bot へのメンションがあるか。 */
	const mentionsPartner = (p: Payload, partner: PartnerId) => {
		const roleId = deps.roleIds[partner];
		const userId =
			partner === "akarin" ? deps.akarin?.botUserId : deps.botUserId;
		return (
			(roleId !== null && p.mention_roles.includes(roleId)) ||
			(userId !== undefined && p.mentions.includes(userId))
		);
	};
	/** 投稿に書き込む bot。読むだけの呼び出しは Yukarin の bot のままにする。 */
	const botOf = (threadId: string) => speaker(partnerOf(threadId)).discord;

	/** フォーラムの投稿 → 依頼者。最初の返事でだけ依頼者にメンションする。フォーラムは通知が来ないと見落としやすい */
	const firstReplyTo = new Map<string, string>();
	/** 担当の席の bot で投稿に書く。 */
	const sendTo = async (
		threadId: string,
		content: string,
		files: readonly Attachment[] = [],
	) => {
		const who = firstReplyTo.get(threadId);
		const sent = await botOf(threadId).send(
			threadId,
			who ? `<@${who}> ${content}` : content,
			undefined,
			files,
			[],
			who ? [who] : [],
		);
		if (sent.ok && who) firstReplyTo.delete(threadId);
		return sent;
	};

	const typingTimers = new Map<string, () => void>();
	const sendTyping = (threadId: string) => {
		void botOf(threadId)
			.typing(threadId)
			.then((r) => {
				if (!r.ok) {
					log.debug("typing failed", {
						thread_id: threadId,
						error: r.error.type,
					});
				}
			});
	};
	/** 席の Claude が動いている間だけ、投稿に入力中の表示を出し続ける。 */
	const syncTyping = (threadId: string, seat: Seat | null) => {
		const on = seat !== null && seat.status === "working" && !seat.standup;
		const stop = typingTimers.get(threadId);
		if (on && !stop) {
			sendTyping(threadId);
			typingTimers.set(
				threadId,
				every(TYPING_EVERY_MS, () => sendTyping(threadId)),
			);
		} else if (!on && stop) {
			stop();
			typingTimers.delete(threadId);
		}
	};
	// 席の状態が変わる所はすべてここを通るので、入力中の表示の付け外しをここでまとめる
	const seats: SeatStore = {
		...deps.seats,
		set: async (seat) => {
			await deps.seats.set(seat);
			syncTyping(seat.threadId, seat);
		},
		delete: async (threadId) => {
			await deps.seats.delete(threadId);
			syncTyping(threadId, null);
		},
	};

	/** 状態のタグ名 → ID と絵文字。絵文字は mizuya に書き写さず、フォーラムのタグから引く。 */
	const statusTagsOf = async (): Promise<Map<WorkStatus, StatusTag>> => {
		if (statusTagInfo) return statusTagInfo;
		const forum = await deps.discord.getChannel(deps.workForumChannelId);
		if (!forum.ok) {
			log.warn("forum tags unavailable", { error: forum.error.type });
			return new Map();
		}
		const found = new Map<WorkStatus, StatusTag>();
		for (const name of WORK_STATUSES) {
			const tag = forum.value.availableTags.find((t) => t.name === name);
			if (tag) found.set(name, { id: tag.id, emoji: tag.emoji ?? null });
			else log.warn("forum tag missing", { tag: name });
		}
		// タグは後からフォーラムに足せるので、欠けている間は覚えずに次も引き直す
		if (found.size === WORK_STATUSES.length) statusTagInfo = found;
		return found;
	};

	const statusTags = async (): Promise<Map<WorkStatus, string>> =>
		new Map([...(await statusTagsOf())].map(([k, t]) => [k, t.id]));

	/** 件名の頭に付けうる状態の絵文字。件名から外すときに使う。 */
	const statusEmojis = async (): Promise<string[]> =>
		[...(await statusTagsOf()).values()].flatMap((t) =>
			t.emoji ? [t.emoji] : [],
		);

	/** モデルのタグ名 → ID。状態のタグと同じく、欠けている間は覚えずに次も引き直す。 */
	const modelTags = async (): Promise<Map<string, string>> => {
		if (modelTagIds) return modelTagIds;
		const forum = await deps.discord.getChannel(deps.workForumChannelId);
		if (!forum.ok) {
			log.warn("forum tags unavailable", { error: forum.error.type });
			return new Map();
		}
		const found = new Map<string, string>();
		for (const name of MODEL_TAGS) {
			const tag = forum.value.availableTags.find((t) => t.name === name);
			if (tag) found.set(name, tag.id);
			else log.warn("forum tag missing", { tag: name });
		}
		if (found.size === MODEL_TAGS.length) modelTagIds = found;
		return found;
	};

	/** bot のリアクションを from から to に付け替える。付いている絵文字を返す。 */
	const react = async (
		bot: DiscordApi,
		request: MessageRef,
		from: string | null,
		to: string | null,
	): Promise<string | null> => {
		if (from === to) return to;
		if (from !== null) {
			const r = await bot.removeReaction(
				request.channelId,
				request.messageId,
				from,
			);
			if (!r.ok) {
				log.warn("remove reaction failed", {
					message_id: request.messageId,
					error: r.error.type,
				});
			}
		}
		if (to === null) return null;
		const r = await bot.addReaction(request.channelId, request.messageId, to);
		if (!r.ok) {
			log.warn("add reaction failed", {
				message_id: request.messageId,
				error: r.error.type,
			});
			return null;
		}
		return to;
	};

	/** 状態の欄を書き換える。内容が同じなら書かず、force でなければ前に書いてから間をおく。 */
	const writePanel = async (seat: Seat, force: boolean): Promise<Seat> => {
		if (seat.panelId === null || seat.label === null) return seat;
		const at = now();
		const text = panelText({
			label: seat.label,
			elapsedMs: seat.labelSince
				? at.getTime() - seat.labelSince.getTime()
				: null,
			doing: seat.lastStatus,
			lent: seat.lend
				? {
						number: seat.lend.number,
						using: seat.lend.mac || seat.lend.requested,
					}
				: null,
		});
		if (text === seat.panelText) return seat;
		if (
			!force &&
			seat.panelAt !== null &&
			at.getTime() - seat.panelAt.getTime() < PANEL_REFRESH_MS
		) {
			return seat;
		}
		const r = await deps.system.editMessage(seat.threadId, seat.panelId, text);
		if (!r.ok) {
			log.warn("panel update failed", {
				thread_id: seat.threadId,
				error: r.error.type,
			});
			return seat;
		}
		return { ...seat, panelText: text, panelAt: at };
	};

	const refreshPanel = async (threadId: string, force: boolean) => {
		const seat = seats.get(threadId);
		if (seat === null) return;
		const next = await writePanel(seat, force);
		if (next !== seat) await seats.set(next);
	};

	/**
	 * 依頼メッセージのリアクションと状態の欄を label に合わせる。
	 * 席を閉じたあとに呼ぶときは、閉じる前の席を gone に渡す。
	 */
	const show = async (threadId: string, label: SeatLabel, gone?: Seat) => {
		const seat = seats.get(threadId) ?? gone ?? null;
		if (seat === null || seat.standup) return;
		const reaction = seat.request
			? await react(
					botOf(threadId),
					seat.request,
					seat.reaction,
					REACTION_OF[label],
				)
			: seat.reaction;
		const next = await writePanel(
			{
				...seat,
				reaction,
				label,
				labelSince: seat.label === label ? seat.labelSince : now(),
			},
			true,
		);
		if (seats.get(threadId) !== null) await seats.set(next);
	};

	/** 投稿の先頭近くに状態の欄を置く。 */
	const placePanel = async (seat: Seat): Promise<Seat> => {
		if (seat.standup || seat.panelId !== null) return seat;
		const text = panelText({ label: "受付", elapsedMs: null, doing: null });
		const r = await deps.system.createMessage(seat.threadId, text);
		if (!r.ok) {
			log.warn("panel post failed", {
				thread_id: seat.threadId,
				error: r.error.type,
			});
			return seat;
		}
		return {
			...seat,
			panelId: r.value.id,
			panelText: text,
			panelAt: now(),
			label: "受付",
			labelSince: now(),
		};
	};

	/** 持ち主の新しい依頼メッセージに受付の絵文字を移す。 */
	const receive = async (seat: Seat, from: MessageRef): Promise<Seat> => {
		if (seat.standup || seat.request?.messageId === from.messageId) {
			return seat;
		}
		const bot = botOf(seat.threadId);
		if (seat.request && seat.reaction) {
			await react(bot, seat.request, seat.reaction, null);
		}
		const reaction = await react(bot, from, null, REACTION_OF.受付);
		const next = { ...seat, request: from, reaction };
		await seats.set(next);
		return next;
	};

	/**
	 * title が false なら件名は変えない。件名の変更は投稿にシステムメッセージを残すので、
	 * 続きが来るかもしれない残している席は、閉じるまで完了の絵文字を付けない。
	 */
	const setStatus = async (
		threadId: string,
		status: WorkStatus,
		gone?: Seat,
		{ title = true }: { title?: boolean } = {},
	) => {
		await show(threadId, status, gone);
		const tags = await statusTags();
		const thread = await deps.discord.getChannel(threadId);
		if (!thread.ok) {
			log.warn("thread lookup failed", { thread_id: threadId });
			return;
		}
		const next = replaceStatusTag(thread.value.appliedTagIds, tags, status);
		const same =
			next.length === thread.value.appliedTagIds.length &&
			next.every((id) => thread.value.appliedTagIds.includes(id));
		if (!same) {
			const r = await botOf(threadId).setTags(threadId, next);
			if (!r.ok) {
				log.warn("set tags failed", {
					thread_id: threadId,
					error: r.error.type,
				});
			}
		}
		if (thread.value.name === null || !title) return;
		const info = await statusTagsOf();
		if (status !== "作業中") {
			await retitle(
				threadId,
				thread.value.name,
				info.get(status)?.emoji ?? null,
			);
			return;
		}
		// 作業中は決めてほしいと返事のたびに行き来するので、🤔 は残して名前の変更の枠を使わない。
		// 完了と見張り中の絵文字だけは、また動き出したのに終わったように見えるので外す。
		// 制限で付けられずに待っている件名があれば、それがこれから付く件名なのでそちらで見る
		const finished = new Set(
			(["完了", "見張り中"] as const).flatMap((s) => {
				const e = info.get(s)?.emoji;
				return e ? [e] : [];
			}),
		);
		const shown = parseTitle(
			deps.seats.pendingTitleOf(threadId) ?? thread.value.name,
			await statusEmojis(),
		);
		if (shown.emoji !== null && finished.has(shown.emoji)) {
			await retitle(threadId, thread.value.name, null);
		}
	};

	/** 件名の変更の制限が解けるのを待っている投稿。 */
	const titleWaits = new Set<string>();

	/**
	 * 覚えた付けたい件名を投稿に付ける。今の件名と同じなら呼ばない。
	 * 名前の変更の制限に当たったら、解けるのを待ってから、その時に覚えている最後の件名だけを付ける。
	 */
	const applyTitle = async (threadId: string, current: string | null) => {
		if (titleWaits.has(threadId)) return;
		const want = deps.seats.pendingTitleOf(threadId);
		if (want === null) return;
		if (current === want) {
			await deps.seats.setPendingTitle(threadId, null);
			return;
		}
		const r = await botOf(threadId).renameThread(threadId, want);
		if (r.ok) {
			if (deps.seats.pendingTitleOf(threadId) === want) {
				await deps.seats.setPendingTitle(threadId, null);
			}
			return;
		}
		if (r.error.type === "RateLimited") {
			const waitMs = r.error.retryAfterMs ?? RENAME_WINDOW_MS;
			log.warn("thread rename rate limited; retry later", {
				thread_id: threadId,
				retry_after_ms: waitMs,
			});
			titleWaits.add(threadId);
			after(waitMs, () => {
				titleWaits.delete(threadId);
				void queue.run(threadId, async () => {
					const ch = await deps.discord.getChannel(threadId);
					await applyTitle(threadId, ch.ok ? ch.value.name : null);
				});
			});
			return;
		}
		log.warn("thread rename failed", {
			thread_id: threadId,
			error: r.error.type,
		});
		await deps.seats.setPendingTitle(threadId, null);
	};

	/** 件名の頭の状態の絵文字を emoji に替える。null なら絵文字を外す。 */
	const retitle = async (
		threadId: string,
		name: string,
		emoji: string | null,
	) => {
		const t = parseTitle(name, await statusEmojis());
		const want = composeTitle(
			emoji,
			t.number ?? deps.seats.numberOf(threadId),
			t.base,
		);
		await deps.seats.setPendingTitle(threadId, want);
		await applyTitle(threadId, name);
	};

	const setModelTag = async (threadId: string, model: string) => {
		const tags = await modelTags();
		const thread = await deps.discord.getChannel(threadId);
		if (!thread.ok) {
			log.warn("thread lookup failed", { thread_id: threadId });
			return;
		}
		const next = replaceModelTag(thread.value.appliedTagIds, tags, model);
		const same =
			next.length === thread.value.appliedTagIds.length &&
			next.every((id) => thread.value.appliedTagIds.includes(id));
		if (same) return;
		const r = await botOf(threadId).setTags(threadId, next);
		if (!r.ok) {
			log.warn("set tags failed", { thread_id: threadId, error: r.error.type });
		}
	};

	/** モデルを変えたことを投稿に 1 行残し、モデルのタグを差し替える。 */
	const announceModel = async (
		threadId: string,
		by: string,
		from: string | null,
		to: string,
	) => {
		const sent = await deps.system.send(
			threadId,
			modelChangedText(by, from, to),
		);
		if (!sent.ok) {
			log.warn("model change post failed", {
				thread_id: threadId,
				error: sent.error.type,
			});
		}
		await setModelTag(threadId, to);
		log.info("seat model changed", { thread_id: threadId, from, to });
	};

	/** 投稿の件名。頭の hishaku の番号は外す。 */
	const titleOf = async (threadId: string): Promise<string | null> => {
		const ch = await deps.discord.getChannel(threadId);
		return ch.ok && ch.value.name !== null
			? unnumberedTitle(ch.value.name, await statusEmojis())
			: null;
	};

	/**
	 * 投稿の hishaku の番号を取り、件名の頭に付ける。番号はスレッドの ID を post_id にして払い出すので、投稿を立てた後に取る。
	 * Manager に届かなければ番号なしで進め、席は手元の会話だけで動く。
	 */
	const ensureNumber = async (
		threadId: string,
		repo: string | null,
	): Promise<number | null> => {
		const hishaku = deps.hishaku;
		if (!hishaku) return null;
		const known = deps.seats.numberOf(threadId);
		if (known !== null) return known;
		const ch = await deps.discord.getChannel(threadId);
		const name = (ch.ok ? ch.value.name : null) ?? "";
		const created = await hishaku.createSession({
			postId: threadId,
			agent: agentOf(partnerOf(threadId)),
			title: unnumberedTitle(name, await statusEmojis()) || threadId,
			repo,
			branch: null,
		});
		if (!created.ok) {
			log.warn("hishaku session unavailable; seat runs without it", {
				thread_id: threadId,
				reason: created.error.reason,
			});
			return null;
		}
		const { number } = created.value;
		await deps.seats.setNumber(threadId, number);
		if (ch.ok && name !== "") {
			// 先に覚えた付けたい件名（状態の絵文字）があれば、それに番号を足す
			const emojis = await statusEmojis();
			const named = numberedTitle(
				number,
				deps.seats.pendingTitleOf(threadId) ?? name,
				emojis,
			);
			await deps.seats.setPendingTitle(threadId, named);
			await applyTitle(threadId, name);
		}
		log.info("hishaku session numbered", { thread_id: threadId, number });
		return number;
	};

	/**
	 * 席を起こす前に hishaku のセッションを借りる。持ち主が自分（前の受付が返さずに落ちた）なら取り直す。
	 * takeover なら持ち主が Mac から取り戻すと決めたので、初めから奪う。
	 */
	const prepareSession = async (
		number: number,
		cwd: string,
		takeover: boolean,
	) => {
		const hishaku = deps.hishaku;
		if (!hishaku) return null;
		if (takeover) return hishaku.prepare({ number, cwd, takeover: true });
		const r = await hishaku.prepare({ number, cwd });
		if (
			!r.ok &&
			r.error.type === "LeaseHeld" &&
			r.error.holder === hishaku.holder
		) {
			return hishaku.prepare({ number, cwd, takeover: true });
		}
		return r;
	};

	/**
	 * 止めた席の会話を Manager に預け、貸し出しを返す。agent が止まってから呼ぶ。
	 * 預けて返せたら true。席が借りていなければ false。
	 */
	const releaseSession = async (
		seat: Seat,
	): Promise<{ seat: Seat; released: boolean }> => {
		const hishaku = deps.hishaku;
		const number = deps.seats.numberOf(seat.threadId);
		if (!hishaku || seat.lease === null || number === null || !seat.path) {
			return { seat, released: false };
		}
		if (deps.findWorkBranches) {
			await recordWorkBranchQuietly({
				hishaku,
				number,
				dir: seat.path,
				find: deps.findWorkBranches,
				log,
				threadId: seat.threadId,
			});
		}
		const r = await hishaku.push({
			number,
			generation: seat.lease,
			cwd: seat.path,
			release: true,
		});
		const next = { ...seat, lease: null };
		if (r.ok) {
			log.info("hishaku session released", {
				thread_id: seat.threadId,
				number,
			});
			return { seat: next, released: true };
		}
		if (r.error.type === "LeaseStolen") {
			log.warn("hishaku lease was taken", { thread_id: seat.threadId, number });
			if (!seat.standup) await sendTo(seat.threadId, LEASE_STOLEN_TEXT);
		} else {
			log.warn("hishaku push failed", {
				thread_id: seat.threadId,
				number,
				reason: r.error.reason,
			});
		}
		return { seat: next, released: false };
	};

	/** mizuya の bot で投稿に書く。貸し出しの知らせはシステムの介入なので担当の bot では書かない。 */
	const postSystem = async (
		threadId: string,
		content: string,
		buttons: readonly Button[] = [],
	) => {
		const sent = await deps.system.send(
			threadId,
			content,
			undefined,
			[],
			buttons,
		);
		if (!sent.ok) {
			log.warn("lend post failed", {
				thread_id: threadId,
				error: sent.error.type,
			});
		}
		return sent;
	};
	/** ボタン付きで書いたメッセージを貸し出しに残す。受付が作り直されても、貸し出しが終わったら外せる。 */
	const rememberButtons = async (
		threadId: string,
		key: "buttons" | "confirms",
		sent: Awaited<ReturnType<typeof postSystem>>,
	) => {
		// ボタンは分けて送った最後の 1 件に付く
		const id = sent.ok ? sent.value.messageIds.at(-1) : undefined;
		const seat = seats.get(threadId);
		if (id === undefined || seat?.lend == null) return;
		await seats.set({
			...seat,
			lend: { ...seat.lend, [key]: [...seat.lend[key], id] },
		});
	};
	const postTakeback = async (threadId: string, content: string) =>
		rememberButtons(
			threadId,
			"buttons",
			await postSystem(threadId, content, [TAKEBACK_BUTTON]),
		);

	/** 貸し出しで出したメッセージからボタンを外す。本文は残す。外せなくても流れは止めない。 */
	const clearButtons = async (threadId: string, ids: readonly string[]) => {
		for (const id of ids) {
			const current = await deps.system.getMessage(threadId, id);
			const edited = current.ok
				? await deps.system.editMessage(threadId, id, current.value.content)
				: current;
			if (!edited.ok) {
				log.warn("lend button removal failed", {
					thread_id: threadId,
					message_id: id,
					error: edited.error.type,
				});
			}
		}
	};
	const clearLendButtons = (seat: Seat, except?: string) =>
		seat.lend
			? clearButtons(
					seat.threadId,
					[...seat.lend.buttons, ...seat.lend.confirms].filter(
						(id) => id !== except,
					),
				)
			: Promise.resolve();

	/**
	 * 会話を Manager に預けて Mac に貸している席。agent は止めてあり、worktree は消してある。
	 * 投稿への書き込みは pending に溜める。
	 */
	const lentSeat = (
		seat: Seat,
		number: number,
		generation: number | null,
		requested = false,
	): Seat => ({
		...seat,
		status: "lent",
		path: null,
		terminal: null,
		dispatchId: null,
		questionId: null,
		expectStop: false,
		waitingSince: null,
		doneAt: null,
		doneStatus: null,
		pending: [],
		queuedAt: null,
		background: false,
		lastStatus: null,
		lease: null,
		continuation: null,
		releaseRequested: null,
		takeback: null,
		lend: {
			number,
			savedAt: now(),
			generation,
			mac: false,
			requested,
			buttons: [],
			confirms: [],
		},
	});

	/** 他の機械（Mac）が今の貸し出しを持っている。期限が切れていれば持っていないとみなす。 */
	const macHolds = (meta: SessionMeta) =>
		meta.holder !== null &&
		meta.holder !== deps.hishaku?.holder &&
		meta.leaseExpiresAt !== null &&
		meta.leaseExpiresAt.getTime() > now().getTime();

	const parentIdOf = async (channelId: string): Promise<string | null> => {
		const cached = parentOf.get(channelId);
		if (cached !== undefined) return cached;
		const ch = await deps.discord.getChannel(channelId);
		if (!ch.ok) return null;
		parentOf.set(channelId, ch.value.parentId);
		return ch.value.parentId;
	};

	/**
	 * 仕事チャンネルの依頼の宛先。Akarin へのメンションがあれば Akarin、Yukarin か mizuya の bot へのメンションがあれば Yukarin。
	 * メンションが無ければ、返信した先のメッセージを書いた席にする。
	 */
	const addresseeOf = async (p: Payload): Promise<PartnerId | null> => {
		if (deps.akarin && mentionsPartner(p, "akarin")) return "akarin";
		if (
			mentionsPartner(p, "yukarin") ||
			p.mentions.includes(deps.systemUserId)
		) {
			return "yukarin";
		}
		if (!p.reply_to_message_id) return null;
		const replied = await deps.discord.getMessage(
			p.channel_id,
			p.reply_to_message_id,
		);
		if (!replied.ok) return null;
		const by = spokenBy(replied.value);
		return by === "akarin" && !deps.akarin ? "yukarin" : by;
	};

	const alive = () => seats.all().filter((s) => ALIVE.has(s.status));

	/** 許可したのに使われなかった操作は、その回かぎりで失効させる。 */
	const expireGrant = (threadId: string) => {
		const grant = deps.ledger.takeGrant(threadId);
		if (grant === null) return;
		const used = deps.ledger.used(grant.grant_id);
		const unused = grant.operations.filter(
			(g) => !used.some((u) => u.tool === g.tool && u.target === g.target),
		);
		deps.ledger.clearUsed(grant.grant_id);
		if (unused.length === 0) return;
		deps.ledger.log({
			event: "expired",
			thread_id: threadId,
			grant_id: grant.grant_id,
			operations: unused,
		});
		log.info("approval expired unused", {
			thread_id: threadId,
			operations: unused,
		});
	};

	const record = async (
		threadId: string,
		kind: ActivityKind,
		tools: string[],
		knownTitle?: string,
	) => {
		if (!deps.recordActivity) return;
		const title =
			knownTitle ?? (await titleOf(threadId)) ?? "仕事フォーラムの投稿";
		await deps
			.recordActivity({
				at: now(),
				kind,
				threadId,
				title,
				partner: partnerOf(threadId),
				tools,
			})
			.catch((e: unknown) =>
				log.warn("activity record failed", { error: String(e) }),
			);
	};

	/** 席の発言のすぐ後に、mizuya の bot で許可や不要のボタンを出す。押した操作は mizuya の Worker に届く。 */
	const postButtons = async (
		threadId: string,
		approval: boolean,
		dismiss: boolean,
	) => {
		const m = buttonMessage({ approval, dismiss });
		const sent = await deps.system.send(
			threadId,
			m.content,
			undefined,
			[],
			m.buttons,
		);
		if (!sent.ok) {
			log.error("buttons post failed", {
				thread_id: threadId,
				error: sent.error.type,
			});
		}
		return sent;
	};

	/**
	 * hook が止めた操作を投稿に書き、許可を待つ。lead は同じメッセージの頭に置く文。
	 * waiting なら持ち主の判断を待つ投稿なので、席を通さずに閉じるボタンも付ける。
	 */
	const postWithApproval = async (
		threadId: string,
		lead: string,
		blocked: readonly Pending[],
		files: readonly Attachment[] = [],
		waiting = false,
	) => {
		if (blocked.length === 0) {
			if (lead.trim() === "" && files.length === 0) return;
			const sent = await sendTo(threadId, lead, files);
			if (!sent.ok) {
				log.error("post failed", {
					thread_id: threadId,
					error: sent.error.type,
				});
				return;
			}
			if (waiting) await postButtons(threadId, false, true);
			return;
		}
		const request = approvalRequestText(blocked);
		const sent = await sendTo(
			threadId,
			lead.trim() === "" ? request : `${lead}\n\n${request}`,
			files,
		);
		if (!sent.ok) {
			log.error("approval request failed", {
				thread_id: threadId,
				error: sent.error.type,
			});
			return;
		}
		// ボタンが出せなくても、返事の OK で許可できるよう依頼は残す
		const buttons = await postButtons(threadId, true, waiting);
		const operations = blocked.map((b) => b.operation);
		await record(
			threadId,
			"blocked",
			operations.map((o) => o.tool),
		);
		await deps.approvals.set(threadId, {
			messageIds: [
				...sent.value.messageIds,
				...(buttons.ok ? buttons.value.messageIds : []),
			],
			operations,
		});
		deps.ledger.log({
			event: "requested",
			thread_id: threadId,
			message_id: sent.value.messageIds[0] ?? "",
			operations,
		});
		log.info("approval requested", { thread_id: threadId, operations });
	};

	/** 空いた席の数だけ、順番待ちの投稿を始める。 */
	const dequeue = () => {
		const free = deps.seatLimit - alive().length;
		if (free <= 0) return;
		const waiting = seats
			.all()
			.filter((s) => s.status === "queued")
			.sort(
				(a, b) => (a.queuedAt?.getTime() ?? 0) - (b.queuedAt?.getTime() ?? 0),
			)
			.slice(0, free);
		for (const s of waiting) {
			void queue.run(s.threadId, async () => {
				const seat = seats.get(s.threadId);
				if (seat?.status !== "queued") return;
				if (alive().length >= deps.seatLimit) return;
				await launch(seat);
			});
		}
	};

	/** 投稿のやりとりを読ませる依頼文。前の会話が無い席を作り直すときに渡す。 */
	const historyText = async (threadId: string) => {
		const [history, title] = await Promise.all([
			deps.discord.listMessages(threadId, HISTORY_LIMIT),
			titleOf(threadId),
		]);
		return historyPrompt({
			now: now(),
			title,
			history: history.ok ? history.value : [],
			isSelf: (m) => m.authorId === speaker(partnerOf(threadId)).botUserId,
		});
	};

	/** 席に Claude を座らせ、溜まっている言葉を渡す。worktree があれば前の会話のまま起こす。 */
	const launch = async (seat: Seat) => {
		const threadId = seat.threadId;
		// 朝会・見回り・GitHub の出来事の席は Discord の投稿を持たず、ID はチャンネルではない
		const title = seat.standup
			? threadId
			: ((await titleOf(threadId)) ?? threadId);
		const text = seat.pending.join("\n\n---\n\n");
		const partner = partnerOf(threadId);
		const agent = agentOf(partner);
		const model = deps.seats.modelOf(threadId);
		const number = seat.standup ? null : deps.seats.numberOf(threadId);
		const noted = number === null ? text : `${numberNote(number)}\n\n${text}`;
		let lease: number | null = null;
		const fallback: SeatHow = seat.path ? "resume" : "start";
		const prepare: SeatPrepare | undefined =
			number === null || !deps.hishaku
				? undefined
				: async (cwd) => {
						const r = await prepareSession(number, cwd, seat.takeback !== null);
						if (r === null) return ok({ how: fallback });
						if (!r.ok) {
							if (r.error.type === "LeaseHeld") {
								return err({ holder: r.error.holder });
							}
							log.warn("hishaku prepare failed; seat runs without it", {
								thread_id: threadId,
								number,
								reason: r.error.reason,
							});
							return ok({ how: fallback });
						}
						lease = r.value.generation;
						// 正本が無いのに worktree の会話が残っている席は、新しい ID で始めずに手元の会話を続ける
						if (!r.value.resume && seat.path) return ok({ how: fallback });
						const how: SeatHow = {
							sessionId: r.value.sessionId,
							resume: r.value.resume,
						};
						// 前の会話が続くなら、やりとりを読ませる依頼文の代わりに新しい言葉だけを渡す
						if (r.value.resume && seat.continuation && !seat.path) {
							return ok({
								how,
								spec: `${numberNote(number)}\n\n${seat.continuation.join("\n\n---\n\n")}`,
							});
						}
						return ok({ how });
					};
		const r = seat.path
			? await deps.orca.resumeSeat({
					path: seat.path,
					title,
					spec: text,
					agent,
					model,
					prepare,
				})
			: await deps.orca.startSeat({
					name: seatNameOf(threadId),
					title,
					spec: seatSpec(speaker(partner).preamble, noted),
					agent,
					model,
					prepare,
				});
		if (!r.ok && r.error.type === "SeatWorktreeMissing" && !seat.standup) {
			// 前の会話は worktree ごと失われたので、席を忘れてやりとりを読ませた新しい席で始める。
			// 止めた席のまま残すと、返事のたびに同じ失敗を繰り返して投稿が動かなくなる
			log.warn("seat worktree missing", { thread_id: threadId });
			await seats.delete(threadId);
			await openSeat(
				{
					...newSeat(threadId),
					request: seat.request,
					reaction: seat.reaction,
					panelId: seat.panelId,
					panelText: seat.panelText,
					panelAt: seat.panelAt,
					label: seat.label,
					labelSince: seat.labelSince,
					model: seat.model,
					modelChange: seat.modelChange,
					continuation: seat.pending,
				},
				await historyText(threadId),
			);
			return;
		}
		// 借りるのは番号のある投稿の席だけなので、借りられなかったのは Mac が開いているとき
		if (!r.ok && r.error.type === "SeatLeaseHeld" && number !== null) {
			log.warn("hishaku session held elsewhere", {
				thread_id: threadId,
				holder: r.error.reason,
			});
			// 書かれたことは溜めて、Mac が返したら渡す。worktree の会話は残し、戻ったらそのまま起こす
			await seats.set({
				...lentSeat(seat, number, null),
				path: seat.path,
				pending: seat.continuation ?? seat.pending,
				lend: {
					number,
					savedAt: null,
					generation: null,
					mac: true,
					requested: false,
					buttons: [],
					confirms: [],
				},
			});
			await postTakeback(threadId, heldText(number));
			await setStatus(threadId, "引き継ぎ");
			dequeue();
			return;
		}
		if (!r.ok) {
			log.error("seat start failed", {
				thread_id: threadId,
				reason: r.error.reason,
			});
			// 前の会話を残せる席は止めた席に戻し、次の返事でもう一度起こす
			if (seat.path) {
				await seats.set({ ...seat, status: "sleeping", pending: [] });
			} else {
				await seats.delete(threadId);
			}
			if (!seat.standup) {
				await sendTo(threadId, seatStartFailedText(r.error));
				await setStatus(threadId, "決めてほしい", seat);
			}
			return;
		}
		await seats.set({
			...seat,
			status: "working",
			path: r.value.path,
			terminal: r.value.terminal,
			dispatchId: r.value.dispatchId,
			dispatchIds: [...seat.dispatchIds, r.value.dispatchId],
			questionId: null,
			question: null,
			expectStop: false,
			waitingSince: null,
			doneAt: null,
			doneStatus: null,
			pending: [],
			queuedAt: null,
			background: false,
			lastStatus: null,
			model,
			modelChange: null,
			lease,
			continuation: null,
			lend: null,
			releaseRequested: null,
			takeback: null,
		});
		if (seat.takeback && lease !== null && !seat.standup) {
			await postSystem(threadId, takenBackText(lease));
			await sendTo(threadId, backFromMacText(seat.takeback.pushedAt));
		}
		// 作業中に頼まれた切り替えは、起こし直したこの起動で効いた
		if (seat.modelChange && model !== null && model !== seat.model) {
			await announceModel(threadId, seat.modelChange.by, seat.model, model);
		}
		log.info("seat working", {
			thread_id: threadId,
			dispatch_id: r.value.dispatchId,
			resumed: seat.path !== null,
		});
		if (!seat.standup) await setStatus(threadId, "作業中");
	};

	/** 席を作るか、上限なら順番待ちにする。repo は分かれば hishaku の番号の meta に残す。 */
	const openSeat = async (
		seat: Seat,
		text: string,
		repo: string | null = null,
	) => {
		if (!seat.standup) await ensureNumber(seat.threadId, repo);
		const reaction =
			seat.request && !seat.standup
				? await react(
						botOf(seat.threadId),
						seat.request,
						seat.reaction,
						REACTION_OF.受付,
					)
				: seat.reaction;
		const next = await placePanel({
			...seat,
			reaction,
			pending: [...seat.pending, text],
		});
		if (!seat.standup) await makeRoom(seat.threadId);
		if (!seat.standup && alive().length >= deps.seatLimit) {
			await seats.set({ ...next, status: "queued", queuedAt: now() });
			log.info("seat queued", { thread_id: seat.threadId });
			await sendTo(seat.threadId, QUEUED_TEXT);
			return;
		}
		await launch(next);
	};

	/**
	 * 席の Claude を止め、会話を hishaku に預けてから worktree を消して対応を忘れる。
	 * 預けて貸し出しを返せたら true。
	 */
	const closeSeat = async (seat: Seat): Promise<boolean> => {
		await clearLendButtons(seat);
		const stopped = await deps.orca.stopSeat(seat);
		if (!stopped.ok) {
			log.error("seat stop failed", {
				thread_id: seat.threadId,
				reason: stopped.error.reason,
			});
		}
		const { released } = await releaseSession(seat);
		if (seat.path) {
			const removed = await deps.orca.removeWorktree(seat.path);
			if (!removed.ok) {
				log.error("seat worktree remove failed", {
					thread_id: seat.threadId,
					reason: removed.error.reason,
				});
			}
		}
		await seats.delete(seat.threadId);
		log.info("seat closed", { thread_id: seat.threadId });
		dequeue();
		return released;
	};

	/** 残していた席を閉じる。閉じて終わりが決まったので、ここで件名を終えたときの状態の絵文字にする。 */
	const closeDone = async (seat: Seat): Promise<boolean> => {
		if (seat.doneStatus !== null) {
			const thread = await deps.discord.getChannel(seat.threadId);
			if (thread.ok && thread.value.name !== null) {
				const info = await statusTagsOf();
				await retitle(
					seat.threadId,
					thread.value.name,
					info.get(seat.doneStatus)?.emoji ?? null,
				);
			}
		}
		return closeSeat(seat);
	};

	/** 完了したあと残している、Claude が動いたままの席。 */
	const lingering = () =>
		seats.all().filter((s) => s.doneAt !== null && s.status === "waiting");

	/**
	 * 席が上限まで埋まっていれば、完了したあと残している席を古い順に閉じて空ける。
	 * 残している席は続きが来るかもしれないだけなので、新しい仕事を順番待ちにしてまで残さない。
	 */
	const makeRoom = async (self: string) => {
		while (alive().length >= deps.seatLimit) {
			const [oldest] = lingering()
				.filter((s) => s.threadId !== self)
				.sort(
					(a, b) => (a.doneAt?.getTime() ?? 0) - (b.doneAt?.getTime() ?? 0),
				);
			if (oldest === undefined) return;
			await queue.run(oldest.threadId, async () => {
				const seat = seats.get(oldest.threadId);
				if (seat?.doneAt == null || seat.status !== "waiting") return;
				log.info("lingering seat closed for room", {
					thread_id: seat.threadId,
					for: self,
				});
				await closeDone(seat);
			});
		}
	};

	/** 席の返事から添付の行を外し、ファイルを集める。 */
	const seatReply = async (seat: Seat, text: string) => {
		const { body, refs } = takeAttachRefs(text);
		const got = await deps.collectAttachments(seat.path, refs);
		return { text: body, body: withNote(body, got.note), files: got.files };
	};

	const toWaiting = (
		seat: Seat,
		ask: { id: string; text: string } | null,
	): Seat => ({
		...seat,
		status: ask ? "asking" : "waiting",
		questionId: ask?.id ?? null,
		question: ask?.text ?? seat.question,
		expectStop: ask !== null,
		waitingSince: now(),
		doneAt: null,
		doneStatus: null,
		background: false,
		lastStatus: null,
	});

	/** 持ち主の言葉を席に渡す。席の状態で渡し方が変わる。 */
	const deliver = async (
		threadId: string,
		text: string,
		granted: readonly Operation[] | null,
		from: MessageRef,
	) => {
		const stored = seats.get(threadId);
		if (stored === null) {
			// 席が無い（完了したあと、朝会の投稿、作れなかった）ときは、やりとりを読ませて新しい席を作る
			// 前の会話を hishaku から続けられれば、やりとりの代わりにこの言葉だけを渡す
			const prompt = await historyText(threadId);
			const note = granted ? `\n\n${approvedNote(granted)}` : "";
			await openSeat(
				{
					...newSeat(threadId),
					request: from,
					continuation: [`${text}${note}`],
				},
				`${prompt}${note}`,
			);
			return;
		}
		const seat = await receive(stored, from);
		switch (seat.status) {
			case "queued":
				await seats.set({
					...seat,
					pending: [...seat.pending, text],
					continuation: seat.continuation && [...seat.continuation, text],
				});
				return;
			case "sleeping": {
				const woke = {
					...seat,
					pending: [`${wakeNote(seat.question)}\n\n${text}`],
				};
				await makeRoom(threadId);
				if (alive().length >= deps.seatLimit) {
					await seats.set({ ...woke, status: "queued", queuedAt: now() });
					await show(threadId, "受付");
					await sendTo(threadId, QUEUED_TEXT);
					return;
				}
				await launch(woke);
				return;
			}
			case "asking":
				if (seat.questionId) {
					const r = await deps.orca.reply({
						messageId: seat.questionId,
						body: text,
					});
					if (r.ok) {
						await seats.set({
							...seat,
							status: "working",
							questionId: null,
							waitingSince: null,
						});
						await setStatus(threadId, "作業中");
						return;
					}
					log.warn("seat reply failed; sending instead", {
						thread_id: threadId,
						reason: r.error.reason,
					});
				}
				break;
			case "lent": {
				// Mac が返すまで席に渡さない
				await seats.set({ ...seat, pending: [...seat.pending, text] });
				await postTakeback(
					threadId,
					heldText(seat.lend?.number ?? deps.seats.numberOf(threadId) ?? 0),
				);
				return;
			}
			case "working":
			case "waiting":
				break;
		}
		if (seat.dispatchId === null) return;
		// 裏の作業を待つ席は、手が空くまで返事をしないことがある。受付が先に作業中だと返す
		if (seat.status === "working" && seat.background) {
			const busy = await sendTo(threadId, busyText(seat.lastStatus));
			if (!busy.ok) {
				log.warn("busy reply failed", {
					thread_id: threadId,
					error: busy.error.type,
				});
			}
		}
		const sent = await deps.orca.send({
			dispatchId: seat.dispatchId,
			subject: "持ち主の返事",
			body:
				seat.status === "working" && seat.background
					? `${backgroundReplyNote}\n\n${text}`
					: text,
		});
		if (!sent.ok) {
			log.error("seat send failed", {
				thread_id: threadId,
				reason: sent.error.reason,
			});
			await sendTo(threadId, FAILURE_TEXT);
			return;
		}
		await seats.set({
			...seat,
			status: "working",
			terminal: sent.value.terminal ?? seat.terminal,
			dispatchId: sent.value.dispatchId,
			dispatchIds: seat.dispatchIds.includes(sent.value.dispatchId)
				? seat.dispatchIds
				: [...seat.dispatchIds, sent.value.dispatchId],
			questionId: null,
			waitingSince: null,
			doneAt: null,
			doneStatus: null,
		});
		await setStatus(threadId, "作業中");
	};

	/**
	 * 手を止めた席に、作業中に頼まれたモデルの切り替えを効かせる。
	 * Claude は端末に /model を送って会話のまま切り替える。Codex は動いたまま切り替えられないので止め、
	 * 次の返事で `codex resume --last -m` で起こす。切り替えられなければ、次に手が止まったときにやり直す。
	 */
	const applyModelChange = async (threadId: string) => {
		const seat = seats.get(threadId);
		if (seat?.modelChange == null) return;
		const to = deps.seats.modelOf(threadId);
		if (to === null || to === seat.model) {
			await seats.set({ ...seat, modelChange: null });
			return;
		}
		let next: Seat;
		if (agentOf(partnerOf(threadId)) === "claude" && seat.terminal) {
			const r = await deps.orca.switchModel({
				terminal: seat.terminal,
				model: to,
			});
			if (!r.ok) {
				log.error("seat model switch failed", {
					thread_id: threadId,
					reason: r.error.reason,
				});
				return;
			}
			next = { ...seat, model: to, modelChange: null };
		} else {
			const stopped = await deps.orca.stopSeat(seat);
			if (!stopped.ok) {
				log.error("seat model switch failed", {
					thread_id: threadId,
					reason: stopped.error.reason,
				});
				return;
			}
			const released = await releaseSession(seat);
			// 前の会話は残っているので、次の返事で選ばれたモデルのまま起こす
			next = {
				...released.seat,
				status: "sleeping",
				terminal: null,
				questionId: null,
				expectStop: false,
				background: false,
				model: to,
				modelChange: null,
			};
		}
		await seats.set(next);
		await announceModel(threadId, seat.modelChange.by, seat.model, to);
		if (next.status === "sleeping") dequeue();
	};

	const onQuestion = async (seat: Seat, msg: SeatMessage) => {
		const threadId = seat.threadId;
		if (seat.standup) {
			await deps.orca.reply({ messageId: msg.id, body: STANDUP_NO_ASK });
			return;
		}
		expireGrant(threadId);
		const blocked = uniquePending(deps.ledger.takePending(threadId));
		const reply = await seatReply(seat, msg.body);
		await postWithApproval(threadId, reply.body, blocked, reply.files, true);
		await seats.set(toWaiting(seat, { id: msg.id, text: reply.body }));
		await setStatus(threadId, "決めてほしい");
		await applyModelChange(threadId);
		log.info("seat asked", { thread_id: threadId, blocked: blocked.length });
		await lendIfRequested(threadId);
	};

	const onDone = async (seat: Seat, msg: SeatMessage) => {
		const threadId = seat.threadId;
		expireGrant(threadId);
		const blocked = uniquePending(deps.ledger.takePending(threadId));
		if (seat.standup) {
			await deps.standupDone(
				msg.body,
				blocked,
				runKindOf(seat),
				partnerOf(threadId),
			);
			await closeSeat(seat);
			return;
		}
		// 状態の行は添付の行を外したあとの最後の行。付けられなかった知らせはその後ろに足す
		const { body, refs } = takeAttachRefs(msg.body);
		const taken = takeStatus(body);
		const got = await deps.collectAttachments(seat.path, refs);
		const reply = { body: withNote(taken.body, got.note), files: got.files };
		// 止めた操作があれば、Claude の書いた状態によらず持ち主の判断を待つ
		if (
			blocked.length > 0 ||
			msg.outcome === "failed" ||
			taken.status === "決めてほしい"
		) {
			await postWithApproval(threadId, reply.body, blocked, reply.files, true);
			await seats.set({ ...toWaiting(seat, null), expectStop: false });
			await setStatus(threadId, "決めてほしい");
			await applyModelChange(threadId);
			log.info("seat waiting", {
				thread_id: threadId,
				blocked: blocked.length,
			});
			await lendIfRequested(threadId);
			return;
		}
		if (taken.status === "引き継ぎ") {
			await handOff(seat, reply);
			return;
		}
		await postWithApproval(threadId, reply.body, [], reply.files);
		// 順番待ちの投稿があれば、残さずに閉じて席を譲る
		const linger = !seats.all().some((s) => s.status === "queued");
		if (linger) {
			await seats.set({
				...toWaiting(seat, null),
				expectStop: false,
				doneAt: now(),
				doneStatus:
					taken.status === "完了" || taken.status === "見張り中"
						? taken.status
						: null,
			});
		}
		await setStatus(threadId, taken.status, undefined, { title: !linger });
		const title = (await titleOf(threadId)) ?? "仕事フォーラムの投稿";
		await deps.remember(
			taken.status === "完了"
				? `仕事フォーラムの「${title}」を終えた`
				: `仕事フォーラムの「${title}」で見張りを始めた`,
			partnerOf(threadId),
		);
		await record(threadId, "done", [], title);
		if (linger) {
			await applyModelChange(threadId);
			log.info("seat done; lingering", {
				thread_id: threadId,
				status: taken.status,
			});
			await lendIfRequested(threadId);
			return;
		}
		await closeSeat(seat);
		// 席は閉じたが、選ばれたモデルは投稿に残り、次に開く席がそれで動く
		const chosen = deps.seats.modelOf(threadId);
		if (seat.modelChange && chosen !== null && chosen !== seat.model) {
			await announceModel(threadId, seat.modelChange.by, seat.model, chosen);
		}
		log.info("seat done", { thread_id: threadId, status: taken.status });
	};

	/**
	 * Mac への引き継ぎで席を閉じる。会話を Manager に預けて貸し出しを返してから返事を書き、
	 * 預けられたときだけ返事に `hs open <番号>` を付け、状態の欄を貸し出し待ちにする。
	 */
	const handOff = async (
		seat: Seat,
		reply: { body: string; files: Attachment[] },
	) => {
		const threadId = seat.threadId;
		const number = deps.seats.numberOf(threadId);
		const title = (await titleOf(threadId)) ?? "仕事フォーラムの投稿";
		const leased = seat.lease !== null;
		const released = await closeSeat(seat);
		const lent = released && number !== null;
		// Mac が開いて返すまでを見張れるよう、投稿の席を貸し出し中として残す
		if (lent) await seats.set(lentSeat(seat, number, seat.lease));
		const lead = lent
			? `${reply.body}\n\n${handoffOpenLine(number)}`
			: leased
				? `${reply.body}\n\n${HANDOFF_UNSAVED_NOTE}`
				: reply.body;
		await postWithApproval(threadId, lead, [], reply.files);
		await setStatus(threadId, "引き継ぎ", seat);
		await deps.remember(
			`仕事フォーラムの「${title}」を Mac に引き継いだ`,
			partnerOf(threadId),
		);
		await record(threadId, "handoff", [], title);
		const chosen = deps.seats.modelOf(threadId);
		if (seat.modelChange && chosen !== null && chosen !== seat.model) {
			await announceModel(threadId, seat.modelChange.by, seat.model, chosen);
		}
		log.info("seat done", {
			thread_id: threadId,
			status: "引き継ぎ",
			lent: lent ? number : null,
		});
	};

	/**
	 * Mac に返してほしいと頼まれた席を、手が止まったところで渡す。会話を預けて貸し出しを返し、席を閉じる。
	 * 預けられなければ止めた席として残し、次の返事で起こす。
	 */
	const lendToMac = async (seat: Seat) => {
		const threadId = seat.threadId;
		const number = deps.seats.numberOf(threadId);
		if (number === null || seat.standup) return;
		const generation = seat.lease;
		if (seat.status !== "sleeping") {
			const stopped = await deps.orca.stopSeat(seat);
			if (!stopped.ok) {
				log.error("seat lend stop failed", {
					thread_id: threadId,
					reason: stopped.error.reason,
				});
				return;
			}
		}
		const released = await releaseSession(seat);
		if (generation !== null && !released.released) {
			await seats.set({
				...released.seat,
				status: "sleeping",
				terminal: null,
				questionId: null,
				expectStop: false,
				background: false,
				releaseRequested: null,
			});
			dequeue();
			return;
		}
		if (seat.path) {
			const removed = await deps.orca.removeWorktree(seat.path);
			if (!removed.ok) {
				log.error("seat worktree remove failed", {
					thread_id: threadId,
					reason: removed.error.reason,
				});
			}
		}
		await seats.set(lentSeat(released.seat, number, generation, true));
		dequeue();
		await postTakeback(threadId, lentText(number));
		await setStatus(threadId, "引き継ぎ");
		log.info("seat lent to mac", {
			thread_id: threadId,
			number,
			requested_by: seat.releaseRequested,
		});
	};

	/** ターンの終わりに、Mac に頼まれていれば渡す。 */
	const lendIfRequested = async (threadId: string) => {
		const seat = seats.get(threadId);
		if (seat?.releaseRequested == null) return;
		if (seat.status === "working" || seat.status === "queued") return;
		await lendToMac(seat);
	};

	/**
	 * Mac から投稿の会話が戻った（takeback なら持ち主が取り戻した）。溜めた書き込みがあれば席に渡して起こす。
	 * 何も溜まっていなければ席を忘れ、次の書き込みで前の会話のまま続ける。
	 */
	const returnFromMac = async (
		seat: Seat,
		takeback: { pushedAt: Date | null } | null,
	) => {
		const threadId = seat.threadId;
		const held = seat.pending;
		await clearLendButtons(seat);
		if (takeback === null && held.length === 0) {
			await seats.delete(threadId);
			await postSystem(threadId, MAC_RETURNED_TEXT);
			await setStatus(threadId, "決めてほしい", { ...seat, lend: null });
			log.info("mac returned", { thread_id: threadId });
			return;
		}
		if (takeback === null)
			await postSystem(threadId, MAC_RETURNED_WITH_HELD_TEXT);
		const words = [
			takeback ? takebackNote(takeback.pushedAt) : RETURNED_NOTE,
			...held,
		];
		const back: Seat = {
			...seat,
			lend: null,
			releaseRequested: null,
			takeback,
			pending: [],
			continuation: null,
		};
		log.info(takeback ? "seat taken back" : "mac returned", {
			thread_id: threadId,
			held: held.length,
		});
		if (back.path) {
			// Mac が借りていると分かって起こせなかった席は worktree が残っているので、そのまま起こす
			const woke: Seat = {
				...back,
				status: "sleeping",
				pending: [words.join("\n\n---\n\n")],
			};
			await makeRoom(threadId);
			if (alive().length >= deps.seatLimit) {
				await seats.set({ ...woke, status: "queued", queuedAt: now() });
				await show(threadId, "受付");
				await sendTo(threadId, QUEUED_TEXT);
				return;
			}
			await launch(woke);
			return;
		}
		await openSeat(
			{ ...back, status: "queued", continuation: words },
			await historyText(threadId),
		);
	};

	/** 貸し出し中の投稿の meta を読み、Mac が借りた・返したかを見る。 */
	const watchLend = async (threadId: string) => {
		const hishaku = deps.hishaku;
		const seat = seats.get(threadId);
		if (!hishaku || seat?.status !== "lent" || seat.lend === null) return;
		const meta = await hishaku.meta(seat.lend.number);
		if (!meta.ok) {
			log.warn("hishaku meta failed", {
				thread_id: threadId,
				number: seat.lend.number,
				reason: meta.error.reason,
			});
			return;
		}
		if (macHolds(meta.value)) {
			if (seat.lend.mac) return;
			await seats.set({ ...seat, lend: { ...seat.lend, mac: true } });
			await postSystem(threadId, macResumedText(now()));
			await refreshPanel(threadId, true);
			return;
		}
		// 見回りの合間に借りて返していても、世代が進んでいれば戻ったと分かる
		const returned =
			seat.lend.mac ||
			(seat.lend.generation !== null &&
				meta.value.generation > seat.lend.generation);
		if (returned) await returnFromMac(seat, null);
	};

	/** 取り戻すのボタン。確かめてから、Mac の貸し出しを奪って席を前の会話のまま起こす。 */
	const lendPressed = async (
		threadId: string,
		p: ButtonPressEvent["payload"],
		press: LendPress,
	) => {
		const seat = seats.get(threadId);
		const settleConfirm = async (note: string | null) => {
			const current = await deps.system.getMessage(threadId, p.message_id);
			const edited = current.ok
				? await deps.system.editMessage(
						threadId,
						p.message_id,
						note === null
							? current.value.content
							: `${current.value.content}\n\n${note}`,
					)
				: current;
			if (!edited.ok) {
				log.warn("takeback confirm settle failed", {
					thread_id: threadId,
					error: edited.error.type,
				});
			}
		};
		if (!deps.hishaku || seat?.status !== "lent" || seat.lend === null) {
			log.info("stale lend button ignored", {
				thread_id: threadId,
				message_id: p.message_id,
			});
			if (press !== "takeback") await settleConfirm(null);
			return;
		}
		// 押された確認は settleConfirm が外すので、残りのボタンから除く
		const rest: Seat = {
			...seat,
			lend: {
				...seat.lend,
				confirms: seat.lend.confirms.filter((id) => id !== p.message_id),
			},
		};
		if (press === "cancel") {
			await settleConfirm(TAKEBACK_CANCELLED_TEXT);
			// 貸し出しは続くので「取り戻す」は残し、確認だけをすべて外す
			await clearButtons(
				threadId,
				seat.lend.confirms.filter((id) => id !== p.message_id),
			);
			await seats.set({ ...seat, lend: { ...seat.lend, confirms: [] } });
			return;
		}
		const meta = await deps.hishaku.meta(seat.lend.number);
		if (meta.ok && !macHolds(meta.value)) {
			// Mac はもう返している。奪わずに戻す
			if (press === "confirm") await settleConfirm(null);
			await returnFromMac(rest, null);
			return;
		}
		const pushedAt =
			(meta.ok ? meta.value.pushedAt : null) ?? seat.lend.savedAt;
		if (press === "takeback") {
			await rememberButtons(
				threadId,
				"confirms",
				await postSystem(
					threadId,
					takebackConfirmText(seat.lend.number, pushedAt),
					CONFIRM_BUTTONS,
				),
			);
			return;
		}
		await settleConfirm(null);
		await returnFromMac(rest, { pushedAt });
	};

	/** Dispatch を付けずに送られたメッセージは、送り手の端末か Dispatch から席を引く。 */
	const seatOfMessage = (msg: SeatMessage): Seat | null => {
		if (msg.dispatchId) return seats.byDispatch(msg.dispatchId);
		return (
			seats.all().find((s) => s.terminal !== null && s.terminal === msg.from) ??
			seats.byDispatch(msg.from)
		);
	};

	/** 途中経過や、持ち主の質問への答え。完了を待たずに投稿に書く。 */
	const onStatus = async (seat: Seat, msg: SeatMessage) => {
		if (seat.standup) return;
		const reply = await seatReply(seat, msg.body);
		if (reply.body === "" && reply.files.length === 0) return;
		if (reply.text !== "") {
			await seats.set({ ...seat, lastStatus: reply.text });
			await refreshPanel(seat.threadId, true);
		}
		const sent = await sendTo(seat.threadId, reply.body, reply.files);
		if (!sent.ok) {
			log.error("status post failed", {
				thread_id: seat.threadId,
				error: sent.error.type,
			});
		}
	};

	/** 持ち主の頼みで席の Claude を止め、同じ会話のまま起こし直す。コネクタの認証を足したあとなどに使う。 */
	const restart = async (threadId: string): Promise<boolean> => {
		const seat = seats.get(threadId);
		if (
			seat === null ||
			seat.path === null ||
			seat.status === "queued" ||
			seat.status === "lent"
		)
			return false;
		if (seat.status !== "sleeping") {
			const stopped = await deps.orca.stopSeat(seat);
			if (!stopped.ok) {
				log.error("seat restart stop failed", {
					thread_id: threadId,
					reason: stopped.error.reason,
				});
				await sendTo(threadId, FAILURE_TEXT);
				return true;
			}
		}
		const asked = seat.status === "asking" ? seat.question : null;
		// 起こし直す前に会話を預けて返す。借りたままだと、同じ番号を借り直せない
		const released = await releaseSession(seat);
		await sendTo(threadId, RESTARTING_TEXT);
		await launch({
			...released.seat,
			status: "sleeping",
			terminal: null,
			questionId: null,
			expectStop: false,
			pending: [restartNote(asked)],
		});
		log.info("seat restarted", { thread_id: threadId });
		return true;
	};

	const onEscalation = async (seat: Seat, msg: SeatMessage) => {
		const threadId = seat.threadId;
		if (msg.dispatchId !== seat.dispatchId) return;
		if (msg.stopReason !== null && seat.expectStop) {
			await seats.set({ ...seat, expectStop: false });
			return;
		}
		if (msg.stopReason !== null && seat.status !== "working") return;
		// 裏の shell やタイマーを待つためにターンを終えただけなので、止まったとは書かない
		if (msg.stopReason !== null && backgroundRunning(msg.body)) {
			if (!seat.background) await seats.set({ ...seat, background: true });
			log.info("seat waiting on background work", { thread_id: threadId });
			return;
		}
		expireGrant(threadId);
		const blocked = uniquePending(deps.ledger.takePending(threadId));
		if (seat.standup) {
			await deps.standupDone("", blocked, runKindOf(seat), partnerOf(threadId));
			await closeSeat(seat);
			return;
		}
		// 止まった知らせの本文は端末の出力なので投稿に出さない
		await postWithApproval(
			threadId,
			msg.stopReason !== null ? STOPPED_TEXT : msg.body,
			blocked,
			[],
			true,
		);
		await seats.set(toWaiting(seat, null));
		await setStatus(threadId, "決めてほしい");
		await applyModelChange(threadId);
		log.info("seat stopped", {
			thread_id: threadId,
			stop_reason: msg.stopReason,
			blocked: blocked.length,
		});
		await lendIfRequested(threadId);
	};

	const startFromRequest = async (p: Payload, partner: PartnerId) => {
		const request = { channelId: p.channel_id, messageId: p.message_id };
		const bot = speaker(partner).discord;
		// 要約と投稿を立てる間も受け付けたことが見えるよう、先に絵文字を付ける
		const reaction = await react(bot, request, null, REACTION_OF.受付);
		const summary = await deps.summarize(p.content);
		const title = summary.ok ? summary.value : fallbackTitle(p.content);
		const link = messageLink(p.guild_id, p.channel_id, p.message_id);
		const tags = await statusTags();
		const working = tags.get("作業中");
		const post = await bot.createForumPost(deps.workForumChannelId, {
			name: title,
			// 依頼者に通知が届くよう、最初の発言の名前をメンションにする
			content: forumPostBody({
				authorName: `<@${p.author.id}>`,
				content: p.content,
				link,
			}),
			tagIds: working ? [working] : [],
			notify: [p.author.id],
		});
		if (!post.ok) {
			log.error("forum post failed", {
				message_id: p.message_id,
				error: post.error.type,
			});
			await react(bot, request, reaction, null);
			await bot.send(
				p.channel_id,
				"フォーラムに投稿を立てられませんでした。少し置いてから、もう一度お願いします。",
				p.message_id,
			);
			return;
		}
		const { threadId } = post.value;
		// 投稿内の返事が届く前に担当を決めておく
		await deps.seats.assign(threadId, partner);
		parentOf.set(threadId, deps.workForumChannelId);
		log.info("forum post created", {
			message_id: p.message_id,
			thread_id: threadId,
			partner,
		});
		await bot.send(
			p.channel_id,
			`フォーラムに立てました。続きはこちらで → ${messageLink(p.guild_id, threadId)}`,
			p.message_id,
		);
		await queue.run(threadId, async () => {
			// 投稿内の返事が先に届いていれば、その返事がやりとりを読ませて席を作っている
			if (seats.get(threadId) !== null) return;
			await openSeat(
				{ ...newSeat(threadId), request, reaction },
				requestPrompt({
					now: now(),
					authorName: p.author.display_name,
					content: p.content,
					link,
				}),
			);
		});
	};

	type CommandPayload = CommandEvent["payload"];
	type Reply = (text: string) => Promise<void>;

	/** `/ai` の依頼から投稿を立てる。依頼はチャンネルに残らないので、受付の絵文字と元のメッセージへのリンクは無い。 */
	const startFromCommand = async (
		p: CommandPayload,
		content: string,
		reply: Reply,
	) => {
		const partner: PartnerId = p.agent === "codex" ? "akarin" : "yukarin";
		if (partner === "akarin" && !deps.akarin) {
			await reply(`${partnerName(partner)}の席はいま開いていません。`);
			return;
		}
		const bot = speaker(partner).discord;
		const summary = await deps.summarize(content);
		const title = summary.ok ? summary.value : fallbackTitle(content);
		const [status, models] = await Promise.all([statusTags(), modelTags()]);
		const tagIds = [
			status.get("作業中"),
			models.get(modelName(p.model)),
		].filter((id): id is string => id !== undefined);
		const post = await bot.createForumPost(deps.workForumChannelId, {
			name: title,
			content: forumPostBody({
				authorName: `<@${p.user.id}>`,
				content,
				link: null,
			}),
			tagIds,
			notify: [p.user.id],
		});
		if (!post.ok) {
			log.error("forum post failed", { error: post.error.type });
			await reply(
				"フォーラムに投稿を立てられませんでした。少し置いてから、もう一度お願いします。",
			);
			return;
		}
		const { threadId } = post.value;
		await deps.seats.assign(threadId, partner);
		await deps.seats.setModel(threadId, p.model);
		parentOf.set(threadId, deps.workForumChannelId);
		log.info("forum post created", {
			thread_id: threadId,
			partner,
			model: p.model,
		});
		await reply(
			`フォーラムに立てました → ${messageLink(p.guild_id, threadId)}`,
		);
		await queue.run(threadId, async () => {
			if (seats.get(threadId) !== null) return;
			await openSeat(
				newSeat(threadId),
				requestPrompt({
					now: now(),
					authorName: p.user.display_name,
					content,
					link: null,
				}),
			);
		});
	};

	const startFromIssue = async (
		issue: PickedIssue,
		partner: PartnerId,
	): Promise<Result<{ threadId: string }, { type: string }>> => {
		const tags = await statusTags();
		const working = tags.get("作業中");
		const post = await speaker(partner).discord.createForumPost(
			deps.workForumChannelId,
			{
				name: issueThreadName(issue),
				content: issuePostBody(issue),
				tagIds: working ? [working] : [],
			},
		);
		if (!post.ok) {
			log.error("forum post failed", {
				issue: `${issue.repo}#${issue.number}`,
				error: post.error.type,
			});
			return err({ type: post.error.type });
		}
		const { threadId } = post.value;
		await deps.seats.assign(threadId, partner);
		parentOf.set(threadId, deps.workForumChannelId);
		log.info("forum post created", {
			issue: `${issue.repo}#${issue.number}`,
			thread_id: threadId,
			partner,
		});
		await queue.run(threadId, async () => {
			if (seats.get(threadId) !== null) return;
			await openSeat(
				newSeat(threadId),
				issuePrompt({ now: now(), issue }),
				issue.repo,
			);
		});
		return ok({ threadId });
	};

	/** 担当と違う相手の `/ai` を投稿の中で打たれた。 */
	const onOtherPartnerCommand = async (
		threadId: string,
		_p: CommandPayload,
		reply: Reply,
	) => {
		const partner = partnerOf(threadId);
		await reply(otherPartnerText(partner, agentOf(partner)));
	};

	/**
	 * 投稿の席のモデルを変える。選んだモデルは投稿に残し、次に席を起動・再開するときも渡す。
	 * 席が手を止めていればすぐ切り替え、作業中なら手が止まったときに切り替える。
	 */
	const changeModel = async (
		threadId: string,
		p: CommandPayload,
		reply: Reply,
	) => {
		if (agentOf(partnerOf(threadId)) !== p.agent) {
			await onOtherPartnerCommand(threadId, p, reply);
			return;
		}
		const chosen = deps.seats.modelOf(threadId);
		const seat = seats.get(threadId);
		const label = modelLabel(p.model);
		await deps.seats.setModel(threadId, p.model);
		if (seat === null || !ALIVE.has(seat.status)) {
			if (chosen === p.model) {
				await reply(`すでに ${label} にしています。`);
				return;
			}
			// 席が動いていなければ、次に起動するときに選んだモデルで動く
			await announceModel(
				threadId,
				p.user.display_name,
				chosen ?? seat?.model ?? null,
				p.model,
			);
			await reply(`${label} に切り替えました。`);
			return;
		}
		if (seat.model === p.model) {
			// 作業中に頼んだ切り替えを、元のモデルに戻して取り消した
			if (seat.modelChange) await seats.set({ ...seat, modelChange: null });
			await reply(`すでに ${label} で動いています。`);
			return;
		}
		await seats.set({ ...seat, modelChange: { by: p.user.display_name } });
		if (seat.status === "working") {
			await reply(`今の手が止まったら ${label} に切り替えます。`);
			return;
		}
		await applyModelChange(threadId);
		const after = seats.get(threadId);
		await reply(
			after?.modelChange
				? `${label} に切り替えられませんでした。次に手が止まったときにもう一度切り替えます。`
				: `${label} に切り替えました。`,
		);
	};

	const startFromForumPost = async (p: Payload) => {
		const threadId = p.channel_id;
		const partner: PartnerId =
			deps.akarin && mentionsPartner(p, "akarin") ? "akarin" : "yukarin";
		await deps.seats.assign(threadId, partner);
		firstReplyTo.set(threadId, p.author.id);
		log.info("forum post received", { thread_id: threadId, partner });
		await openSeat(
			{
				...newSeat(threadId),
				request: { channelId: threadId, messageId: p.message_id },
			},
			forumStarterPrompt({
				now: now(),
				authorName: p.author.display_name,
				title: await titleOf(threadId),
				content: p.content,
			}),
		);
	};

	/**
	 * 片付いた許可の依頼を書き換え、ボタンを外す。ボタンは最後に mizuya の bot が出したメッセージに付いている。
	 * 書き換えに失敗しても、依頼はもう片付いているので、残ったボタンを押されても何もしない。
	 */
	const settle = async (
		threadId: string,
		request: ApprovalRequest,
		answer: ApprovalAnswer,
	) => {
		const messageId = request.messageIds.at(-1);
		if (messageId === undefined) return;
		const current = await deps.system.getMessage(threadId, messageId);
		const edited = current.ok
			? await deps.system.editMessage(
					threadId,
					messageId,
					settledApprovalText(current.value.content, answer),
				)
			: current;
		if (!edited.ok) {
			log.warn("approval settle failed", {
				thread_id: threadId,
				error: edited.error.type,
			});
		}
	};

	/** 待っていた操作を 1 回だけ許可し、席に続きをさせる。 */
	const grant = async (
		threadId: string,
		request: ApprovalRequest,
		by: { messageId: string; authorName: string; content: string },
		from: MessageRef,
	) => {
		const grantId = newGrantId();
		deps.ledger.log({
			event: "granted",
			thread_id: threadId,
			grant_id: grantId,
			message_id: by.messageId,
			operations: [...request.operations],
		});
		deps.ledger.grant(threadId, {
			grant_id: grantId,
			operations: [...request.operations],
		});
		log.info("approval granted", {
			thread_id: threadId,
			grant_id: grantId,
			operations: request.operations,
		});
		await deliver(
			threadId,
			approvedPrompt({
				now: now(),
				authorName: by.authorName,
				content: by.content,
				operations: request.operations,
			}),
			request.operations,
			from,
		);
	};

	const dismiss = (threadId: string, request: ApprovalRequest) => {
		deps.ledger.log({
			event: "dismissed",
			thread_id: threadId,
			operations: [...request.operations],
		});
		log.info("approval dismissed", { thread_id: threadId });
	};

	/**
	 * 許可の依頼のボタン。待っている依頼のメッセージに付いたボタンだけを受ける。
	 * 却下しても席は起こさない。続きは持ち主の返事で頼む。
	 */
	const pressed = async (
		threadId: string,
		p: ButtonPressEvent["payload"],
		answer: ApprovalAnswer,
	) => {
		const request = deps.approvals.get(threadId);
		// 返事か先のボタンで片付いた依頼のボタンは通さない。二度押しもここで止まる
		if (request === null || !request.messageIds.includes(p.message_id)) {
			log.info("stale approval button ignored", {
				thread_id: threadId,
				message_id: p.message_id,
			});
			return;
		}
		await deps.approvals.delete(threadId);
		await settle(threadId, request, answer);
		if (answer === "deny") {
			dismiss(threadId, request);
			return;
		}
		await grant(
			threadId,
			request,
			{
				messageId: p.message_id,
				authorName: p.user.display_name,
				content: "（許可のボタンを押した）",
			},
			// 席の受付のリアクションは持ち主の発言に付けたままにする
			seats.get(threadId)?.request ?? {
				channelId: threadId,
				messageId: p.message_id,
			},
		);
	};

	/**
	 * 持ち主が要らないと決めた投稿を、席の Claude を通さずに閉じる。
	 * 待っていた許可は却下として片付け、席があれば止めて worktree ごと消す。
	 */
	const dismissThread = async (threadId: string) => {
		const request = deps.approvals.get(threadId);
		if (request !== null) {
			await deps.approvals.delete(threadId);
			await settle(threadId, request, "deny");
			dismiss(threadId, request);
		}
		const seat = seats.get(threadId);
		await setStatus(threadId, "完了");
		if (seat !== null) {
			expireGrant(threadId);
			await record(threadId, "done", []);
			await closeSeat(seat);
		}
		log.info("thread dismissed", {
			thread_id: threadId,
			had_seat: seat !== null,
		});
	};

	/** 不要のボタン。押されたメッセージからボタンを外し、閉じたことを書き足す。 */
	const dismissPressed = async (
		threadId: string,
		p: ButtonPressEvent["payload"],
	) => {
		await dismissThread(threadId);
		const current = await deps.system.getMessage(threadId, p.message_id);
		const edited = current.ok
			? await deps.system.editMessage(
					threadId,
					p.message_id,
					dismissedText(current.value.content),
				)
			: current;
		if (!edited.ok) {
			log.warn("dismiss button removal failed", {
				thread_id: threadId,
				error: edited.error.type,
			});
		}
	};

	/** 投稿内の返事。許可を待っている操作があれば、許可かどうかを先に見る。 */
	const answer = async (threadId: string, p: Payload) => {
		const reply = replyPrompt({
			now: now(),
			authorName: p.author.display_name,
			content: p.content,
		});
		if (isRestartRequest(p.content) && (await restart(threadId))) return;
		const from = { channelId: threadId, messageId: p.message_id };
		if (isCloseRequest(p.content) && (await closeByWord(threadId, from)))
			return;
		const request = deps.approvals.get(threadId);
		if (request === null) {
			await deliver(threadId, reply, null, from);
			return;
		}
		// 許可でも取りやめでも、待っていた操作はここで片付け、古い依頼に後から OK やボタンを返しても通さない
		await deps.approvals.delete(threadId);
		const approved = isApproval(
			{ content: p.content, replyToMessageId: p.reply_to_message_id ?? null },
			request,
		);
		await settle(threadId, request, approved ? "grant" : "deny");
		if (!approved) {
			dismiss(threadId, request);
			await deliver(threadId, reply, null, from);
			return;
		}
		await grant(
			threadId,
			request,
			{
				messageId: p.message_id,
				authorName: p.author.display_name,
				content: p.content,
			},
			from,
		);
	};

	const sleep = async (threadId: string) => {
		const seat = seats.get(threadId);
		if (
			seat === null ||
			(seat.status !== "asking" && seat.status !== "waiting")
		)
			return;
		const stopped = await deps.orca.stopSeat(seat);
		if (!stopped.ok) {
			log.error("seat sleep failed", {
				thread_id: threadId,
				reason: stopped.error.reason,
			});
			return;
		}
		const released = await releaseSession(seat);
		await seats.set({
			...released.seat,
			status: "sleeping",
			terminal: null,
			questionId: null,
			expectStop: false,
			background: false,
		});
		log.info("seat sleeping", { thread_id: threadId });
		dequeue();
	};

	/**
	 * 完了したあと残していた席を閉じる。止めた席にはせず、完了したときに閉じるのと同じく worktree ごと消す。
	 * モデルの切り替えなどで Claude だけ止まった席も、同じく閉じる。
	 */
	const closeLingering = async (threadId: string) => {
		const seat = seats.get(threadId);
		if (
			seat?.doneAt == null ||
			(seat.status !== "waiting" && seat.status !== "sleeping")
		)
			return;
		log.info("lingering seat expired", { thread_id: threadId });
		await closeDone(seat);
	};

	/** 残している席に閉じる一言が書かれたら、席の Claude に渡さずに閉じ、その書き込みに完了の絵文字を付ける。 */
	const closeByWord = async (threadId: string, from: MessageRef) => {
		const seat = seats.get(threadId);
		if (seat?.doneAt == null || seat.status !== "waiting") return false;
		const bot = botOf(threadId);
		if (seat.request && seat.reaction) {
			await react(bot, seat.request, seat.reaction, null);
		}
		await react(bot, from, null, REACTION_OF.完了);
		log.info("lingering seat closed by owner", { thread_id: threadId });
		await closeDone(seat);
		return true;
	};

	return {
		handle: async (envelope) => {
			const p = envelope.payload;
			if (
				p.author.id === deps.botUserId ||
				p.author.id === deps.akarin?.botUserId ||
				p.author.id === deps.systemUserId
			)
				return;
			// 持ち主以外の人やほかの bot の発言で席を動かさない
			if (p.author.is_bot || !deps.ownerUserIds.has(p.author.id)) {
				log.info("message from non-owner ignored", {
					message_id: p.message_id,
					author_id: p.author.id,
				});
				return;
			}

			if (p.channel_id === deps.workTextChannelId) {
				const partner = await addresseeOf(p);
				if (partner === null) {
					log.info("work message without addressee", {
						message_id: p.message_id,
						mentions: p.mentions.length,
						mention_roles: p.mention_roles.length,
					});
					return;
				}
				await startFromRequest(p, partner);
				return;
			}

			if ((await parentIdOf(p.channel_id)) !== deps.workForumChannelId) return;
			const threadId = p.channel_id;
			// フォーラム投稿の最初のメッセージは投稿（スレッド）と同じ ID を持つ
			if (p.message_id === threadId) {
				await queue.run(threadId, async () => {
					if (seats.get(threadId) === null) await startFromForumPost(p);
				});
				return;
			}
			await queue.run(threadId, () => answer(threadId, p));
		},
		press: async (envelope) => {
			const p = envelope.payload;
			const answer = approvalAnswerOf(p.custom_id);
			const dismissing = isDismissButton(p.custom_id);
			const lendPress = lendPressOf(p.custom_id);
			if (answer === null && !dismissing && lendPress === null) return;
			// 持ち主以外が押しても何も起きない
			if (p.user.is_bot || !deps.ownerUserIds.has(p.user.id)) {
				log.debug("button from non-owner ignored", {
					message_id: p.message_id,
					user_id: p.user.id,
				});
				return;
			}
			const threadId = p.channel_id;
			if (lendPress !== null) {
				await queue.run(threadId, () => lendPressed(threadId, p, lendPress));
				return;
			}
			if (answer === null) {
				await queue.run(threadId, () => dismissPressed(threadId, p));
				return;
			}
			await queue.run(threadId, () => pressed(threadId, p, answer));
		},
		command: async (envelope) => {
			const p = envelope.payload;
			const reply: Reply = async (text) => {
				const r = await deps.system.editInteractionReply(
					p.application_id,
					p.token,
					text,
				);
				if (!r.ok) {
					log.warn("command reply failed", {
						type: p.type,
						error: r.error.type,
					});
				}
			};
			if (p.user.is_bot || !deps.ownerUserIds.has(p.user.id)) {
				log.info("command from non-owner ignored", { user_id: p.user.id });
				await reply("このコマンドは持ち主だけが使えます。");
				return;
			}
			if (p.type === "request") {
				if (!p.content?.trim()) {
					await reply("依頼が空でした。");
					return;
				}
				await startFromCommand(p, p.content, reply);
				return;
			}
			const threadId = p.channel_id;
			if ((await parentIdOf(threadId)) !== deps.workForumChannelId) {
				await reply(
					"モデルは仕事フォーラムの投稿の中で変えられます。投稿の外で打つと依頼を書けます。",
				);
				return;
			}
			await queue.run(threadId, () => changeModel(threadId, p, reply));
		},
		onSeatMessage: async (msg) => {
			const seat = seatOfMessage(msg);
			if (seat === null) {
				log.warn("seat message for unknown dispatch", {
					type: msg.type,
					dispatch_id: msg.dispatchId,
				});
				return;
			}
			await queue.run(seat.threadId, async () => {
				const current = seats.get(seat.threadId);
				// Mac に貸している間に、止めた席の古い Dispatch から届いたもの
				if (current === null || current.status === "lent") return;
				if (msg.type === "question") await onQuestion(current, msg);
				else if (msg.type === "worker_done") await onDone(current, msg);
				else if (msg.type === "escalation") await onEscalation(current, msg);
				else if (msg.type === "status") await onStatus(current, msg);
			});
			if (msg.type === "question" || msg.type === "worker_done")
				deps.seatReplied?.();
		},
		startFromIssue,
		startStandup: async (spec, kind = "standup", partner = "yukarin") => {
			const threadId = `${kind}-${randomUUID()}`;
			if (partner !== "yukarin") await deps.seats.assign(threadId, partner);
			await queue.run(threadId, () => openSeat(newSeat(threadId, true), spec));
			return threadId;
		},
		sleepIdle: async () => {
			const limit = now().getTime() - deps.sleepAfterMs;
			const idle = seats
				.all()
				.filter(
					(s) =>
						(s.status === "asking" || s.status === "waiting") &&
						!s.standup &&
						s.doneAt === null &&
						s.waitingSince !== null &&
						s.waitingSince.getTime() <= limit,
				);
			const doneLimit = now().getTime() - deps.doneLingerMs;
			const expired = seats
				.all()
				.filter((s) => s.doneAt !== null && s.doneAt.getTime() <= doneLimit);
			await Promise.all([
				...idle.map((s) => queue.run(s.threadId, () => sleep(s.threadId))),
				...expired.map((s) =>
					queue.run(s.threadId, () => closeLingering(s.threadId)),
				),
			]);
		},
		reconcile: async () => {
			await statusTagsOf();
			// 前の受付が制限で待っていた件名を付ける
			for (const threadId of deps.seats.pendingTitles()) {
				void queue.run(threadId, async () => {
					const ch = await deps.discord.getChannel(threadId);
					await applyTitle(threadId, ch.ok ? ch.value.name : null);
				});
			}
			const [live, residue] = await Promise.all([
				deps.orca.liveTerminals(),
				deps.orca.residue(),
			]);
			if (!live.ok || !residue.ok) {
				log.error("seat reconcile failed", {
					reason: (!live.ok ? live.error : !residue.ok ? residue.error : null)
						?.reason,
				});
				return;
			}
			const before = seats.all();
			// 閉じた席の worktree は residue にまだ載っているので、残りとして消し直さない
			const closed = new Set<string>();
			for (const seat of before) {
				if (!ALIVE.has(seat.status)) continue;
				if (seat.terminal && live.value.has(seat.terminal)) continue;
				// 席の Claude はもういない。worktree と会話は残っているので、返事で起こす
				await deps.orca.stopSeat({
					dispatchId: seat.dispatchId,
					terminal: null,
				});
				if (seat.standup || seat.path === null) {
					await seats.delete(seat.threadId);
					continue;
				}
				// 完了して残していた席は、Claude がいなければ残す意味がないので閉じる
				if (seat.doneAt !== null) {
					await closeDone({ ...seat, terminal: null });
					closed.add(seat.path);
					continue;
				}
				// agent は止まっているので、手元に残った会話を預けて貸し出しを返す
				const released = await releaseSession(seat);
				await seats.set({
					...released.seat,
					status: "sleeping",
					terminal: null,
					questionId: null,
					expectStop: false,
					background: false,
				});
				if (seat.status === "working") {
					await sendTo(seat.threadId, RESTARTED_TEXT);
					await setStatus(seat.threadId, "決めてほしい");
				}
				log.info("seat lost its claude", { thread_id: seat.threadId });
			}
			const known = new Map(
				seats.all().flatMap((s) => (s.path ? [[s.path, s] as const] : [])),
			);
			for (const t of residue.value.terminals) {
				const owner = known.get(t.path);
				if (owner?.terminal === t.handle) continue;
				await deps.orca.closeTerminal(t.handle);
				log.info("stray seat terminal closed", { terminal: t.handle });
			}
			for (const path of residue.value.worktrees) {
				if (known.has(path) || closed.has(path)) continue;
				const r = await deps.orca.removeWorktree(path);
				log.info("stray seat worktree removed", { path, ok: r.ok });
			}
			for (const seat of seats.all()) syncTyping(seat.threadId, seat);
			dequeue();
		},
		refreshPanels: async () => {
			const working = seats
				.all()
				.filter((s) => s.status === "working" && !s.standup);
			await Promise.all(
				working.map((s) =>
					queue.run(s.threadId, () => refreshPanel(s.threadId, false)),
				),
			);
		},
		watchLends: async () => {
			if (!deps.hishaku) return;
			const lent = seats.all().filter((s) => s.status === "lent");
			await Promise.all(
				lent.map((s) => queue.run(s.threadId, () => watchLend(s.threadId))),
			);
		},
		summary: () => {
			const working = seats
				.all()
				.filter((s) => s.status === "working" && !s.standup);
			const partners = Object.fromEntries(
				PARTNER_IDS.map((id) => [id, 0]),
			) as Record<PartnerId, number>;
			for (const s of working) partners[partnerOf(s.threadId)] += 1;
			return { working: working.length, partners };
		},
		renewLeases: async () => {
			const hishaku = deps.hishaku;
			if (!hishaku) return;
			const leased = seats
				.all()
				.filter((s) => s.lease !== null && ALIVE.has(s.status));
			await Promise.all(
				leased.map((s) =>
					queue.run(s.threadId, async () => {
						const seat = seats.get(s.threadId);
						const number = deps.seats.numberOf(s.threadId);
						if (seat?.lease == null || number === null) return;
						const r = await hishaku.renew({ number, generation: seat.lease });
						if (r.ok) {
							const by = r.value.releaseRequestedBy;
							if (by === null || by === hishaku.holder || seat.standup) return;
							if (seat.releaseRequested !== by) {
								log.info("mac asked for the session", {
									thread_id: seat.threadId,
									number,
									holder: by,
								});
								await seats.set({ ...seat, releaseRequested: by });
							}
							// 作業中ならターンの終わりに渡す
							await lendIfRequested(seat.threadId);
							return;
						}
						if (r.error.type === "HishakuFailed") {
							// 次の回で延ばせれば貸し出しは切れない
							log.warn("hishaku renew failed", {
								thread_id: seat.threadId,
								number,
								reason: r.error.reason,
							});
							return;
						}
						log.warn("hishaku lease was taken", {
							thread_id: seat.threadId,
							number,
						});
						await seats.set({ ...seat, lease: null });
						if (!seat.standup) await sendTo(seat.threadId, LEASE_STOLEN_TEXT);
					}),
				),
			);
		},
	};
};
