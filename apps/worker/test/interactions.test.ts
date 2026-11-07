import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../src/env.ts";
import { pendingMessage, REPO, RUN_ID } from "./fixtures.ts";
import {
	APPLICATION_ID,
	APPROVER_ID,
	type Call,
	callWorker,
	discordSignature,
	makeEnv,
	mockFetch,
	OTHER_USER_ID,
} from "./helpers.ts";

afterEach(() => {
	vi.unstubAllGlobals();
});

const PENDING_URL = `https://api.github.com/repos/${REPO}/actions/runs/${RUN_ID}/pending_deployments`;
const ORIGINAL_URL = `https://discord.com/api/v10/webhooks/${APPLICATION_ID}/interaction-token/messages/@original`;

async function interaction(
	payload: unknown,
	options: { tamper?: boolean } = {},
): Promise<{
	env: Bindings;
	inbox: Awaited<ReturnType<typeof makeEnv>>["inbox"];
	response: Response;
	settled: () => Promise<void>;
}> {
	const { env, discordKey, inbox } = await makeEnv();
	const body = JSON.stringify(payload);
	const timestamp = String(Math.floor(Date.now() / 1000));
	const signature = await discordSignature(
		discordKey.privateKey,
		timestamp,
		body,
	);
	const request = new Request(
		"https://mizuya.example.com/discord/interactions",
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-signature-ed25519": signature,
				"x-signature-timestamp": timestamp,
			},
			body: options.tamper ? `${body} ` : body,
		},
	);
	return { env, inbox, ...(await callWorker(request, env)) };
}

function buttonPress(customId: string, userId = APPROVER_ID) {
	return {
		type: 3,
		application_id: APPLICATION_ID,
		token: "interaction-token",
		member: { user: { id: userId } },
		data: { custom_id: customId, component_type: 2 },
		message: pendingMessage("target"),
	};
}

const approve = "mizuya:approve";
const reject = "mizuya:reject";
const FOLLOWUP_URL = `https://discord.com/api/v10/webhooks/${APPLICATION_ID}/interaction-token`;

function githubAndDiscord(
	pending: unknown = [
		{
			environment: { id: 11, name: "production-approval" },
			current_user_can_approve: true,
		},
		{
			environment: { id: 22, name: "staging" },
			current_user_can_approve: true,
		},
	],
	review: Response = Response.json([]),
) {
	return mockFetch((call: Call) => {
		if (call.url === PENDING_URL && call.method === "GET") {
			return Response.json(pending);
		}
		if (call.url === PENDING_URL && call.method === "POST") return review;
		if (call.url === ORIGINAL_URL) return Response.json({});
		if (call.url === FOLLOWUP_URL) return Response.json({});
		return undefined;
	});
}

type EditBody = {
	content?: string;
	allowed_mentions?: unknown;
	embeds: {
		title?: string;
		color: number;
		fields: { name: string; value: string }[];
	}[];
	components: unknown[];
};

