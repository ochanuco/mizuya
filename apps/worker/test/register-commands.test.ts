import { afterEach, describe, expect, it, vi } from "vitest";
import { COMMANDS } from "../src/commands.ts";
import { registerCommands } from "../src/register-commands.ts";
import { APPLICATION_ID, mockFetch } from "./helpers.ts";

afterEach(() => {
	vi.unstubAllGlobals();
});

const APP_URL = "https://discord.com/api/v10/applications/@me";
const COMMANDS_URL = `https://discord.com/api/v10/applications/${APPLICATION_ID}/commands`;

describe("コマンドの登録", () => {
	it("bot token で application を引き、定義をまとめて上書きする", async () => {
		const calls = mockFetch((c) => {
			if (c.url === APP_URL) return Response.json({ id: APPLICATION_ID });
			if (c.url === COMMANDS_URL) return Response.json([]);
			return undefined;
		});
		expect(await registerCommands("test-bot-token")).toEqual({
			ok: true,
			count: 1,
		});
		expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
			`GET ${APP_URL}`,
			`PUT ${COMMANDS_URL}`,
		]);
		expect(calls[1]?.headers.get("authorization")).toBe("Bot test-bot-token");
		expect(calls[1]?.body).toEqual(COMMANDS);
	});

	it("/ai は相手ごとのグループに、選べるモデルだけを持つ", () => {
		const ai = COMMANDS[0];
		expect(ai?.name).toBe("ai");
		expect(
			ai?.options.map((g) => [g.name, g.options.map((o) => o.name)]),
		).toEqual([
			["claude", ["opus", "sonnet", "haiku"]],
			["codex", ["terra", "sol", "luna"]],
		]);
	});

	it("登録が断られたら、どこで止まったかを返す", async () => {
		mockFetch((c) => {
			if (c.url === APP_URL) return Response.json({ id: APPLICATION_ID });
			return new Response("Missing Access", { status: 403 });
		});
		expect(await registerCommands("test-bot-token")).toEqual({
			ok: false,
			error: { step: "commands", status: 403, message: "Missing Access" },
		});
	});
});
