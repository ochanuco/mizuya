import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import type { ApprovalRequest, ApprovalStore } from "./approval-store.ts";
import type {
	ButtonPressEvent,
	CommandEvent,
	WorkMessageEvent,
} from "./discord-events.ts";
import type { ChannelInfo, DiscordApi, PostedMessage } from "./discord-rest.ts";
import { createLedger } from "./guard/ledger.ts";
import {
	err,
	externalServiceUnavailable,
	ok,
	permissionDenied,
} from "./lib/core.ts";
import type { Orca, SeatHandle, SeatMessage } from "./orca.ts";

export const memoryApprovals = (): ApprovalStore & {
	all: Map<string, ApprovalRequest>;
} => {
	const all = new Map<string, ApprovalRequest>();
	return {
		all,
		get: (id) => all.get(id) ?? null,
		set: async (id, r) => {
			all.set(id, r);
		},
		delete: async (id) => {
			all.delete(id);
		},
	};
};

export const tempDir = (prefix = "mizuya-working-") =>
	mkdtempSync(join(tmpdir(), prefix));

export const tempLedger = (dir = tempDir()) => createLedger(dir);

export const BOT = "bot";
export const OWNER = "u1";
export const TEXT = "text";
export const FORUM = "forum";
export const TAGS = [
	{ id: "tag-decide", name: "決めてほしい" },
	{ id: "tag-working", name: "作業中" },
	{ id: "tag-handoff", name: "引き継ぎ" },
	{ id: "tag-watching", name: "見張り中" },
	{ id: "tag-done", name: "完了" },
	{ id: "tag-other", name: "その他" },
	{ id: "tag-opus", name: "Opus" },
	{ id: "tag-sonnet", name: "Sonnet" },
	{ id: "tag-haiku", name: "Haiku" },
	{ id: "tag-terra", name: "Terra" },
	{ id: "tag-sol", name: "Sol" },
	{ id: "tag-luna", name: "Luna" },
];

