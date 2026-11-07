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
import type { Attachment, DiscordApi, PostedMessage } from "./discord-rest.ts";
import { dismissedText, isDismissButton } from "./dismiss.ts";
import { seatNameOf } from "./guard/env.ts";
import type { Ledger, Pending } from "./guard/ledger.ts";
import type { Operation } from "./guard/operation.ts";
import { createKeyedQueue } from "./keyed-queue.ts";
import { PARTNER_IDS, type PartnerId } from "./lib/core.ts";
import type {
	DiscordButtonPressedEnvelope,
	DiscordMessageCreatedEnvelope,
} from "./lib/protocol.ts";
import type { Logger } from "./logger.ts";
import type { Orca, OrcaError, SeatAgent, SeatMessage } from "./orca.ts";
import {
	backgroundReplyNote,
	fallbackTitle,
	forumPostBody,
	forumStarterPrompt,
	historyPrompt,
	messageLink,
	replyPrompt,
	requestPrompt,
	restartNote,
	seatSpec,
	wakeNote,
} from "./prompts.ts";
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
	replaceStatusTag,
	takeStatus,
	WORK_STATUSES,
	type WorkStatus,
} from "./work-status.ts";

/** 席を受け持つパートナーの bot と、その席に渡す前置き。 */
export type SeatPartner = {
	/** 返事・投稿・タグ・リアクション・入力中の表示をこの bot で書く。 */
	discord: DiscordApi;
	botUserId: string;
	/** 新しい席に最初に渡す前置き（人格、仕事のしかた、引き継ぎの指示）。 */
	preamble: string;
};

export type IntakeDeps = {
	/** Yukarin の bot。読むのもこの bot で行う。 */
	discord: DiscordApi;
	/** mizuya の bot。許可と不要のボタン、状態の欄を書く。 */
	system: DiscordApi;
	/** mizuya の bot のユーザー。メンションされたら Yukarin 宛てとみなす。 */
	systemUserId: string;
	orca: Orca;
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
	newGrantId?: () => string;
	now?: () => Date;
	/** ms ごとに fn を呼び、止める関数を返す。入力中の表示を送り続けるのに使う。 */
	every?: (ms: number, fn: () => void) => () => void;
	logger: Logger;
};

/** Discord の入力中の表示は約 10 秒で消えるので、それより短い間隔で送り直す。 */
export const TYPING_EVERY_MS = 8_000;

const defaultEvery = (ms: number, fn: () => void) => {
	const timer = setInterval(fn, ms);
	timer.unref();
	return () => clearInterval(timer);
};

