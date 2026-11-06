import {
	type Button,
	type DiscordApi,
	type DiscordRest,
	MESSAGE_LIMIT,
	splitMessage,
	type Webhook,
} from "./discord-rest.ts";
import {
	type DomainError,
	err,
	externalServiceUnavailable,
	ok,
	type Result,
} from "./lib/core.ts";

/** Working が書くための webhook の名前。チャンネルごとに 1 つ作り、席ごとの名前は送るたびに名乗る。 */
export const WEBHOOK_NAME = "mizuya-working";

/**
 * Working のボタンの custom_id の頭。mizuya の Worker はこれで始まるボタンを Working の受け箱に置く。
 * 受け箱から受け取るときに外すので、席の側の custom_id は頭を持たない。
 */
export const WORKING_BUTTON_PREFIX = "working:";

type HookTarget = {
	webhook: { id: string; token: string };
	threadId: string | null;
};

export type WebhookDirectory = {
	/** チャンネルに書くための webhook と、スレッドなら thread_id。 */
	targetOf: (channelId: string) => Promise<Result<HookTarget, DomainError>>;
};

/**
 * webhook はスレッドには付けられないので、スレッドに書くときは親のチャンネル（仕事フォーラム）の webhook に thread_id を添える。
 * mizuya の application が作った webhook だけを使う。そうでない webhook ではボタンを押しても mizuya に届かない。
 */
export const createWebhookDirectory = (
	rest: DiscordRest,
	applicationId: string,
): WebhookDirectory => {
	const hooks = new Map<string, { id: string; token: string }>();
	const parents = new Map<string, string | null>();

	const own = (w: Webhook): w is Webhook & { token: string } =>
		w.applicationId === applicationId &&
		w.name === WEBHOOK_NAME &&
		w.token !== null;

	const hookOf = async (
		channelId: string,
	): Promise<Result<{ id: string; token: string }, DomainError>> => {
		const cached = hooks.get(channelId);
		if (cached) return ok(cached);
		const listed = await rest.listWebhooks(channelId);
		if (!listed.ok) return listed;
		let hook = listed.value.find(own);
		if (!hook) {
			const created = await rest.createWebhook(channelId, WEBHOOK_NAME);
			if (!created.ok) return created;
			if (!own(created.value)) {
				return err(externalServiceUnavailable({ service: "discord" }));
			}
			hook = created.value;
		}
		const value = { id: hook.id, token: hook.token };
		hooks.set(channelId, value);
		return ok(value);
	};

	/** スレッドなら親のチャンネル、そうでなければ null。 */
	const threadParentOf = async (
		channelId: string,
	): Promise<Result<string | null, DomainError>> => {
		if (parents.has(channelId)) return ok(parents.get(channelId) ?? null);
		const ch = await rest.getChannel(channelId);
		if (!ch.ok) return ch;
		const parent = ch.value.isThread ? ch.value.parentId : null;
		parents.set(channelId, parent);
		return ok(parent);
	};

	return {
		targetOf: async (channelId) => {
			const parent = await threadParentOf(channelId);
			if (!parent.ok) return parent;
			const hook = await hookOf(parent.value ?? channelId);
			if (!hook.ok) return hook;
			return ok({
				webhook: hook.value,
				threadId: parent.value === null ? null : channelId,
			});
		},
	};
};

export type SpeakerIdentity = {
	/** 席の名前。webhook がこの名前で書き、Working はこの名前でどの席の発言かを見分ける。 */
	name: string;
	avatarUrl: string | null;
};

/**
 * 席ごとの話し手。読む・タグ・リアクション・入力中の表示は mizuya の bot で行い、書くのは webhook で席の名前と画像を名乗る。
 * webhook では返信の形にできないので、replyTo は使わない。
 */
export const createSpeaker = (
	rest: DiscordRest,
	hooks: WebhookDirectory,
	who: SpeakerIdentity,
): DiscordApi => {
	const named = { username: who.name, avatarUrl: who.avatarUrl };
	const prefixed = (buttons: readonly Button[] = []) =>
		buttons.map((b) => ({
			...b,
			customId: `${WORKING_BUTTON_PREFIX}${b.customId}`,
		}));

	return {
		me: rest.me,
		getChannel: rest.getChannel,
		getMessage: rest.getMessage,
		listMessages: rest.listMessages,
		setTags: rest.setTags,
		typing: rest.typing,
		addReaction: rest.addReaction,
		removeReaction: rest.removeReaction,
		createForumPost: async (forumId, post) => {
			const hook = await hooks.targetOf(forumId);
			if (!hook.ok) return hook;
			const r = await rest.executeWebhook(hook.value.webhook, null, {
				...named,
				content: post.content,
				threadName: post.name,
				tagIds: post.tagIds,
				buttons: prefixed(post.buttons),
			});
			return r.ok ? ok({ threadId: r.value.channelId }) : r;
		},
		send: async (channelId, content, _replyTo, files = [], buttons = []) => {
			const hook = await hooks.targetOf(channelId);
			if (!hook.ok) return hook;
			const split = splitMessage(content);
			const chunks = split.length === 0 && files.length > 0 ? [""] : split;
			const messageIds: string[] = [];
			for (const [i, chunk] of chunks.entries()) {
				const last = i === chunks.length - 1;
				const r = await rest.executeWebhook(
					hook.value.webhook,
					hook.value.threadId,
					{
						...named,
						content: chunk,
						...(last ? { files, buttons: prefixed(buttons) } : {}),
					},
				);
				if (!r.ok) return r;
				messageIds.push(r.value.id);
			}
			return ok({ messageIds });
		},
		createMessage: async (channelId, content) => {
			const hook = await hooks.targetOf(channelId);
			if (!hook.ok) return hook;
			const r = await rest.executeWebhook(
				hook.value.webhook,
				hook.value.threadId,
				{ ...named, content: content.slice(0, MESSAGE_LIMIT) },
			);
			return r.ok ? ok({ id: r.value.id }) : r;
		},
		editMessage: async (channelId, messageId, content) => {
			const hook = await hooks.targetOf(channelId);
			if (!hook.ok) return hook;
			return rest.editWebhookMessage(
				hook.value.webhook,
				hook.value.threadId,
				messageId,
				content,
			);
		},
	};
};
