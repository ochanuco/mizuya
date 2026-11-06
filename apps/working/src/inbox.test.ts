import { describe, expect, it } from "vitest";
import { dispatchInboxMessage } from "./inbox.ts";
import type { DiscordButtonPressedEnvelope } from "./lib/protocol.ts";
import { silentLogger } from "./logger.ts";

const button = (customId: string) => ({
	type: "item",
	id: "i1",
	kind: "button",
	received_at: "2026-11-07T00:00:00.000Z",
	body: {
		guild_id: "g",
		channel_id: "t1",
		message_id: "m1",
		custom_id: customId,
		user: { id: "u1", display_name: "ちゃぬ", is_bot: false },
	},
});

const dispatch = (message: unknown) => {
	const pressed: DiscordButtonPressedEnvelope[] = [];
	const ack = dispatchInboxMessage(
		typeof message === "string" ? message : JSON.stringify(message),
		{ press: (e) => pressed.push(e) },
		silentLogger,
		() => new Date("2026-11-07T00:00:01.000Z"),
	);
	return { ack, pressed };
};

describe("受け箱の行", () => {
	it("ボタンは Working の頭を外した custom_id で渡し、ack する", () => {
		const { ack, pressed } = dispatch(button("working:approval:grant"));
		expect(ack).toBe("i1");
		expect(pressed).toHaveLength(1);
		expect(pressed[0]).toMatchObject({
			type: "discord.button.pressed",
			occurred_at: "2026-11-07T00:00:00.000Z",
			received_at: "2026-11-07T00:00:01.000Z",
			payload: {
				channel_id: "t1",
				message_id: "m1",
				custom_id: "approval:grant",
				user: { id: "u1" },
			},
		});
	});

	it("知らない種類と読めないボタンは渡さずに ack する", () => {
		expect(dispatch({ ...button("x"), kind: "other" })).toEqual({
			ack: "i1",
			pressed: [],
		});
		expect(dispatch({ ...button("x"), body: { custom_id: "x" } })).toEqual({
			ack: "i1",
			pressed: [],
		});
	});

	it("pong と読めないメッセージは ack しない", () => {
		expect(dispatch("pong")).toEqual({ ack: null, pressed: [] });
		expect(dispatch("{")).toEqual({ ack: null, pressed: [] });
		expect(dispatch({ type: "hello" })).toEqual({ ack: null, pressed: [] });
	});
});