type Payload = DiscordMessageCreatedEnvelope["payload"];

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
	handle: (envelope: DiscordMessageCreatedEnvelope) => Promise<void>;
	/** 投稿のボタンが押された。許可の依頼のボタンだけを扱う。 */
	press: (envelope: DiscordButtonPressedEnvelope) => Promise<void>;
	/** 席から届いたメッセージ（質問、完了の報告、止まった知らせ）を投稿に運ぶ。 */
	onSeatMessage: (msg: SeatMessage) => Promise<void>;
	/** 朝会か見回りの席を作る。席の名前にする ID を返す。 */
	startStandup: (spec: string, kind?: RunKind) => Promise<string>;
	/** 決めてほしいまま時間がたった席の Claude を止める。 */
	sleepIdle: () => Promise<void>;
	/** 起動時に、対応表と Orca の席を突き合わせる。 */
	reconcile: () => Promise<void>;
	/** 作業中の席の状態の欄の経過時間を書き換える。前に書いてから間がなければ書かない。 */
	refreshPanels: () => Promise<void>;
	/** 作業中の席の数。gateway が自分のパートナーの数を bot のステータスに出す。 */
	summary: () => SeatSummary;
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
	let tagIds: Map<WorkStatus, string> | null = null;
	const every = deps.every ?? defaultEvery;

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
			(roleId !== null && (p.mention_roles ?? []).includes(roleId)) ||
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

	const statusTags = async (): Promise<Map<WorkStatus, string>> => {
		if (tagIds) return tagIds;
		const forum = await deps.discord.getChannel(deps.workForumChannelId);
		if (!forum.ok) {
			log.warn("forum tags unavailable", { error: forum.error.type });
			return new Map();
		}
		const found = new Map<WorkStatus, string>();
		for (const name of WORK_STATUSES) {
			const tag = forum.value.availableTags.find((t) => t.name === name);
			if (tag) found.set(name, tag.id);
			else log.warn("forum tag missing", { tag: name });
		}
		// タグは後からフォーラムに足せるので、欠けている間は覚えずに次も引き直す
		if (found.size === WORK_STATUSES.length) tagIds = found;
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

	const setStatus = async (
		threadId: string,
		status: WorkStatus,
		gone?: Seat,
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
		if (same) return;
		const r = await botOf(threadId).setTags(threadId, next);
		if (!r.ok) {
			log.warn("set tags failed", { thread_id: threadId, error: r.error.type });
		}
	};

	const titleOf = async (threadId: string): Promise<string | null> => {
		const ch = await deps.discord.getChannel(threadId);
		return ch.ok ? ch.value.name : null;
	};

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
		const title = (await titleOf(threadId)) ?? threadId;
		const text = seat.pending.join("\n\n---\n\n");
		const partner = partnerOf(threadId);
		const agent = agentOf(partner);
		const r = seat.path
			? await deps.orca.resumeSeat({
					path: seat.path,
					title,
					spec: text,
					agent,
				})
			: await deps.orca.startSeat({
					name: seatNameOf(threadId),
					title,
					spec: seatSpec(speaker(partner).preamble, text),
					agent,
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
				},
				await historyText(threadId),
			);
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
			pending: [],
			queuedAt: null,
			background: false,
			lastStatus: null,
		});
		log.info("seat working", {
			thread_id: threadId,
			dispatch_id: r.value.dispatchId,
			resumed: seat.path !== null,
		});
		if (!seat.standup) await setStatus(threadId, "作業中");
	};

	/** 席を作るか、上限なら順番待ちにする。 */
	const openSeat = async (seat: Seat, text: string) => {
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
		if (!seat.standup && alive().length >= deps.seatLimit) {
			await seats.set({ ...next, status: "queued", queuedAt: now() });
			log.info("seat queued", { thread_id: seat.threadId });
			await sendTo(seat.threadId, QUEUED_TEXT);
			return;
		}
		await launch(next);
	};

	/** 席の Claude を止め、worktree を消して対応を忘れる。 */
	const closeSeat = async (seat: Seat) => {
		const stopped = await deps.orca.stopSeat(seat);
		if (!stopped.ok) {
			log.error("seat stop failed", {
				thread_id: seat.threadId,
				reason: stopped.error.reason,
			});
		}
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
			const prompt = await historyText(threadId);
			await openSeat(
				{ ...newSeat(threadId), request: from },
				granted ? `${prompt}\n\n${approvedNote(granted)}` : prompt,
			);
			return;
		}
		const seat = await receive(stored, from);
		switch (seat.status) {
			case "queued":
				await seats.set({ ...seat, pending: [...seat.pending, text] });
				return;
			case "sleeping": {
				const woke = {
					...seat,
					pending: [`${wakeNote(seat.question)}\n\n${text}`],
				};
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
		});
		await setStatus(threadId, "作業中");
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
		log.info("seat asked", { thread_id: threadId, blocked: blocked.length });
	};

	const onDone = async (seat: Seat, msg: SeatMessage) => {
		const threadId = seat.threadId;
		expireGrant(threadId);
		const blocked = uniquePending(deps.ledger.takePending(threadId));
		if (seat.standup) {
			await deps.standupDone(msg.body, blocked, runKindOf(seat));
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
			log.info("seat waiting", {
				thread_id: threadId,
				blocked: blocked.length,
			});
			return;
		}
		await postWithApproval(threadId, reply.body, [], reply.files);
		await setStatus(threadId, taken.status);
		const title = (await titleOf(threadId)) ?? "仕事フォーラムの投稿";
		await deps.remember(
			taken.status === "完了"
				? `仕事フォーラムの「${title}」を終えた`
				: taken.status === "見張り中"
					? `仕事フォーラムの「${title}」で見張りを始めた`
					: `仕事フォーラムの「${title}」を Mac に引き継いだ`,
			partnerOf(threadId),
		);
		await record(
			threadId,
			taken.status === "引き継ぎ" ? "handoff" : "done",
			[],
			title,
		);
		await closeSeat(seat);
		log.info("seat done", { thread_id: threadId, status: taken.status });
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
		if (seat === null || seat.path === null || seat.status === "queued")
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
		await sendTo(threadId, RESTARTING_TEXT);
		await launch({
			...seat,
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
			await deps.standupDone("", blocked, runKindOf(seat));
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
		log.info("seat stopped", {
			thread_id: threadId,
			stop_reason: msg.stopReason,
			blocked: blocked.length,
		});
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
		p: DiscordButtonPressedEnvelope["payload"],
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
		p: DiscordButtonPressedEnvelope["payload"],
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
		const request = deps.approvals.get(threadId);
		const from = { channelId: threadId, messageId: p.message_id };
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
		await seats.set({
			...seat,
			status: "sleeping",
			terminal: null,
			questionId: null,
			expectStop: false,
			background: false,
		});
		log.info("seat sleeping", { thread_id: threadId });
		dequeue();
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
						mention_roles: (p.mention_roles ?? []).length,
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
			if (answer === null && !dismissing) return;
			// 持ち主以外が押しても何も起きない
			if (p.user.is_bot || !deps.ownerUserIds.has(p.user.id)) {
				log.debug("button from non-owner ignored", {
					message_id: p.message_id,
					user_id: p.user.id,
				});
				return;
			}
			const threadId = p.channel_id;
			if (answer === null) {
				await queue.run(threadId, () => dismissPressed(threadId, p));
				return;
			}
			await queue.run(threadId, () => pressed(threadId, p, answer));
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
				if (current === null) return;
				if (msg.type === "question") await onQuestion(current, msg);
				else if (msg.type === "worker_done") await onDone(current, msg);
				else if (msg.type === "escalation") await onEscalation(current, msg);
				else if (msg.type === "status") await onStatus(current, msg);
			});
		},
		startStandup: async (spec, kind = "standup") => {
			const threadId = `${kind}-${randomUUID()}`;
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
						s.waitingSince !== null &&
						s.waitingSince.getTime() <= limit,
				);
			await Promise.all(
				idle.map((s) => queue.run(s.threadId, () => sleep(s.threadId))),
			);
		},
		reconcile: async () => {
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
				await seats.set({
					...seat,
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
				if (known.has(path)) continue;
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
	};
};