describe("POST /discord/interactions", () => {
	it("署名が合わなければ 401", async () => {
		const calls = mockFetch(() => undefined);
		const { response } = await interaction(
			{ type: 1, application_id: APPLICATION_ID, token: "t" },
			{ tamper: true },
		);
		expect(response.status).toBe(401);
		expect(calls).toHaveLength(0);
	});

	it("PING には PONG を返す", async () => {
		const { response } = await interaction({
			type: 1,
			application_id: APPLICATION_ID,
			token: "t",
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ type: 1 });
	});

	it("承認者以外が押したら ephemeral で断り、GitHub を呼ばない", async () => {
		const calls = githubAndDiscord();
		const { response, settled } = await interaction(
			buttonPress(approve, OTHER_USER_ID),
		);
		await settled();
		expect(await response.json()).toEqual({
			type: 4,
			data: {
				content: "このボタンは承認者だけが押せます。",
				flags: 64,
				allowed_mentions: { parse: [] },
			},
		});
		expect(calls).toHaveLength(0);
	});

	it("承認は deferred update を返し、該当 Environment だけを approved で送ってからメッセージを書き換える", async () => {
		const calls = githubAndDiscord();
		const { response, settled } = await interaction(buttonPress(approve));
		expect(await response.json()).toEqual({ type: 6 });
		await settled();

		expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
			`GET ${PENDING_URL}`,
			`POST ${PENDING_URL}`,
			`PATCH ${ORIGINAL_URL}`,
		]);
		const post = calls[1];
		expect(post?.headers.get("authorization")).toBe("Bearer test-github-token");
		expect(post?.headers.get("x-github-api-version")).toBe("2022-11-28");
		expect(post?.body).toEqual({
			environment_ids: [11],
			state: "approved",
			comment: "mizuya: Discord から承認",
		});

		const edit = calls[2]?.body as EditBody;
		expect(edit.components).toEqual([]);
		expect(edit.embeds[0]?.title).toBe(`承認: ${REPO}`);
		expect(edit.embeds[0]?.fields.at(-1)?.value).toBe(
			`承認（Discord で <@${APPROVER_ID}>）`,
		);
		expect(edit.content).toBe(`<@${APPROVER_ID}> 承認しました`);
		expect(edit.allowed_mentions).toEqual({ parse: [] });
	});

	it("却下は rejected で送る", async () => {
		const calls = githubAndDiscord();
		const { settled } = await interaction(buttonPress(reject));
		await settled();
		expect(calls[1]?.body).toEqual({
			environment_ids: [11],
			state: "rejected",
			comment: "mizuya: Discord から却下",
		});
		const edit = calls[2]?.body as EditBody;
		expect(edit.embeds[0]?.title).toBe(`却下: ${REPO}`);
		expect(edit.content).toBe(`<@${APPROVER_ID}> 却下しました`);
		expect(edit.allowed_mentions).toEqual({ parse: [] });
		expect(edit.embeds[0]?.fields.at(-1)?.value).toBe(
			`却下（Discord で <@${APPROVER_ID}>）`,
		);
	});

	it("承認待ちが残っていなければ、GitHub に送らず押した人にだけ伝え、メッセージは書き換えない", async () => {
		const calls = githubAndDiscord([
			{
				environment: { id: 22, name: "staging" },
				current_user_can_approve: true,
			},
		]);
		const { settled } = await interaction(buttonPress(approve));
		await settled();
		expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
			`GET ${PENDING_URL}`,
			`POST ${FOLLOWUP_URL}`,
		]);
		expect(calls[1]?.body).toMatchObject({ flags: 64 });
	});

	it("承認できない Environment なら GitHub に送らず、エラーを書いてボタンを残す", async () => {
		const calls = githubAndDiscord([
			{
				environment: { id: 11, name: "production-approval" },
				current_user_can_approve: false,
			},
		]);
		const { settled } = await interaction(buttonPress(approve));
		await settled();
		expect(calls.map((c) => c.method)).toEqual(["GET", "PATCH"]);
		const edit = calls[1]?.body as EditBody;
		expect(edit.components).toEqual(pendingMessage("target").components);
		expect(edit.embeds[0]?.fields.at(-1)?.name).toBe("直近のエラー");
	});

	it("GitHub API が失敗したら、ステータスとメッセージを書き、押し直せるようボタンを残す", async () => {
		const calls = githubAndDiscord(
			undefined,
			Response.json({ message: "Resource not accessible" }, { status: 403 }),
		);
		const { settled } = await interaction(buttonPress(approve));
		await settled();
		const edit = calls[2]?.body as EditBody;
		expect(edit.components).toEqual(pendingMessage("target").components);
		// 失敗では本文を変えない
		expect(edit.content).toBeUndefined();
		expect(edit.embeds[0]?.fields.at(-1)).toEqual({
			name: "直近のエラー",
			value: "承認に失敗: GitHub 403: Resource not accessible",
			inline: false,
		});
	});

	it("mizuya の承認待ちでないメッセージのボタンは断る", async () => {
		const calls = githubAndDiscord();
		const press = buttonPress(approve);
		const { response } = await interaction({
			...press,
			message: { ...press.message, embeds: [] },
		});
		expect(await response.json()).toMatchObject({
			type: 4,
			data: { flags: 64 },
		});
		expect(calls).toHaveLength(0);
	});

	describe("Working のボタン", () => {
		function workingPress(customId: string) {
			return {
				type: 3,
				application_id: APPLICATION_ID,
				token: "interaction-token",
				guild_id: "400000000000000001",
				channel_id: "400000000000000002",
				member: {
					user: { id: OTHER_USER_ID, username: "someone", global_name: "誰か" },
					nick: null,
				},
				data: { custom_id: customId, component_type: 2 },
				message: { id: "400000000000000003" },
			};
		}

		it("deferred update を返し、受け箱に置く。承認の処理は通らない", async () => {
			const calls = mockFetch(() => undefined);
			const { response, settled, inbox } = await interaction(
				workingPress("working:approval:grant"),
			);
			expect(await response.json()).toEqual({ type: 6 });
			await settled();
			expect(calls).toHaveLength(0);
			expect(inbox.puts).toEqual([
				{
					kind: "button",
					dedupe: null,
					body: {
						guild_id: "400000000000000001",
						channel_id: "400000000000000002",
						message_id: "400000000000000003",
						custom_id: "working:approval:grant",
						user: { id: OTHER_USER_ID, display_name: "誰か", is_bot: false },
					},
				},
			]);
		});

		it("サーバーの外のボタンは断る", async () => {
			const press = { ...workingPress("working:thread:dismiss") } as Record<
				string,
				unknown
			>;
			delete press.guild_id;
			const { response, inbox } = await interaction(press);
			expect(((await response.json()) as { type: number }).type).toBe(4);
			expect(inbox.puts).toEqual([]);
		});

		it("頭が working: でないボタンは受け箱に置かない", async () => {
			const { response, inbox } = await interaction(
				workingPress("approval:grant"),
			);
			expect(((await response.json()) as { type: number }).type).toBe(4);
			expect(inbox.puts).toEqual([]);
		});
	});

	describe("/ai コマンド", () => {
		const GUILD = "400000000000000001";
		const TEXT_CHANNEL = "400000000000000002";
		const THREAD = "400000000000000004";
		const user = {
			id: OTHER_USER_ID,
			username: "someone",
			global_name: "誰か",
		};

		function command(
			group: string,
			model: string,
			channel: { id: string; type: number; parent_id?: string },
		) {
			return {
				type: 2,
				application_id: APPLICATION_ID,
				token: "interaction-token",
				guild_id: GUILD,
				channel_id: channel.id,
				channel,
				member: { user, nick: null },
				data: {
					name: "ai",
					type: 1,
					options: [
						{ type: 2, name: group, options: [{ type: 1, name: model }] },
					],
				},
			};
		}

		function submit(customId: string, value: string) {
			return {
				type: 5,
				application_id: APPLICATION_ID,
				token: "interaction-token",
				guild_id: GUILD,
				channel_id: TEXT_CHANNEL,
				member: { user, nick: "ちゃぬ" },
				data: {
					custom_id: customId,
					components: [
						{
							type: 1,
							components: [{ type: 4, custom_id: "request", value }],
						},
					],
				},
			};
		}

		it("投稿の外では、依頼を書く modal を返し、受け箱には置かない", async () => {
			const { response, inbox } = await interaction(
				command("claude", "sonnet", { id: TEXT_CHANNEL, type: 0 }),
			);
			const body = (await response.json()) as {
				type: number;
				data: { custom_id: string; components: unknown[] };
			};
			expect(body.type).toBe(9);
			expect(body.data.custom_id).toBe("ai:claude:sonnet");
			expect(body.data.components).toEqual([
				{
					type: 1,
					components: [
						{
							type: 4,
							custom_id: "request",
							label: "依頼",
							style: 2,
							required: true,
							max_length: 4000,
						},
					],
				},
			]);
			expect(inbox.puts).toEqual([]);
		});

		it("スレッドの中では、本人にだけ見える deferred を返し、モデルの切り替えを受け箱に置く", async () => {
			const { response, settled, inbox } = await interaction(
				command("codex", "luna", {
					id: THREAD,
					type: 11,
					parent_id: "400000000000000005",
				}),
			);
			expect(await response.json()).toEqual({
				type: 5,
				data: { flags: 64 },
			});
			await settled();
			expect(inbox.puts).toEqual([
				{
					kind: "command",
					dedupe: null,
					body: {
						type: "model",
						application_id: APPLICATION_ID,
						token: "interaction-token",
						guild_id: GUILD,
						channel_id: THREAD,
						user: { id: OTHER_USER_ID, display_name: "誰か", is_bot: false },
						agent: "codex",
						model: "luna",
					},
				},
			]);
		});

		it("定義に無い組み合わせは断る", async () => {
			const { response, inbox } = await interaction(
				command("claude", "terra", { id: TEXT_CHANNEL, type: 0 }),
			);
			expect(await response.json()).toMatchObject({
				type: 4,
				data: { flags: 64 },
			});
			expect(inbox.puts).toEqual([]);
		});

		it("サーバーの外のコマンドは断る", async () => {
			const c = command("claude", "opus", {
				id: TEXT_CHANNEL,
				type: 1,
			}) as Record<string, unknown>;
			delete c.guild_id;
			const { response, inbox } = await interaction(c);
			expect(((await response.json()) as { type: number }).type).toBe(4);
			expect(inbox.puts).toEqual([]);
		});

		it("modal の送信には本人にだけ見える受付を返し、依頼を受け箱に置く", async () => {
			const { response, settled, inbox } = await interaction(
				submit("ai:claude:opus", "請求書を整理して\n先月分も"),
			);
			expect(await response.json()).toEqual({
				type: 4,
				data: {
					content: "受け付けました。投稿を立てています…",
					flags: 64,
					allowed_mentions: { parse: [] },
				},
			});
			await settled();
			expect(inbox.puts).toEqual([
				{
					kind: "command",
					dedupe: null,
					body: {
						type: "request",
						application_id: APPLICATION_ID,
						token: "interaction-token",
						guild_id: GUILD,
						channel_id: TEXT_CHANNEL,
						user: { id: OTHER_USER_ID, display_name: "ちゃぬ", is_bot: false },
						agent: "claude",
						model: "opus",
						content: "請求書を整理して\n先月分も",
					},
				},
			]);
		});

		it("空の依頼や知らない modal は受け箱に置かない", async () => {
			for (const payload of [
				submit("ai:claude:opus", "  \n "),
				submit("ai:claude:luna", "請求書"),
				submit("other", "請求書"),
			]) {
				const { response, inbox } = await interaction(payload);
				expect(await response.json()).toMatchObject({
					type: 4,
					data: { flags: 64 },
				});
				expect(inbox.puts).toEqual([]);
			}
		});
	});
});
