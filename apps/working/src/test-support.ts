import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import type { ApprovalRequest, ApprovalStore } from "./approval-store.ts";
import {
	CHAKAI_STATES,
	type Chakai,
	type ChakaiState,
	type ChakaiTask,
} from "./chakai.ts";
import type {
	ButtonPressEvent,
	CommandEvent,
	WorkMessageEvent,
} from "./discord-events.ts";
import type { ChannelInfo, DiscordApi, PostedMessage } from "./discord-rest.ts";
import { createLedger } from "./guard/ledger.ts";
import type {
	Hishaku,
	HishakuError,
	LeaseError,
	Prepared,
	PrepareError,
	Renewed,
	SessionMeta,
} from "./hishaku.ts";
import {
	err,
	externalServiceUnavailable,
	ok,
	type PartnerId,
	permissionDenied,
	type Result,
} from "./lib/core.ts";
import type {
	SeatEngine,
	SeatEngineError,
	SeatHandle,
	SeatHow,
	SeatMessage,
	SeatPrepare,
} from "./seat-engine.ts";

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

/** 状態のタグに絵文字を付けたフォーラムのタグ。件名の頭の絵文字を見るテストで使う。 */
export const EMOJI_OF: Record<string, string> = {
	完了: "🎉",
	決めてほしい: "🤔",
	見張り中: "👀",
	引き継ぎ: "👨‍💼",
	作業中: "👷",
};
export const EMOJI_TAGS = TAGS.map((t) => ({
	...t,
	emoji: EMOJI_OF[t.name] ?? null,
}));

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
	/** threadExists が確かめられない投稿。 */
	const unreachable = new Set<string>();
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
		threadExists: async (id) =>
			unreachable.has(id)
				? err(externalServiceUnavailable({ service: "discord" }))
				: ok(channels.has(id)),
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
		renameThread: vi.fn(async (threadId: string, name: string) => {
			const ch = channels.get(threadId);
			if (ch) channels.set(threadId, { ...ch, name });
			return ok(undefined);
		}),
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
		unreachable,
		typing,
		reactionsOn,
		edited,
		addThread,
		tagsOf,
		sentTo,
		interactionReplies,
	};
};

/**
 * 席エンジンのモック。席を作る・続きを渡す・止める・消す、を呼ばれた順に残す。
 * 席から受付に届くメッセージは、テストが intake.onSeatMessage に直接渡す。
 */
