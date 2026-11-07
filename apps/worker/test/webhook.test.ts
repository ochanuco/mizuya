import { afterEach, describe, expect, it, vi } from "vitest";
import {
	failedRun,
	JOB_ID,
	pendingMessage,
	REPO,
	RUN_ID,
	review,
	workflowJobPayload,
} from "./fixtures.ts";
import {
	APPROVER_ID,
	type Call,
	CHANNEL_ID,
	callWorker,
	githubSignature,
	makeEnv,
	mockFetch,
} from "./helpers.ts";

afterEach(() => {
	vi.unstubAllGlobals();
});

const PENDING_URL = `https://api.github.com/repos/${REPO}/actions/runs/${RUN_ID}/pending_deployments`;
const MESSAGES_URL = `https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`;

function pending(...names: string[]) {
	return names.map((name, i) => ({
		environment: { id: i + 1, name },
		current_user_can_approve: true,
		reviewers: [{ type: "User", reviewer: { login: "approver" } }],
	}));
}

async function webhook(
	payload: unknown,
	event = "workflow_job",
	signature?: string,
	delivery = "delivery-1",
	made?: Awaited<ReturnType<typeof makeEnv>>,
) {
	const { env, inbox } = made ?? (await makeEnv());
	const body = typeof payload === "string" ? payload : JSON.stringify(payload);
	const request = new Request("https://mizuya.example.com/github/webhook", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-github-event": event,
			"x-github-delivery": delivery,
			"x-hub-signature-256":
				signature ?? (await githubSignature(env.GITHUB_WEBHOOK_SECRET, body)),
		},
		body,
	});
	return { inbox, ...(await callWorker(request, env)) };
}

/** GitHub の pending_deployments と Discord のメッセージ一覧・投稿・編集をまとめてモックする */
function services({
	pendingDeployments = pending("production-approval"),
	messages = [] as unknown[],
	discordPost = () => Response.json({ id: "new" }) as Response,
} = {}) {
	return mockFetch((call: Call) => {
		if (call.url === PENDING_URL) return Response.json(pendingDeployments);
		if (call.method === "GET" && call.url.startsWith(MESSAGES_URL)) {
			return Response.json(messages);
		}
		if (call.method === "POST" && call.url === MESSAGES_URL) {
			return discordPost();
		}
		if (call.method === "PATCH") return Response.json({});
		return undefined;
	});
}

type PostedBody = {
	content?: string;
	allowed_mentions?: { parse: string[]; users?: string[] };
	embeds: {
		title: string;
		url: string;
		fields: { name: string; value: string }[];
	}[];
	components: { components: { label: string; custom_id: string }[] }[];
};

