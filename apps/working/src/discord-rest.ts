import * as v from "valibot";
import {
	type DomainError,
	err,
	externalServiceUnavailable,
	ok,
	permissionDenied,
	type Result,
	rateLimited,
	validationFailed,
} from "./lib/core.ts";
import type { Logger } from "./logger.ts";

const API = "https://discord.com/api/v10";
/** Discord のメッセージ本文の上限。 */
export const MESSAGE_LIMIT = 2000;
/** フォーラム投稿の件名の上限。 */
export const THREAD_NAME_LIMIT = 100;
/** 1 件のメッセージに付けられるファイルの数。 */
export const ATTACHMENT_COUNT_LIMIT = 10;
/** ブーストしていないサーバーで 1 ファイルに許される大きさ。 */
export const ATTACHMENT_SIZE_LIMIT = 10 * 1024 * 1024;
/** 1 件のメッセージの要求全体の大きさ。本文と JSON の分を残す。 */
export const ATTACHMENT_TOTAL_LIMIT = 24 * 1024 * 1024;

/** 投稿に付けるファイル。 */
export type Attachment = {
	name: string;
	contentType: string;
	data: Uint8Array;
};

/** メッセージに付けるボタン。押されると mizuya の Worker が受け箱に置き、Working が受け取る。 */
export type Button = {
	customId: string;
	label: string;
	style: "secondary" | "success" | "danger";
};

const BUTTON_STYLE = { secondary: 2, success: 3, danger: 4 } as const;

/** ボタンを 1 行に並べる。Discord の components の形。 */
export const toComponents = (buttons: readonly Button[]) =>
	buttons.length === 0
		? []
		: [
				{
					type: 1,
					components: buttons.map((b) => ({
						type: 2,
						style: BUTTON_STYLE[b.style],
						label: b.label,
						custom_id: b.customId,
					})),
				},
			];

const userSchema = v.object({
	id: v.string(),
	username: v.string(),
	global_name: v.nullish(v.string()),
	bot: v.optional(v.boolean()),
});
const messageSchema = v.object({
	id: v.string(),
	channel_id: v.optional(v.string()),
	content: v.string(),
	author: userSchema,
	webhook_id: v.nullish(v.string()),
});
const sentSchema = v.object({ id: v.string() });
const channelSchema = v.object({
	id: v.string(),
	type: v.optional(v.number()),
	name: v.nullish(v.string()),
	parent_id: v.nullish(v.string()),
	applied_tags: v.optional(v.array(v.string())),
	available_tags: v.optional(
		v.array(v.object({ id: v.string(), name: v.string() })),
	),
});

export type ChannelInfo = {
	id: string;
	/** スレッド（フォーラムの投稿を含む）なら true。webhook はスレッドの親に付いている。 */
	isThread: boolean;
	name: string | null;
	parentId: string | null;
	appliedTagIds: string[];
	availableTags: { id: string; name: string }[];
};

export type PostedMessage = {
	id: string;
	authorId: string;
	authorName: string;
	isBot: boolean;
	/** webhook で書かれたメッセージ。authorName は webhook が名乗った名前。 */
	isWebhook: boolean;
	content: string;
};

export type DiscordApi = {
	me: () => Promise<Result<{ id: string }, DomainError>>;
	getChannel: (id: string) => Promise<Result<ChannelInfo, DomainError>>;
	getMessage: (
		channelId: string,
		messageId: string,
	) => Promise<Result<PostedMessage, DomainError>>;
	/** 古い順に返す。 */
	listMessages: (
		channelId: string,
		limit: number,
	) => Promise<Result<PostedMessage[], DomainError>>;
	createForumPost: (
		forumId: string,
		post: {
			name: string;
			content: string;
			tagIds: string[];
			buttons?: readonly Button[];
		},
	) => Promise<Result<{ threadId: string }, DomainError>>;
	/**
	 * 上限を超える本文は分けて送る。replyTo は最初の 1 件だけに、files と buttons は最後の 1 件だけに付ける。
	 * 送ったメッセージの ID を順に返す。
	 */
	send: (
		channelId: string,
		content: string,
		replyTo?: string,
		files?: readonly Attachment[],
		buttons?: readonly Button[],
	) => Promise<Result<{ messageIds: string[] }, DomainError>>;
	setTags: (
		threadId: string,
		tagIds: string[],
	) => Promise<Result<void, DomainError>>;
	/** 分けずに 1 件だけ送る。書き換える前提のメッセージに使う。 */
	createMessage: (
		channelId: string,
		content: string,
	) => Promise<Result<{ id: string }, DomainError>>;
	/** 本文を書き換え、付いていたボタンは外す。 */
	editMessage: (
		channelId: string,
		messageId: string,
		content: string,
	) => Promise<Result<void, DomainError>>;
	/** 入力中の表示を出す。Discord は約 10 秒で消すので、続けるなら送り直す。 */
	typing: (channelId: string) => Promise<Result<void, DomainError>>;
	/** bot 自身のリアクションを付ける。 */
	addReaction: (
		channelId: string,
		messageId: string,
		emoji: string,
	) => Promise<Result<void, DomainError>>;
	/** bot 自身のリアクションを外す。 */
	removeReaction: (
		channelId: string,
		messageId: string,
		emoji: string,
	) => Promise<Result<void, DomainError>>;
};

