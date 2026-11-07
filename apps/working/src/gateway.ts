import { randomUUID } from "node:crypto";
import {
	ActivityType,
	Client,
	Events,
	GatewayIntentBits,
	type Message,
} from "discord.js";
import {
	DISCORD_MESSAGE_CREATED,
	DISCORD_SOURCE,
	type DiscordMessageCreatedEnvelope,
} from "./lib/protocol.ts";
import type { Logger } from "./logger.ts";

/** Gateway のメッセージのうち、受付が読む分だけの構造型。 */
export type MessageLike = {
	id: string;
	guildId: string | null;
	channelId: string;
	/** スレッドなら親のチャンネル。 */
	parentId: string | null;
	content: string;
	createdAt: Date;
	webhookId: string | null;
	author: { id: string; bot: boolean; displayName: string };
	mentionedUserIds: string[];
	mentionedRoleIds: string[];
	replyToMessageId: string | null;
	attachments: { name: string; contentType: string | null; size: number }[];
};

/**
 * 仕事チャンネルと仕事フォーラムの投稿に書かれたメッセージを、受付の envelope にする。それ以外と webhook の発言は null。
 * webhook の発言は席の話し手が書いたもので、受付が自分で書いたものを読み直さない。
 */
export const toWorkEnvelope = (
	m: MessageLike,
	where: { textChannelId: string; forumChannelId: string },
	now: Date,
): DiscordMessageCreatedEnvelope | null => {
	if (m.guildId === null || m.webhookId !== null) return null;
	const inWork =
		m.channelId === where.textChannelId || m.parentId === where.forumChannelId;
	if (!inWork) return null;
	return {
		event_id: randomUUID(),
		type: DISCORD_MESSAGE_CREATED,
		source: DISCORD_SOURCE,
		partner_id: "yukarin",
		occurred_at: m.createdAt.toISOString(),
		received_at: now.toISOString(),
		schema_version: 1,
		payload: {
			guild_id: m.guildId,
			channel_id: m.channelId,
			message_id: m.id,
			author: {
				id: m.author.id,
				display_name: m.author.displayName || m.author.id,
				is_bot: m.author.bot,
			},
			content: m.content,
			mentions: m.mentionedUserIds,
			mention_roles: m.mentionedRoleIds,
			reply_to_message_id: m.replyToMessageId,
			attachments: m.attachments.map((a) => ({
				name: a.name,
				content_type: a.contentType,
				size: a.size,
			})),
		},
	};
};

const toMessageLike = (m: Message): MessageLike => ({
	id: m.id,
	guildId: m.guildId,
	channelId: m.channelId,
	parentId: m.channel.isThread() ? m.channel.parentId : null,
	content: m.content,
	createdAt: m.createdAt,
	webhookId: m.webhookId,
	author: {
		id: m.author.id,
		bot: m.author.bot,
		displayName: m.member?.displayName ?? m.author.displayName,
	},
	mentionedUserIds: [...m.mentions.users.keys()],
	mentionedRoleIds: [...m.mentions.roles.keys()],
	replyToMessageId: m.reference?.messageId ?? null,
	attachments: [...m.attachments.values()].map((a) => ({
		name: a.name,
		contentType: a.contentType,
		size: a.size,
	})),
});

export type WorkGateway = {
	/** bot のステータスを書き換える。null で消す。 */
	setActivity: (text: string | null) => void;
	/** application の説明文（プロフィールの自己紹介欄）を書き換える。失敗したら false。 */
	setBio: (text: string) => Promise<boolean>;
	stop: () => Promise<void>;
};

/**
 * mizuya の bot で Gateway につなぎ、仕事チャンネルと仕事フォーラムのメッセージを受付に渡す。
 * ボタンは application の Interactions Endpoint URL（mizuya の Worker）に届くので、ここには来ない。
 */
export const startWorkGateway = async (opts: {
	token: string;
	textChannelId: string;
	forumChannelId: string;
	accept: (envelope: DiscordMessageCreatedEnvelope) => void;
	logger: Logger;
}): Promise<WorkGateway> => {
	const log = opts.logger;
	const client = new Client({
		intents: [
			GatewayIntentBits.Guilds,
			GatewayIntentBits.GuildMessages,
			GatewayIntentBits.MessageContent,
		],
	});
	client.on(Events.MessageCreate, (message) => {
		if (message.author.id === client.user?.id) return;
		const envelope = toWorkEnvelope(
			toMessageLike(message),
			{
				textChannelId: opts.textChannelId,
				forumChannelId: opts.forumChannelId,
			},
			new Date(),
		);
		if (envelope) opts.accept(envelope);
	});
	client.on(Events.Error, (e) => {
		log.warn("gateway error", { error: String(e) });
	});
	const ready = new Promise<void>((resolve) => {
		client.once(Events.ClientReady, (c) => {
			log.info("gateway ready", { bot_user_id: c.user.id });
			resolve();
		});
	});
	await client.login(opts.token);
	await ready;
	return {
		setActivity: (text) => {
			if (text === null) client.user?.setPresence({ activities: [] });
			else client.user?.setActivity(text, { type: ActivityType.Custom });
		},
		setBio: async (text) => {
			try {
				await client.application?.edit({ description: text });
				return true;
			} catch (e) {
				log.warn("usage bio update failed", { error: String(e) });
				return false;
			}
		},
		stop: () => client.destroy(),
	};
};
