import { describe, expect, it, vi } from "vitest";
import { createDiscordRest } from "./discord-rest.ts";
import {
	createSpeaker,
	createWebhookDirectory,
	WEBHOOK_NAME,
} from "./speaker.ts";

const APP = "300";
const FORUM = "f1";
const TEXT = "c1";
const THREAD = "t1";

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

type Call = { method: string; url: string; body: unknown };

/** Discord の API の代わり。チャンネル、webhook、送ったメッセージを手元に持つ。 */
const fakeApi = (
	hooks: Record<string, unknown[]> = {},
	/** この webhook への書き込みを、消された webhook として断る。 */
	gone = new Set<string>(),
) => {
	const calls: Call[] = [];
	let n = 0;
	const fetch = vi.fn(
		async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			const method = init?.method ?? "GET";
			const raw = init?.body;
			calls.push({
				method,
				url,
				body: typeof raw === "string" ? JSON.parse(raw) : raw,
			});
			const path = url.replace("https://discord.com/api/v10", "");
			if (path === `/channels/${THREAD}`) {
				return json({ id: THREAD, type: 11, parent_id: FORUM });
			}
			if (path === `/channels/${FORUM}`) {
				return json({ id: FORUM, type: 15, parent_id: "cat" });
			}
			if (path === `/channels/${TEXT}`) {
				return json({ id: TEXT, type: 0, parent_id: "cat" });
			}
			const listed = /^\/channels\/(\w+)\/webhooks$/.exec(path);
			if (listed && method === "GET") return json(hooks[listed[1] ?? ""] ?? []);
			if (listed && method === "POST") {
				return json({
					id: `hook-${listed[1]}`,
					token: "new-token",
					name: WEBHOOK_NAME,
					application_id: APP,
				});
			}
			const hookId = /^\/webhooks\/([^/]+)\//.exec(path)?.[1] ?? "";
			if (path.startsWith("/webhooks/") && gone.has(hookId)) {
				return json({ code: 10015, message: "Unknown Webhook" }, 404);
			}
			if (path.startsWith("/webhooks/") && method === "POST") {
				const thread = new URL(url).searchParams.get("thread_id");
				return json({
					id: `m${++n}`,
					channel_id: thread ?? "new-thread",
					content: "",
					author: { id: "hook", username: "ゆかりん" },
					webhook_id: "hook",
				});
			}
			if (path.startsWith("/webhooks/") && method === "PATCH") {
				return new Response(null, { status: 204 });
			}
			return json({ message: "not mocked" }, 404);
		},
	);
	const rest = createDiscordRest({ token: "tok", fetch });
	const speaker = createSpeaker(rest, createWebhookDirectory(rest, APP), {
		name: "ゆかりん",
		avatarUrl: "https://example.com/yukarin.png",
	});
	return { calls, speaker };
};

const executes = (calls: Call[]) =>
	calls.filter((c) => c.method === "POST" && c.url.includes("/webhooks/"));

describe("席の話し手", () => {
	it("スレッドには親のフォーラムの webhook で thread_id を添えて書き、席の名前と画像を名乗る", async () => {
		const { calls, speaker } = fakeApi({
			[FORUM]: [
				{ id: "other", token: "x", name: WEBHOOK_NAME, application_id: "999" },
				{ id: "mine", token: "tk", name: WEBHOOK_NAME, application_id: APP },
			],
		});
		const r = await speaker.send(
			THREAD,
			"直しました",
			"r1",
			[],
			[{ customId: "approval:grant", label: "許可", style: "success" }],
		);
		expect(r).toEqual({ ok: true, value: { messageIds: ["m1"] } });
		const [post] = executes(calls);
		expect(post?.url).toBe(
			`https://discord.com/api/v10/webhooks/mine/tk?with_components=true&wait=true&thread_id=${THREAD}`,
		);
		expect(post?.body).toEqual({
			content: "直しました",
			allowed_mentions: { parse: [] },
			username: "ゆかりん",
			avatar_url: "https://example.com/yukarin.png",
			components: [
				{
					type: 1,
					components: [
						{
							type: 2,
							style: 3,
							label: "許可",
							custom_id: "working:approval:grant",
						},
					],
				},
			],
		});
	});

	it("mizuya の webhook が無ければ作り、二度目からは作らない", async () => {
		const { calls, speaker } = fakeApi();
		await speaker.send(TEXT, "a");
		await speaker.send(TEXT, "b");
		const creates = calls.filter(
			(c) =>
				c.method === "POST" && c.url.endsWith(`/channels/${TEXT}/webhooks`),
		);
		expect(creates).toHaveLength(1);
		expect(creates[0]?.body).toEqual({ name: WEBHOOK_NAME });
		const posts = executes(calls);
		expect(posts).toHaveLength(2);
		// 仕事チャンネルはスレッドではないので thread_id を付けない
		expect(posts[0]?.url).toBe(
			`https://discord.com/api/v10/webhooks/hook-${TEXT}/new-token?with_components=true&wait=true`,
		);
	});

	it("フォーラムの投稿は webhook の thread_name で立て、できたスレッドを返す", async () => {
		const { calls, speaker } = fakeApi();
		const r = await speaker.createForumPost(FORUM, {
			name: "請求書の整理",
			content: "本文",
			tagIds: ["tag1"],
		});
		expect(r).toEqual({ ok: true, value: { threadId: "new-thread" } });
		expect(executes(calls)[0]?.body).toMatchObject({
			thread_name: "請求書の整理",
			applied_tags: ["tag1"],
			username: "ゆかりん",
		});
	});

	it("書き換えも webhook で行い、ボタンを外す", async () => {
		const { calls, speaker } = fakeApi();
		await speaker.editMessage(THREAD, "m9", "決着しました");
		const patch = calls.find((c) => c.method === "PATCH");
		expect(patch?.url).toBe(
			`https://discord.com/api/v10/webhooks/hook-${FORUM}/new-token/messages/m9?with_components=true&thread_id=${THREAD}`,
		);
		expect(patch?.body).toEqual({
			content: "決着しました",
			allowed_mentions: { parse: [] },
			components: [],
		});
	});

	it("読むのとタグは bot で行う", async () => {
		const { calls, speaker } = fakeApi();
		await speaker.setTags(THREAD, ["tag1"]);
		expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
			`PATCH https://discord.com/api/v10/channels/${THREAD}`,
		]);
	});

	it("書けなかった webhook は忘れ、次は引き直して作る", async () => {
		const listed = [
			{ id: "old", token: "tk", name: WEBHOOK_NAME, application_id: APP },
		];
		const { calls, speaker } = fakeApi({ [TEXT]: listed }, new Set(["old"]));
		expect((await speaker.send(TEXT, "a")).ok).toBe(false);
		// Discord の画面で消されたので、一覧にももう出ない
		listed.length = 0;
		calls.length = 0;
		expect(await speaker.send(TEXT, "b")).toEqual({
			ok: true,
			value: { messageIds: ["m1"] },
		});
		expect(calls.map((c) => `${c.method} ${c.url.split("?")[0]}`)).toEqual([
			`GET https://discord.com/api/v10/channels/${TEXT}/webhooks`,
			`POST https://discord.com/api/v10/channels/${TEXT}/webhooks`,
			`POST https://discord.com/api/v10/webhooks/hook-${TEXT}/new-token`,
		]);
	});
});
