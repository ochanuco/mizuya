import { describe, expect, it } from "vitest";
import type { ButtonPressEvent } from "./discord-events.ts";
import type { GithubWorkEvent } from "./github-events.ts";
import { dispatchInboxMessage } from "./inbox.ts";
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

const dispatch = (message: unknown, github?: GithubWorkEvent[]) => {
	const pressed: ButtonPressEvent[] = [];
	const ack = dispatchInboxMessage(
		typeof message === "string" ? message : JSON.stringify(message),
		{
			press: (e) => pressed.push(e),
			...(github ? { github: (e: GithubWorkEvent) => github.push(e) } : {}),
		},
		silentLogger,
	);
	return { ack, pressed };
};

describe("受け箱の行", () => {
	it("ボタンは Working の頭を外した custom_id で渡し、ack する", () => {
		const { ack, pressed } = dispatch(button("working:approval:grant"));
		expect(ack).toBe("i1");
		expect(pressed).toHaveLength(1);
		expect(pressed[0]).toMatchObject({
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

	it("GitHub の出来事を渡して ack する。渡す先が無ければ捨てて ack する", () => {
		const event = {
			kind: "review",
			repo: "o/r",
			pr: 3,
			title: "t",
			state: "changes_requested",
			body: "直して",
			url: "u",
			actor: "reviewer",
			actor_is_bot: false,
		};
		const item = {
			type: "item",
			id: "g1",
			kind: "github",
			received_at: "2026-11-07T00:00:00.000Z",
			body: event,
		};
		const got: GithubWorkEvent[] = [];
		expect(dispatch(item, got).ack).toBe("g1");
		expect(got).toEqual([event]);
		expect(dispatch(item).ack).toBe("g1");
		const broken: GithubWorkEvent[] = [];
		expect(dispatch({ ...item, body: { kind: "review" } }, broken).ack).toBe(
			"g1",
		);
		expect(broken).toEqual([]);
	});
});