/** Discord REST のモック。投稿・送信・タグを手元に残す。 */
export const fakeDiscord = () => {
	const channels = new Map<string, ChannelInfo>([
		[
			FORUM,
			{
				id: FORUM,
				name: "仕事",
				parentId: "cat",
				appliedTagIds: [],
				availableTags: TAGS,
			},
		],
		[
			TEXT,
			{
				id: TEXT,
				name: "仕事",
				parentId: "cat",
				appliedTagIds: [],
				availableTags: [],
			},
		],
	]);
	const messages = new Map<string, PostedMessage>();
	/** bot が送ったメッセージの本文。getMessage で読み直せる。 */
	const botMessages = new Map<string, string>();
	const refuseSendTo = new Set<string>();
	const sent: {
		channelId: string;
		content: string;
		replyTo?: string;
		files?: string[];
		buttons?: string[];
		notify?: string[];
	}[] = [];
	const posts: {
		name: string;
		content: string;
		tagIds: string[];
		buttons?: string[];
		notify?: string[];
	}[] = [];
	const history = new Map<string, PostedMessage[]>();
	/** `${channelId}/${messageId}` ごとの bot のリアクション。 */
	const reactions = new Map<string, string[]>();
	/** 書き換える前提で送ったメッセージの、いまの本文。 */
	const edited = new Map<string, { channelId: string; content: string }>();
	const typing: string[] = [];
	/** `/ai` の interaction token ごとの、本人にだけ見える返事のいまの本文。 */
	const interactionReplies = new Map<string, string>();
	let nextThread = 1;
	let nextMessage = 1;
	const api: DiscordApi = {
		me: async () => ok({ id: BOT }),
		getChannel: vi.fn(async (id: string) => {
			const ch = channels.get(id);
			return ch
				? ok(ch)
				: err(externalServiceUnavailable({ service: "discord" }));
		}),
		getMessage: async (_c, id) => {
			const m = messages.get(id);
			if (m) return ok(m);
			const own = botMessages.get(id);
			return own !== undefined
				? ok({
						id,
						authorId: BOT,
						authorName: "ゆかり",
						isBot: true,
						content: own,
					})
				: err(externalServiceUnavailable({ service: "discord" }));
		},
		listMessages: vi.fn(async (channelId: string) =>
			ok(history.get(channelId) ?? []),
		),
		createForumPost: vi.fn(
			async (
				forumId: string,
				post: {
					name: string;
					content: string;
					tagIds: string[];
					buttons?: readonly { customId: string }[];
					notify?: readonly string[];
				},
			) => {
				const id = `thread${nextThread++}`;
				const { buttons, notify, ...rest } = post;
				posts.push({
					...rest,
					...(notify?.length ? { notify: [...notify] } : {}),
					...(buttons?.length
						? { buttons: buttons.map((b) => b.customId) }
						: {}),
				});
				// フォーラム投稿の最初のメッセージは投稿と同じ ID を持つ
				botMessages.set(id, post.content);
				channels.set(id, {
					id,
					name: post.name,
					parentId: forumId,
					appliedTagIds: post.tagIds,
					availableTags: [],
				});
				return ok({ threadId: id });
			},
		),
		send: async (
			channelId,
			content,
			replyTo,
			files = [],
			buttons = [],
			notify = [],
		) => {
			if (refuseSendTo.has(channelId)) {
				return err(
					permissionDenied({ actor: "discord bot", action: "POST /channels" }),
				);
			}
			sent.push({
				channelId,
				content,
				...(replyTo ? { replyTo } : {}),
				...(files.length > 0 ? { files: files.map((f) => f.name) } : {}),
				...(buttons.length > 0
					? { buttons: buttons.map((b) => b.customId) }
					: {}),
				...(notify.length > 0 ? { notify: [...notify] } : {}),
			});
			const id = `sent${sent.length}`;
			botMessages.set(id, content);
			return ok({ messageIds: [id] });
		},
		setTags: async (threadId, tagIds) => {
			const ch = channels.get(threadId);
			if (ch) channels.set(threadId, { ...ch, appliedTagIds: tagIds });
			return ok(undefined);
		},
		createMessage: async (channelId, content) => {
			const id = `panel${nextMessage++}`;
			edited.set(id, { channelId, content });
			return ok({ id });
		},
		editMessage: vi.fn(
			async (channelId: string, messageId: string, content: string) => {
				edited.set(messageId, { channelId, content });
				if (botMessages.has(messageId)) botMessages.set(messageId, content);
				return ok(undefined);
			},
		),
		editInteractionReply: async (_applicationId, token, content) => {
			interactionReplies.set(token, content);
			return ok(undefined);
		},
		typing: async (channelId) => {
			typing.push(channelId);
			return ok(undefined);
		},
		addReaction: async (channelId, messageId, emoji) => {
			const key = `${channelId}/${messageId}`;
			reactions.set(key, [...(reactions.get(key) ?? []), emoji]);
			return ok(undefined);
		},
		removeReaction: async (channelId, messageId, emoji) => {
			const key = `${channelId}/${messageId}`;
			reactions.set(
				key,
				(reactions.get(key) ?? []).filter((e) => e !== emoji),
			);
			return ok(undefined);
		},
	};
	const reactionsOn = (channelId: string, messageId: string) =>
		reactions.get(`${channelId}/${messageId}`) ?? [];
	const panelIn = (channelId: string) =>
		[...edited.values()].filter((m) => m.channelId === channelId).at(-1)
			?.content ?? null;
	const addThread = (id: string, name: string) =>
		channels.set(id, {
			id,
			name,
			parentId: FORUM,
			appliedTagIds: [],
			availableTags: [],
		});
	const tagsOf = (id: string) => channels.get(id)?.appliedTagIds ?? [];
	const sentTo = (id: string) =>
		sent.filter((s) => s.channelId === id).map((s) => s.content);
	return {
		api,
		channels,
		messages,
		sent,
		posts,
		history,
		refuseSendTo,
		typing,
		reactionsOn,
		panelIn,
		edited,
		addThread,
		tagsOf,
		sentTo,
		interactionReplies,
	};
};

/**
 * Orca のモック。席を作る・続きを渡す・止める・消す、を呼ばれた順に残す。
 * 席から受付に届くメッセージは、テストが intake.onSeatMessage に直接渡す。
 */
