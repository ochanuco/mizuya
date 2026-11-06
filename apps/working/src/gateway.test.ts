import { describe, expect, it } from "vitest";
import { type MessageLike, toWorkEnvelope } from "./gateway.ts";

const WHERE = { textChannelId: "text", forumChannelId: "forum" };
const NOW = new Date("2026-11-07T00:00:01.000Z");

const message = (m: Partial<MessageLike> = {}): MessageLike => ({
	id: "m1",
	guildId: "g",
	channelId: "text",
	parentId: null,
	content: "<@&r2> 請求書を整理して",
	createdAt: new Date("2026-11-07T00:00:00.000Z"),
	webhookId: null,
	author: { id: "u1", bot: false, displayName: "ちゃぬ" },
	mentionedUserIds: [],
	mentionedRoleIds: ["r2"],
	replyToMessageId: null,
	attachments: [{ name: "a.png", contentType: "image/png", size: 3 }],
	...m,
});

describe("toWorkEnvelope", () => {
	it("仕事チャンネルの発言を、メンションされた role と添付ごと envelope にする", () => {
		const e = toWorkEnvelope(message(), WHERE, NOW);
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
		expect(e?.occurred_at).toBe("2026-11-07T00:00:00.000Z");
		expect(e?.received_at).toBe("2026-11-07T00:00:01.000Z");
	});

	it("仕事フォーラムの投稿の中の発言も渡す", () => {
		const e = toWorkEnvelope(
			message({ channelId: "t1", parentId: "forum" }),
			WHERE,
			NOW,
		);
		expect(e?.payload.channel_id).toBe("t1");
	});

	it("ほかのチャンネル、DM、webhook の発言は渡さない", () => {
		expect(
			toWorkEnvelope(message({ channelId: "other" }), WHERE, NOW),
		).toBeNull();
		expect(toWorkEnvelope(message({ guildId: null }), WHERE, NOW)).toBeNull();
		expect(toWorkEnvelope(message({ webhookId: "h" }), WHERE, NOW)).toBeNull();
	});
});