export const fakeEngine = (seatsDir = "/seats") => {
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
	/** 本物と同じく agent を起こす前に prepare を呼び、決まった起こし方（how）と spec を残す。 */
	const launch = async (
		op: string,
		input: { spec: string; prepare?: SeatPrepare },
		path: string,
		how: SeatHow,
	): Promise<Result<void, SeatEngineError>> => {
		const prepared = input.prepare ? await input.prepare(path) : null;
		if (prepared && !prepared.ok) {
			calls.push({ op, args: { ...input, how: null } });
			return err({
				type: "SeatLeaseHeld",
				command: "hs prepare",
				reason: prepared.error.holder,
			});
		}
		calls.push({
			op,
			args: {
				...input,
				how: prepared?.value.how ?? how,
				spec: prepared?.value.spec ?? input.spec,
				lease: prepared?.value.lease ?? null,
			},
		});
		return ok(undefined);
	};
	const engine: SeatEngine = {
		start: vi.fn(async () => ok(undefined)),
		startSeat: vi.fn(async (input) => {
			const path = `${seatsDir}/${input.name}`;
			const launched = await launch("startSeat", input, path, "start");
			if (!launched.ok) return launched;
			worktrees.add(path);
			return ok(handle(path));
		}),
		resumeSeat: vi.fn(async (input) => {
			if (!worktrees.has(input.path)) {
				calls.push({ op: "resumeSeat", args: input });
				return err({
					type: "SeatWorktreeMissing" as const,
					command: "resume",
					reason: input.path,
				});
			}
			const launched = await launch("resumeSeat", input, input.path, "resume");
			if (!launched.ok) return launched;
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
	return { engine, calls, live, worktrees, strayTerminals, opsOf };
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

/**
 * hishaku のモック。番号の払い出しと hs の呼び出しを呼ばれた順に残す。
 * 返す結果はテストが書き換える。既定は番号 1234、正本の記録なし（Claude は新しい ID で始める）。
 */
export const fakeHishaku = () => {
	const calls: { op: string; args: unknown }[] = [];
	let generation = 0;
	const behavior = {
		create: (): Result<{ number: number }, HishakuError> =>
			ok({ number: 1234 }),
		prepare: (): Result<Prepared, PrepareError> =>
			ok({
				agent: "claude",
				sessionId: "11111111-2222-4333-8444-555555555555",
				resume: false,
				generation: ++generation,
			}),
		push: (): Result<void, LeaseError> => ok(undefined),
		renew: (): Result<Renewed, LeaseError> => ok({ releaseRequestedBy: null }),
		meta: (): Result<SessionMeta, HishakuError> =>
			ok({
				holder: null,
				generation: generation,
				leaseExpiresAt: null,
				pushedAt: null,
				repo: null,
				branch: null,
			}),
		update: (): Result<void, HishakuError> => ok(undefined),
	};
	const hishaku: Hishaku = {
		holder: "box01",
		createSession: vi.fn(async (input) => {
			calls.push({ op: "createSession", args: input });
			return behavior.create();
		}),
		prepare: vi.fn(async (input) => {
			calls.push({ op: "prepare", args: input });
			return behavior.prepare();
		}),
		push: vi.fn(async (input) => {
			calls.push({ op: "push", args: input });
			return behavior.push();
		}),
		renew: vi.fn(async (input) => {
			calls.push({ op: "renew", args: input });
			return behavior.renew();
		}),
		meta: vi.fn(async (number: number) => {
			calls.push({ op: "meta", args: number });
			return behavior.meta();
		}),
		update: vi.fn(async (number: number, input) => {
			calls.push({ op: "update", args: { number, ...input } });
			return behavior.update();
		}),
	};
	const opsOf = (op: string) =>
		calls.filter((c) => c.op === op).map((c) => c.args);
	return { hishaku, calls, behavior, opsOf };
};

type FakeTask = ChakaiTask & { waitingOn: string | null };

/**
 * chakai の偽物。台帳を手元に持ち、本物と同じ決まり（review には waiting_on が要る、
 * 子がすべて片付いた親は review になる、next は木の順で最初の todo）で動く。
 * failOn に入れた操作は失敗させる。
 */
export const fakeChakai = () => {
	const tasks = new Map<string, FakeTask>();
	const repos = new Map<string, string[]>();
	const runs: {
		id: string;
		actor: PartnerId;
		taskId: string;
		seat: string;
		model: string | null;
		hishakuNo: number | null;
		ended: boolean;
	}[] = [];
	const calls: string[] = [];
	const failOn = new Set<string>();
	/** 検索が 1 回に返す数。本物は 90。 */
	const searchLimit = { value: 90 };
	const failed = (code: string | null, reason: string) =>
		err({ type: "ChakaiFailed" as const, code, reason });
	const guard = (op: string, detail: string) => {
		calls.push(`${op} ${detail}`.trim());
		return failOn.has(op) ? failed(null, `${op} failed`) : null;
	};
	const add = (t: Partial<FakeTask> & Pick<FakeTask, "id">): FakeTask => {
		const task: FakeTask = {
			projectId: "pj1",
			parentId: null,
			title: `タスク ${t.id}`,
			body: "",
			state: "todo",
			assigneeId: null,
			waitingOn: null,
			...t,
		};
		tasks.set(task.id, task);
		return task;
	};
	const childrenOf = (id: string) =>
		[...tasks.values()].filter((t) => t.parentId === id);
	const descendantsOf = (id: string): FakeTask[] =>
		childrenOf(id).flatMap((c) => [c, ...descendantsOf(c.id)]);
	const settle = (parentId: string | null) => {
		const parent = parentId === null ? undefined : tasks.get(parentId);
		if (!parent || (parent.state !== "todo" && parent.state !== "doing"))
			return;
		const kids = childrenOf(parent.id);
		if (kids.every((k) => k.state === "done" || k.state === "dropped")) {
			tasks.set(parent.id, {
				...parent,
				state: "review",
				waitingOn: "子タスクがすべて片付いた",
			});
		}
	};
	/** 席の agent が MCP で動かしたことにする。 */
	const move = (id: string, state: ChakaiState, waitingOn?: string) => {
		const t = tasks.get(id);
		if (!t) throw new Error(`no task ${id}`);
		tasks.set(id, { ...t, state, waitingOn: waitingOn ?? null });
		settle(t.parentId);
	};
	const chakai: Chakai = {
		projects: async (actor) =>
			guard("projects", actor) ??
			ok(
				[
					...new Set([
						...repos.keys(),
						...[...tasks.values()].map((t) => t.projectId),
					]),
				]
					.sort()
					.map((id) => ({ id, repos: repos.get(id) ?? [] })),
			),
		assigned: async (actor, projectId, state) => {
			const bad = guard("assigned", `${actor} ${projectId} ${state}`);
			if (bad) return bad;
			const all = [...tasks.values()].filter(
				(t) =>
					t.projectId === projectId &&
					t.state === state &&
					t.assigneeId === actor,
			);
			return ok({
				tasks: all.slice(0, searchLimit.value),
				full: all.length >= searchLimit.value,
			});
		},
		children: async (_actor, id) => guard("children", id) ?? ok(childrenOf(id)),
		getTask: async (_actor, id) => {
			const t = tasks.get(id);
			return (
				guard("getTask", id) ??
				(t ? ok(t) : failed("task_not_found", "404 task_not_found"))
			);
		},
		hasChildren: async (_actor, id) =>
			guard("hasChildren", id) ?? ok(childrenOf(id).length > 0),
		updateTask: async (_actor, id, patch) => {
			const bad = guard(
				"updateTask",
				`${id} ${patch.state}${patch.waiting_on ? ` ${patch.waiting_on}` : ""}`,
			);
			if (bad) return bad;
			const t = tasks.get(id);
			if (!t) return failed("task_not_found", "404 task_not_found");
			if (patch.state === "review" && !patch.waiting_on) {
				return failed("waiting_on_required", "400 waiting_on_required");
			}
			if (patch.state !== "review" && patch.waiting_on) {
				return failed(
					"waiting_on_only_in_review",
					"400 waiting_on_only_in_review",
				);
			}
			move(id, patch.state, patch.waiting_on);
			return ok(tasks.get(id) ?? t);
		},
		nextTask: async (_actor, parentId) => {
			const bad = guard("nextTask", parentId);
			if (bad) return bad;
			const all = descendantsOf(parentId);
			const states = Object.fromEntries(
				CHAKAI_STATES.map((s) => [s, all.filter((t) => t.state === s).length]),
			) as Record<ChakaiState, number>;
			return ok({ task: all.find((t) => t.state === "todo") ?? null, states });
		},
		startRun: async (actor, input) => {
			const bad = guard("startRun", input.taskId);
			if (bad) return bad;
			const task = tasks.get(input.taskId);
			if (!task || (repos.get(task.projectId) ?? []).length === 0) {
				return failed("repo_required", "400 repo_required");
			}
			const id = `run${runs.length + 1}`;
			runs.push({ id, actor, ...input, ended: false });
			return ok({ id });
		},
		endRun: async (_actor, runId) => {
			const bad = guard("endRun", runId);
			if (bad) return bad;
			const run = runs.find((r) => r.id === runId);
			if (!run) return failed("run_not_found", "404 run_not_found");
			run.ended = true;
			return ok(undefined);
		},
	};
	return { chakai, tasks, repos, runs, calls, failOn, searchLimit, add, move };
};