export const fakeOrca = (seatsDir = "/seats") => {
	let n = 0;
	const calls: { op: string; args: unknown }[] = [];
	const live = new Set<string>();
	const worktrees = new Set<string>();
	const strayTerminals: { handle: string; path: string }[] = [];
	const handle = (path: string): SeatHandle => {
		n++;
		const h = { dispatchId: `d${n}`, terminal: `t${n}`, path };
		live.add(h.terminal);
		return h;
	};
	const orca: Orca = {
		waitReady: vi.fn(async () => ok(undefined)),
		prepare: vi.fn(async () => ok({ runId: "run1", reception: "rx" })),
		startSeat: vi.fn(async (input) => {
			calls.push({ op: "startSeat", args: input });
			const path = `${seatsDir}/${input.name}`;
			worktrees.add(path);
			return ok(handle(path));
		}),
		resumeSeat: vi.fn(async (input) => {
			calls.push({ op: "resumeSeat", args: input });
			if (!worktrees.has(input.path)) {
				return err({
					type: "SeatWorktreeMissing" as const,
					command: "resume",
					reason: input.path,
				});
			}
			return ok(handle(input.path));
		}),
		switchModel: vi.fn(async (input) => {
			calls.push({ op: "switchModel", args: input });
			return ok(undefined);
		}),
		send: vi.fn(async (input) => {
			calls.push({ op: "send", args: input });
			n++;
			return ok({ dispatchId: `d${n}`, terminal: null });
		}),
		reply: vi.fn(async (input) => {
			calls.push({ op: "reply", args: input });
			return ok(undefined);
		}),
		stopSeat: vi.fn(async (seat) => {
			calls.push({ op: "stopSeat", args: seat });
			if (seat.terminal) live.delete(seat.terminal);
			return ok(undefined);
		}),
		removeWorktree: vi.fn(async (path) => {
			calls.push({ op: "removeWorktree", args: path });
			worktrees.delete(path);
			return ok(undefined);
		}),
		closeTerminal: vi.fn(async (h) => {
			calls.push({ op: "closeTerminal", args: h });
			live.delete(h);
			return ok(undefined);
		}),
		liveTerminals: vi.fn(async () => ok(new Set(live))),
		residue: vi.fn(async () =>
			ok({ worktrees: [...worktrees], terminals: [...strayTerminals] }),
		),
		waitMessages: vi.fn(async () => ok([])),
	};
	const opsOf = (op: string) =>
		calls.filter((c) => c.op === op).map((c) => c.args);
	return { orca, calls, live, worktrees, strayTerminals, opsOf };
};

let seq = 0;
export const seatMessage = (
	m: Partial<SeatMessage> & Pick<SeatMessage, "type" | "dispatchId">,
): SeatMessage => ({
	id: `msg${++seq}`,
	from: "",
	subject: "",
	body: "",
	outcome: null,
	stopReason: null,
	...m,
});

export const envelope = (
	payload: Partial<WorkMessageEvent["payload"]>,
): WorkMessageEvent =>
	({
		event_id: `e${++seq}`,
		payload: {
			guild_id: "g",
			channel_id: TEXT,
			message_id: `m${seq}`,
			author: { id: OWNER, display_name: "ちゃぬ", is_bot: false },
			content: "<@123> 請求書を整理して",
			mentions: [BOT],
			mention_roles: [],
			reply_to_message_id: null,
			attachments: [],
			...payload,
		},
	}) as WorkMessageEvent;

/** 投稿内の持ち主の発言。 */
export const say = (
	threadId: string,
	content: string,
	opts: { first?: boolean; replyTo?: string } = {},
) =>
	envelope({
		channel_id: threadId,
		...(opts.first ? { message_id: threadId } : {}),
		content,
		mentions: [],
		reply_to_message_id: opts.replyTo ?? null,
	});

/** 持ち主が打った `/ai`。request は投稿の外の modal から、model は投稿の中から。 */
export const aiCommand = (input: {
	type: "request" | "model";
	agent: "claude" | "codex";
	model: string;
	channelId?: string;
	content?: string;
	userId?: string;
}): CommandEvent => ({
	event_id: `e${++seq}`,
	payload: {
		type: input.type,
		application_id: "app",
		token: `itok${seq}`,
		guild_id: "g",
		channel_id: input.channelId ?? TEXT,
		user: { id: input.userId ?? OWNER, display_name: "ちゃぬ", is_bot: false },
		agent: input.agent,
		model: input.model,
		content: input.content ?? null,
	},
});

/** 投稿のメッセージに付いたボタンを持ち主が押す。 */
export const press = (
	threadId: string,
	messageId: string,
	customId: string,
	userId = OWNER,
): ButtonPressEvent =>
	({
		event_id: `e${++seq}`,
		payload: {
			guild_id: "g",
			channel_id: threadId,
			message_id: messageId,
			custom_id: customId,
			user: { id: userId, display_name: "ちゃぬ", is_bot: false },
		},
	}) as ButtonPressEvent;
