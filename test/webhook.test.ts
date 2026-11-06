import { afterEach, describe, expect, it, vi } from "vitest";
import {
	pendingMessage,
	REPO,
	RUN_ID,
	requestedPayload,
	reviewedPayload,
} from "./fixtures.ts";
import {
	CHANNEL_ID,
	callWorker,
	githubSignature,
	makeEnv,
	mockFetch,
} from "./helpers.ts";

afterEach(() => {
	vi.unstubAllGlobals();
});

async function webhook(
	payload: unknown,
	event = "deployment_review",
	signature?: string,
) {
	const { env } = await makeEnv();
	const body = JSON.stringify(payload);
	const request = new Request("https://mizuya.example.com/github/webhook", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-github-event": event,
			"x-hub-signature-256":
				signature ?? (await githubSignature(env.GITHUB_WEBHOOK_SECRET, body)),
		},
		body,
	});
	return callWorker(request, env);
}

describe("POST /github/webhook", () => {
	it("署名が合わなければ 401 で、何も投稿しない", async () => {
		const calls = mockFetch(() => undefined);
		const { response } = await webhook(
			requestedPayload(),
			"deployment_review",
			await githubSignature("wrong-secret", "{}"),
		);
		expect(response.status).toBe(401);
		expect(calls).toHaveLength(0);
	});

	it("ping には応答する", async () => {
		mockFetch(() => undefined);
		const { response } = await webhook({ zen: "hi" }, "ping");
		expect(response.status).toBe(200);
	});

	it("requested で承認用チャンネルにボタン付きのメッセージを投稿する", async () => {
		const calls = mockFetch(() => Response.json({ id: "m1" }));
		const { response } = await webhook(requestedPayload());
		expect(response.status).toBe(200);
		expect(calls).toHaveLength(1);
		const [call] = calls;
		expect(call?.method).toBe("POST");
		expect(call?.url).toBe(
			`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`,
		);
		expect(call?.headers.get("authorization")).toBe("Bot test-bot-token");

		const body = call?.body as {
			embeds: {
				title: string;
				url: string;
				fields: { name: string; value: string }[];
			}[];
			components: {
				components: { label: string; custom_id: string }[];
			}[];
		};
		const embed = body.embeds[0];
		expect(embed?.title).toBe(`承認待ち: ${REPO}`);
		expect(embed?.url).toBe(
			`https://github.com/${REPO}/actions/runs/${RUN_ID}`,
		);
		const fields = Object.fromEntries(
			embed?.fields.map((f) => [f.name, f.value]) ?? [],
		);
		expect(fields.workflow).toBe("deploy");
		expect(fields.Environment).toBe("production-approval");
		expect(fields.ref).toBe(
			`main @ [0123456](https://github.com/${REPO}/commit/0123456789abcdef0123456789abcdef01234567)`,
		);
		expect(body.components[0]?.components).toEqual([
			expect.objectContaining({
				label: "承認",
				custom_id: `mizuya:approve:${REPO}:${RUN_ID}:production-approval`,
			}),
			expect.objectContaining({
				label: "却下",
				custom_id: `mizuya:reject:${REPO}:${RUN_ID}:production-approval`,
			}),
		]);
	});

	it("Discord への投稿に失敗したら 502 を返す", async () => {
		mockFetch(() => new Response("missing access", { status: 403 }));
		const { response } = await webhook(requestedPayload());
		expect(response.status).toBe(502);
	});

	it("GitHub の画面で承認されたら、該当メッセージを決着済みにしてボタンを消す", async () => {
		const calls = mockFetch((call) => {
			if (call.method === "GET") {
				return Response.json([
					{ id: "unrelated", embeds: [], components: [] },
					pendingMessage("target"),
					pendingMessage("other-env", "staging"),
				]);
			}
			return Response.json({});
		});
		const { response } = await webhook(reviewedPayload("approved"));
		expect(response.status).toBe(200);
		const edits = calls.filter((c) => c.method === "PATCH");
		expect(edits).toHaveLength(1);
		expect(edits[0]?.url).toBe(
			`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages/target`,
		);
		const body = edits[0]?.body as {
			embeds: { title: string; fields: { name: string; value: string }[] }[];
			components: unknown[];
		};
		expect(body.components).toEqual([]);
		expect(body.embeds[0]?.title).toBe(`決着: ${REPO}`);
		expect(body.embeds[0]?.fields.at(-1)).toEqual({
			name: "結果",
			value: "承認（GitHub で octocat）",
			inline: false,
		});
	});

	it("GitHub の画面で却下されたら、却下として反映する", async () => {
		const calls = mockFetch((call) =>
			call.method === "GET"
				? Response.json([pendingMessage("target")])
				: Response.json({}),
		);
		await webhook(reviewedPayload("rejected"));
		const body = calls.find((c) => c.method === "PATCH")?.body as {
			embeds: { fields: { name: string; value: string }[] }[];
		};
		expect(body.embeds[0]?.fields.at(-1)?.value).toBe(
			"却下（GitHub で octocat）",
		);
	});

	it("deployment_review 以外のイベントは無視する", async () => {
		const calls = mockFetch(() => undefined);
		const { response } = await webhook({ action: "opened" }, "pull_request");
		expect(response.status).toBe(204);
		expect(calls).toHaveLength(0);
	});
});