describe("POST /github/webhook", () => {
	it("署名が合わなければ 401 で、何も呼ばない", async () => {
		const calls = mockFetch(() => undefined);
		const { response } = await webhook(
			workflowJobPayload("waiting"),
			"workflow_job",
			await githubSignature("wrong-secret", "{}"),
		);
		expect(response.status).toBe(401);
		expect(calls).toHaveLength(0);
	});

	it("署名が正しくても JSON でなければ 400", async () => {
		mockFetch(() => undefined);
		const { response } = await webhook("not json");
		expect(response.status).toBe(400);
	});

	it("ping には応答する", async () => {
		mockFetch(() => undefined);
		const { response } = await webhook({ zen: "hi" }, "ping");
		expect(response.status).toBe(200);
	});

	it("workflow_job 以外のイベントと queued は無視する", async () => {
		const calls = mockFetch(() => undefined);
		expect(
			(await webhook({ action: "opened" }, "pull_request")).response.status,
		).toBe(204);
		expect((await webhook(workflowJobPayload("queued"))).response.status).toBe(
			204,
		);
		expect(calls).toHaveLength(0);
	});

	it("waiting で、pending_deployments の Environment ごとにボタン付きのメッセージを投稿する", async () => {
		const calls = services();
		const { response } = await webhook(workflowJobPayload("waiting"));
		expect(response.status).toBe(200);
		expect(calls.map((c) => `${c.method} ${c.url.split("?")[0]}`)).toEqual([
			`GET ${PENDING_URL}`,
			`GET ${MESSAGES_URL}`,
			`POST ${MESSAGES_URL}`,
		]);
		expect(calls[0]?.headers.get("authorization")).toBe(
			"Bearer test-github-token",
		);
		const post = calls[2];
		expect(post?.headers.get("authorization")).toBe("Bot test-bot-token");

		const body = post?.body as PostedBody;
		expect(body.content).toBe(`<@${APPROVER_ID}> 承認待ちがあります`);
		expect(body.allowed_mentions).toEqual({ parse: [], users: [APPROVER_ID] });
		const embed = body.embeds[0];
		expect(embed?.title).toBe(`承認待ち: ${REPO}`);
		expect(embed?.url).toBe(
			`https://github.com/${REPO}/actions/runs/${RUN_ID}`,
		);
		const fields = Object.fromEntries(
			embed?.fields.map((f) => [f.name, f.value]) ?? [],
		);
		expect(fields).toEqual({
			workflow: "deploy",
			Environment: "production-approval",
			job: `[deploy / approve](https://github.com/${REPO}/actions/runs/${RUN_ID}/job/${JOB_ID})`,
			起動元のコミット: `main @ [0123456](https://github.com/${REPO}/commit/0123456789abcdef0123456789abcdef01234567)`,
		});
		expect(body.components[0]?.components).toEqual([
			expect.objectContaining({ label: "承認", custom_id: "mizuya:approve" }),
			expect.objectContaining({ label: "却下", custom_id: "mizuya:reject" }),
		]);
	});

	it("同じ承認待ちのメッセージが未決着で残っていれば、その Environment は投稿しない", async () => {
		const calls = services({
			pendingDeployments: pending("production-approval", "staging"),
			messages: [pendingMessage("existing")],
		});
		await webhook(workflowJobPayload("waiting"));
		const posts = calls.filter(
			(c) => c.method === "POST" && c.url === MESSAGES_URL,
		);
		expect(posts).toHaveLength(1);
		expect(
			(posts[0]?.body as PostedBody | undefined)?.embeds[0]?.fields.find(
				(f) => f.name === "Environment",
			)?.value,
		).toBe("staging");
	});

	it("承認待ちが無ければ投稿しない", async () => {
		const calls = services({ pendingDeployments: [] });
		const { response } = await webhook(workflowJobPayload("waiting"));
		expect(response.status).toBe(200);
		expect(calls.map((c) => c.method)).toEqual(["GET"]);
	});

	it("承認者のいない待ちでは投稿しない", async () => {
		const calls = services({
			pendingDeployments: pending("production").map((d) => ({
				...d,
				reviewers: [],
			})),
		});
		const { response } = await webhook(workflowJobPayload("waiting"));
		expect(response.status).toBe(200);
		expect(calls.map((c) => c.method)).toEqual(["GET"]);
	});

	it("同じ承認待ちの waiting が別の delivery で同時に届いても、投稿は 1 つ", async () => {
		const calls = services();
		const made = await makeEnv();
		const payload = workflowJobPayload("waiting");
		await Promise.all([
			webhook(payload, "workflow_job", undefined, "delivery-1", made),
			webhook(payload, "workflow_job", undefined, "delivery-2", made),
		]);
		const posts = calls.filter(
			(c) => c.method === "POST" && c.url === MESSAGES_URL,
		);
		expect(posts).toHaveLength(1);
	});

	it("投稿に失敗した承認待ちは、次の配信で投稿し直す", async () => {
		let fail = true;
		const calls = services({
			discordPost: () =>
				fail
					? new Response("unavailable", { status: 503 })
					: (Response.json({ id: "new" }) as Response),
		});
		const made = await makeEnv();
		const payload = workflowJobPayload("waiting");
		const first = await webhook(payload, "workflow_job", undefined, "d1", made);
		expect(first.response.status).toBe(502);
		fail = false;
		const second = await webhook(
			payload,
			"workflow_job",
			undefined,
			"d2",
			made,
		);
		expect(second.response.status).toBe(200);
		expect(
			calls.filter((c) => c.method === "POST" && c.url === MESSAGES_URL),
		).toHaveLength(2);
	});

	it("Discord への投稿に失敗したら 502 を返す", async () => {
		services({
			discordPost: () => new Response("missing access", { status: 403 }),
		});
		const { response } = await webhook(workflowJobPayload("waiting"));
		expect(response.status).toBe(502);
	});

	it("待っていた job が in_progress になったら、承認として決着させてボタンを消す", async () => {
		const calls = services({
			messages: [
				{ id: "unrelated", embeds: [], components: [] },
				pendingMessage("target"),
				pendingMessage("other-job", { jobId: JOB_ID + 1 }),
				pendingMessage("other-repo", { repo: "example/other" }),
				pendingMessage("other-run", { runId: RUN_ID + 1 }),
			],
		});
		const { response } = await webhook(workflowJobPayload("in_progress"));
		expect(response.status).toBe(200);
		const edits = calls.filter((c) => c.method === "PATCH");
		expect(edits).toHaveLength(1);
		expect(edits[0]?.url).toBe(`${MESSAGES_URL}/target`);
		const body = edits[0]?.body as PostedBody;
		expect(body.components).toEqual([]);
		expect(body.embeds[0]?.title).toBe(`承認: ${REPO}`);
		// 本文を結果に変えるが、メンションは残したまま承認者に再び通知しない
		expect(body.content).toBe(`<@${APPROVER_ID}> 承認しました`);
		expect(body.allowed_mentions).toEqual({ parse: [] });
		expect(body.embeds[0]?.fields.at(-1)).toEqual({
			name: "結果",
			value: "承認（GitHub）",
			inline: false,
		});
	});

	it.each([
		["success", "承認", "承認（GitHub）", "承認しました"],
		["failure", "却下", "却下（GitHub）", "却下しました"],
		["cancelled", "取り消し", "取り消し（run の取り消し）", "取り消されました"],
	])(
		"待っていた job が %s で終わったら、タイトルを「%s」にして「%s」と書く",
		async (conclusion, label, text, content) => {
			const calls = services({ messages: [pendingMessage("target")] });
			await webhook(workflowJobPayload("completed", { conclusion }));
			const body = calls.find((c) => c.method === "PATCH")?.body as PostedBody;
			expect(body.embeds[0]?.title).toBe(`${label}: ${REPO}`);
			expect(body.content).toBe(`<@${APPROVER_ID}> ${content}`);
			expect(body.allowed_mentions).toEqual({ parse: [] });
			expect(body.embeds[0]?.fields.at(-1)?.value).toBe(text);
		},
	);

	it("100 件より前のメッセージもさかのぼって探す", async () => {
		const filler = Array.from({ length: 100 }, (_, i) => ({
			id: `filler-${i}`,
			embeds: [],
			components: [],
		}));
		const calls = mockFetch((call) => {
			if (call.method === "GET") {
				return Response.json(
					call.url.includes("before=filler-99")
						? [pendingMessage("old")]
						: filler,
				);
			}
			return Response.json({});
		});
		await webhook(workflowJobPayload("in_progress"));
		expect(calls.map((c) => c.method)).toEqual(["GET", "GET", "PATCH"]);
		expect(calls[2]?.url).toBe(`${MESSAGES_URL}/old`);
	});

	describe("席を動かす出来事", () => {
		it("受け箱に delivery ごとに置き、承認の処理は通らない", async () => {
			const calls = mockFetch(() => undefined);
			const { response, inbox } = await webhook(failedRun(), "workflow_run");
			expect(response.status).toBe(202);
			expect(calls).toHaveLength(0);
			expect(inbox.puts).toEqual([
				{
					kind: "github",
					dedupe: "github:delivery-1",
					body: {
						kind: "ci_failed",
						repo: "o/r",
						prs: [12],
						name: "ci",
						branch: "dev/x",
						conclusion: "failure",
						url: "https://github.com/o/r/actions/runs/1",
						actor: "someone",
					},
				},
			]);
		});

		it("レビューも置く", async () => {
			const { inbox } = await webhook(review, "pull_request_review");
			expect(inbox.puts[0]?.body).toMatchObject({ kind: "review", pr: 3 });
		});

		it("席を動かさない出来事は置かずに 204", async () => {
			const { response, inbox } = await webhook(
				failedRun("success"),
				"workflow_run",
			);
			expect(response.status).toBe(204);
			expect(inbox.puts).toEqual([]);
		});

		it("署名が合わなければ置かない", async () => {
			const { response, inbox } = await webhook(
				failedRun(),
				"workflow_run",
				"sha256=00",
			);
			expect(response.status).toBe(401);
			expect(inbox.puts).toEqual([]);
		});
	});
});