/** webhook の token は URL に入れて使う。application_id は webhook を作った application。 */
export type Webhook = {
	id: string;
	token: string | null;
	name: string | null;
	applicationId: string | null;
};

/** webhook で送るメッセージ。username と avatar_url は送るたびに名乗る。 */
export type WebhookMessage = {
	content: string;
	username?: string;
	avatarUrl?: string | null;
	buttons?: readonly Button[];
	files?: readonly Attachment[];
	/** フォーラムに新しい投稿を作るときの件名とタグ。 */
	threadName?: string;
	tagIds?: string[];
};

/** bot の token で webhook を作り、webhook の token で書く。 */
export type DiscordWebhookApi = {
	/** bot の application の ID。webhook を作った application を見分けるのに使う。 */
	applicationId: () => Promise<Result<string, DomainError>>;
	listWebhooks: (channelId: string) => Promise<Result<Webhook[], DomainError>>;
	createWebhook: (
		channelId: string,
		name: string,
	) => Promise<Result<Webhook, DomainError>>;
	/** 書いたメッセージの ID と、書いたチャンネル（新しい投稿ならそのスレッド）を返す。 */
	executeWebhook: (
		webhook: { id: string; token: string },
		threadId: string | null,
		message: WebhookMessage,
	) => Promise<Result<{ id: string; channelId: string }, DomainError>>;
	/** 本文を書き換え、付いていたボタンは外す。 */
	editWebhookMessage: (
		webhook: { id: string; token: string },
		threadId: string | null,
		messageId: string,
		content: string,
	) => Promise<Result<void, DomainError>>;
};

export type DiscordRest = DiscordApi & DiscordWebhookApi;

export type DiscordRestOptions = {
	token: string;
	/** 2xx 以外の応答を残す。未設定なら残さない。 */
	logger?: Logger;
	fetch?: typeof fetch;
	timeoutMs?: number;
};

const errorBodySchema = v.object({
	code: v.optional(v.number()),
	message: v.optional(v.string()),
});

/** Discord のエラーコード。Missing Access と Missing Permissions は bot の権限の不足。 */
const PERMISSION_CODES = new Set([50001, 50013]);

const toPosted = (m: v.InferOutput<typeof messageSchema>): PostedMessage => ({
	id: m.id,
	authorId: m.author.id,
	authorName: m.author.global_name ?? m.author.username,
	isBot: m.author.bot ?? false,
	isWebhook: m.webhook_id != null,
	content: m.content,
});

/** スレッドのチャンネルの type（公開・非公開・お知らせのスレッド）。 */
const THREAD_TYPES = new Set([10, 11, 12]);

const toChannel = (c: v.InferOutput<typeof channelSchema>): ChannelInfo => ({
	id: c.id,
	isThread: c.type !== undefined && THREAD_TYPES.has(c.type),
	name: c.name ?? null,
	parentId: c.parent_id ?? null,
	appliedTagIds: c.applied_tags ?? [],
	availableTags: c.available_tags ?? [],
});

/** 改行を優先して上限以下に切り分ける。 */
export const splitMessage = (text: string, limit = MESSAGE_LIMIT): string[] => {
	const chunks: string[] = [];
	let rest = text;
	while (rest.length > limit) {
		const cut = rest.lastIndexOf("\n", limit);
		const at = cut > 0 ? cut : limit;
		chunks.push(rest.slice(0, at));
		rest = rest.slice(at).replace(/^\n/, "");
	}
	if (rest.trim() !== "") chunks.push(rest);
	return chunks;
};

/** ファイルを付けるときは multipart で、本文は payload_json、ファイルは files[n] に入れる。 */
export const withFiles = (
	payload: Record<string, unknown>,
	files: readonly Attachment[],
): FormData => {
	const form = new FormData();
	form.append(
		"payload_json",
		JSON.stringify({
			...payload,
			attachments: files.map((f, id) => ({ id, filename: f.name })),
		}),
	);
	for (const [id, f] of files.entries()) {
		form.append(
			`files[${id}]`,
			new Blob([f.data as Uint8Array<ArrayBuffer>], { type: f.contentType }),
			f.name,
		);
	}
	return form;
};

