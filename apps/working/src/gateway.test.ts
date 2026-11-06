import { describe, expect, it } from "vitest";
import { type MessageLike, toWorkMessage } from "./gateway.ts";

const WHERE = { textChannelId: "text", forumChannelId: "forum" };

const message = (m: Partial<MessageLike> = {}): MessageLike => ({
	id: "m1",
	guildId: "g",
	channelId: "text",
	parentId: null,
	content: "<@&r2> 請求書を整理して",
	webhookId: null,
	author: { id: "u1", bot: false, displayName: "ちゃぬ" },
	mentionedUserIds: [],
	mentionedRoleIds: ["r2"],
	replyToMessageId: null,
	attachments: [{ name: "a.png", contentType: "image/png", size: 3 }],
	...m,
});

describe("toWorkMessage", () => {
	it("仕事チャンネルの発言を、メンションされた role と添付ごと受付の出来事にする", () => {
		const e = toWorkMessage(message(), WHERE);
		expect(e?.payload).toEqual({
			guild_id: "g",
			channel_id: "text",
			message_id: "m1",
			author: { id: "u1", display_name: "ちゃぬ", is_bot: false },
			content: "<@&r2> 請求書を整理して",
			mentions: [],
			mention_roles: ["r2"],
			reply_to_message_id: null,
			attachments: [{ name: "a.png", content_type: "image/png", size: 3 }],
		});
	});

	it("仕事フォーラムの投稿の中の発言も渡す", () => {
		const e = toWorkMessage(
			message({ channelId: "t1", parentId: "forum" }),
			WHERE,
		);
		expect(e?.payload.channel_id).toBe("t1");
	});

	it("ほかのチャンネル、DM、webhook の発言は渡さない", () => {
		expect(toWorkMessage(message({ channelId: "other" }), WHERE)).toBeNull();
		expect(toWorkMessage(message({ guildId: null }), WHERE)).toBeNull();
		expect(toWorkMessage(message({ webhookId: "h" }), WHERE)).toBeNull();
	});
});