const webhookSchema = v.object({
	id: v.string(),
	token: v.nullish(v.string()),
	name: v.nullish(v.string()),
	application_id: v.nullish(v.string()),
});

const toWebhook = (w: v.InferOutput<typeof webhookSchema>): Webhook => ({
	id: w.id,
	token: w.token ?? null,
	name: w.name ?? null,
	applicationId: w.application_id ?? null,
});

const webhookQuery = (threadId: string | null, wait: boolean) => {
	const q = new URLSearchParams({ with_components: "true" });
	if (wait) q.set("wait", "true");
	if (threadId) q.set("thread_id", threadId);
	return q.toString();
};

export const createDiscordRest = (opts: DiscordRestOptions): DiscordRest => {
	const doFetch = opts.fetch ?? fetch;
	const timeoutMs = opts.timeoutMs ?? 15_000;

	const call = async <T>(
		method: string,
		path: string,
		schema: v.GenericSchema<unknown, T> | null,
		body?: unknown,
		retried = false,
	): Promise<Result<T | undefined, DomainError>> => {
		let res: Response;
		// FormData は fetch が boundary 付きの content-type を付ける
		const form = body instanceof FormData;
		try {
			res = await doFetch(`${API}${path}`, {
				method,
				headers: {
					authorization: `Bot ${opts.token}`,
					...(body === undefined || form
						? {}
						: { "content-type": "application/json" }),
				},
				body: form
					? body
					: body === undefined
						? undefined
						: JSON.stringify(body),
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch {
			return err(externalServiceUnavailable({ service: "discord" }));
		}
		if (res.status === 429) {
			const retryAfter = Number(res.headers.get("retry-after") ?? "1");
			const waitMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 1000;
			// 投稿ごとに直列なので短い待ちなら 1 回だけ待ってやり直す
			if (!retried && waitMs <= 10_000) {
				await new Promise((r) => setTimeout(r, waitMs));
				return call(method, path, schema, body, true);
			}
			return err(rateLimited({ retryAfterMs: waitMs }));
		}
		if (!res.ok) {
			const parsed = v.safeParse(
				errorBodySchema,
				await res.json().catch(() => null),
			);
			const code = parsed.success ? (parsed.output.code ?? null) : null;
			// webhook の token は path に入るので、ログに残さない
			const route = `${method} ${(path.split("?")[0] ?? "").replace(/^\/webhooks\/([^/]+)\/[^/]+/, "/webhooks/$1/***")}`;
			opts.logger?.warn("discord request rejected", {
				route,
				status: res.status,
				code,
				message: parsed.success ? (parsed.output.message ?? null) : null,
			});
			if (res.status === 403 && code !== null && PERMISSION_CODES.has(code)) {
				return err(permissionDenied({ actor: "discord bot", action: route }));
			}
			return err(externalServiceUnavailable({ service: "discord" }));
		}
		if (schema === null) return ok(undefined);
		const parsed = v.safeParse(schema, await res.json().catch(() => null));
		if (!parsed.success) {
			return err(
				validationFailed({ issues: parsed.issues.map((i) => i.message) }),
			);
		}
		return ok(parsed.output);
	};

	const callJson = async <T>(
		method: string,
		path: string,
		schema: v.GenericSchema<unknown, T>,
		body?: unknown,
	): Promise<Result<T, DomainError>> =>
		(await call(method, path, schema, body)) as Result<T, DomainError>;

	const noMentions = { parse: [] as string[] };

	return {
		me: async () => {
			const r = await callJson("GET", "/users/@me", userSchema);
			return r.ok ? ok({ id: r.value.id }) : r;
		},
		getChannel: async (id) => {
			const r = await callJson("GET", `/channels/${id}`, channelSchema);
			return r.ok ? ok(toChannel(r.value)) : r;
		},
		getMessage: async (channelId, messageId) => {
			const r = await callJson(
				"GET",
				`/channels/${channelId}/messages/${messageId}`,
				messageSchema,
			);
			return r.ok ? ok(toPosted(r.value)) : r;
		},
		listMessages: async (channelId, limit) => {
			const r = await callJson(
				"GET",
				`/channels/${channelId}/messages?limit=${Math.min(limit, 100)}`,
				v.array(messageSchema),
			);
			// API は新しい順に返す
			return r.ok ? ok(r.value.map(toPosted).reverse()) : r;
		},
		createForumPost: async (forumId, post) => {
			const r = await callJson(
				"POST",
				`/channels/${forumId}/threads`,
				channelSchema,
				{
					name: post.name.slice(0, THREAD_NAME_LIMIT),
					applied_tags: post.tagIds,
					message: {
						content: post.content.slice(0, MESSAGE_LIMIT),
						allowed_mentions: noMentions,
						...(post.buttons?.length
							? { components: toComponents(post.buttons) }
							: {}),
					},
				},
			);
			return r.ok ? ok({ threadId: r.value.id }) : r;
		},
		send: async (channelId, content, replyTo, files = [], buttons = []) => {
			const split = splitMessage(content);
			const chunks = split.length === 0 && files.length > 0 ? [""] : split;
			const messageIds: string[] = [];
			for (const [i, chunk] of chunks.entries()) {
				const last = i === chunks.length - 1;
				const payload = {
					content: chunk,
					allowed_mentions: noMentions,
					...(last && buttons.length > 0
						? { components: toComponents(buttons) }
						: {}),
					...(i === 0 && replyTo
						? {
								message_reference: {
									message_id: replyTo,
									fail_if_not_exists: false,
								},
							}
						: {}),
				};
				const attach = last ? files : [];
				const r = await callJson(
					"POST",
					`/channels/${channelId}/messages`,
					sentSchema,
					attach.length === 0 ? payload : withFiles(payload, attach),
				);
				if (!r.ok) return r;
				messageIds.push(r.value.id);
			}
			return ok({ messageIds });
		},
		setTags: async (threadId, tagIds) => {
			const r = await call("PATCH", `/channels/${threadId}`, null, {
				applied_tags: tagIds,
			});
			return r.ok ? ok(undefined) : r;
		},
		createMessage: async (channelId, content) =>
			callJson("POST", `/channels/${channelId}/messages`, sentSchema, {
				content: content.slice(0, MESSAGE_LIMIT),
				allowed_mentions: noMentions,
			}),
		editMessage: async (channelId, messageId, content) => {
			const r = await call(
				"PATCH",
				`/channels/${channelId}/messages/${messageId}`,
				null,
				{
					content: content.slice(0, MESSAGE_LIMIT),
					allowed_mentions: noMentions,
					components: [],
				},
			);
			return r.ok ? ok(undefined) : r;
		},
		typing: async (channelId) => {
			const r = await call("POST", `/channels/${channelId}/typing`, null);
			return r.ok ? ok(undefined) : r;
		},
		addReaction: async (channelId, messageId, emoji) => {
			const r = await call(
				"PUT",
				`/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
				null,
			);
			return r.ok ? ok(undefined) : r;
		},
		removeReaction: async (channelId, messageId, emoji) => {
			const r = await call(
				"DELETE",
				`/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
				null,
			);
			return r.ok ? ok(undefined) : r;
		},
		applicationId: async () => {
			const r = await callJson(
				"GET",
				"/applications/@me",
				v.object({ id: v.string() }),
			);
			return r.ok ? ok(r.value.id) : r;
		},
		listWebhooks: async (channelId) => {
			const r = await callJson(
				"GET",
				`/channels/${channelId}/webhooks`,
				v.array(webhookSchema),
			);
			return r.ok ? ok(r.value.map(toWebhook)) : r;
		},
		createWebhook: async (channelId, name) => {
			const r = await callJson(
				"POST",
				`/channels/${channelId}/webhooks`,
				webhookSchema,
				{ name },
			);
			return r.ok ? ok(toWebhook(r.value)) : r;
		},
		executeWebhook: async (webhook, threadId, m) => {
			const payload = {
				content: m.content.slice(0, MESSAGE_LIMIT),
				allowed_mentions: noMentions,
				...(m.username ? { username: m.username } : {}),
				...(m.avatarUrl ? { avatar_url: m.avatarUrl } : {}),
				...(m.buttons?.length ? { components: toComponents(m.buttons) } : {}),
				...(m.threadName
					? {
							thread_name: m.threadName.slice(0, THREAD_NAME_LIMIT),
							applied_tags: m.tagIds ?? [],
						}
					: {}),
			};
			const files = m.files ?? [];
			const r = await callJson(
				"POST",
				`/webhooks/${webhook.id}/${webhook.token}?${webhookQuery(threadId, true)}`,
				messageSchema,
				files.length === 0 ? payload : withFiles(payload, files),
			);
			if (!r.ok) return r;
			return ok({
				id: r.value.id,
				channelId: r.value.channel_id ?? threadId ?? "",
			});
		},
		editWebhookMessage: async (webhook, threadId, messageId, content) => {
			const r = await call(
				"PATCH",
				`/webhooks/${webhook.id}/${webhook.token}/messages/${messageId}?${webhookQuery(threadId, false)}`,
				null,
				{
					content: content.slice(0, MESSAGE_LIMIT),
					allowed_mentions: noMentions,
					components: [],
				},
			);
			return r.ok ? ok(undefined) : r;
		},
	};
};
