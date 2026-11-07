import * as v from "valibot";
import { approvalKey } from "./approval-ledger.ts";
import { createMessage, editMessage, findMessages } from "./discord.ts";
import { approvalLedgerOf, type Bindings, inboxOf } from "./env.ts";
import { listPendingDeployments } from "./github.ts";
import {
	jobIdOf,
	type Outcome,
	type ReviewTarget,
	requestedMessage,
	sameTarget,
	settledMessage,
	targetOf,
} from "./review.ts";
import { verifyGithubSignature } from "./signature.ts";
import { toWorkEvent, WORK_EVENT_NAMES } from "./work-events.ts";

const WorkflowJobSchema = v.object({
	action: v.string(),
	repository: v.object({ full_name: v.string(), html_url: v.string() }),
	workflow_job: v.object({
		id: v.number(),
		run_id: v.number(),
		name: v.string(),
		html_url: v.string(),
		workflow_name: v.nullish(v.string()),
		head_branch: v.nullish(v.string()),
		head_sha: v.string(),
		conclusion: v.nullish(v.string()),
	}),
});

type WorkflowJob = v.InferOutput<typeof WorkflowJobSchema>;

export function parseJson(body: string): unknown {
	try {
		return JSON.parse(body);
	} catch {
		return undefined;
	}
}

export async function handleGithubWebhook(
	request: Request,
	env: Bindings,
): Promise<Response> {
	const body = await request.text();
	const valid = await verifyGithubSignature(
		env.GITHUB_WEBHOOK_SECRET,
		body,
		request.headers.get("x-hub-signature-256"),
	);
	if (!valid) return new Response("invalid signature", { status: 401 });

	const event = request.headers.get("x-github-event");
	if (event === "ping") return new Response("pong");
	if (event !== null && WORK_EVENT_NAMES.has(event)) {
		return putWorkEvent(
			event,
			body,
			request.headers.get("x-github-delivery"),
			env,
		);
	}
	if (event !== "workflow_job") return new Response(null, { status: 204 });

	const parsed = v.safeParse(WorkflowJobSchema, parseJson(body));
	if (!parsed.success) {
		return new Response("unexpected payload", { status: 400 });
	}
	const job = parsed.output;

	// 結果は GitHub の配信ログに残るよう、Discord への反映を待ってから応答する
	switch (job.action) {
		case "waiting":
			return postWaiting(job, env);
		case "in_progress":
		case "completed":
			return settleFromGithub(job, env);
		default:
			return new Response(null, { status: 204 });
	}
}

function pendingMessages(
	env: Bindings,
	matches: (t: ReviewTarget, jobId: number | null) => boolean,
) {
	return findMessages(
		env.DISCORD_BOT_TOKEN,
		env.DISCORD_APPROVAL_CHANNEL_ID,
		(message) => {
			const target = targetOf(message);
			return target !== null && matches(target, jobIdOf(message));
		},
	);
}

function discordError(error: unknown): Response {
	console.error("discord:", error);
	return new Response("discord error", { status: 502 });
}

/** waiting は保護ルールの承認待ち。payload は Environment を持たないので、run の pending_deployments から取る */
async function postWaiting(job: WorkflowJob, env: Bindings): Promise<Response> {
	const repo = job.repository.full_name;
	const runId = job.workflow_job.run_id;
	const pending = await listPendingDeployments(
		env.GITHUB_APPROVER_TOKEN,
		repo,
		runId,
	);
	if (!pending.ok) {
		console.error("github: pending_deployments の取得に失敗", pending.error);
		return new Response("github error", { status: 502 });
	}
	// 承認者のいない待ち（待ち時間やブランチの規則だけの Environment）は、押す人がいないので投稿しない
	const reviewable = pending.value.filter((d) => d.reviewers.length > 0);
	if (reviewable.length === 0) return new Response("nothing to review");

	// 配信のやり直しや、同じ run で別の job が待ちに入ったときに、同じ承認待ちのボタンが二つ並ばないようにする
	const existing = await pendingMessages(
		env,
		(t) => t.repo === repo && t.runId === runId,
	);
	if (!existing.ok) return discordError(existing.error);
	const posted = existing.value
		.map((m) => targetOf(m))
		.filter((t): t is ReviewTarget => t !== null);

	const ledger = approvalLedgerOf(env);
	let count = 0;
	for (const deployment of reviewable) {
		const target = { repo, runId, environment: deployment.environment.name };
		if (posted.some((t) => sameTarget(t, target))) continue;
		// 同時に届いた配信では、どちらも上の Discord の確認をすり抜けるので、先に取れた方だけが投稿する
		const key = approvalKey(target);
		if (!(await ledger.claim(key))) continue;
		const res = await createMessage(
			env.DISCORD_BOT_TOKEN,
			env.DISCORD_APPROVAL_CHANNEL_ID,
			requestedMessage({
				repo,
				repoUrl: job.repository.html_url,
				runId,
				runUrl: `${job.repository.html_url}/actions/runs/${runId}`,
				workflow: job.workflow_job.workflow_name ?? "(不明)",
				ref: job.workflow_job.head_branch ?? null,
				approverUserId: env.DISCORD_APPROVER_USER_ID,
				sha: job.workflow_job.head_sha,
				environment: target.environment,
				job: { name: job.workflow_job.name, url: job.workflow_job.html_url },
			}),
		);
		if (!res.ok) {
			await ledger.release(key);
			return discordError(res.error);
		}
		count++;
	}
	return new Response(`posted ${count}`);
}

// 承認されると job が走り出し、却下されると job は failure で終わる。
// Discord のボタンで決着したものは先にボタンが消えているので、ここでは見つからない
function outcomeOf(job: WorkflowJob): Outcome {
	if (job.action === "in_progress") return { type: "approved", by: "GitHub" };
	switch (job.workflow_job.conclusion) {
		case "success":
			return { type: "approved", by: "GitHub" };
		case "cancelled":
			return { type: "cancelled", by: "run の取り消し" };
		default:
			return { type: "rejected", by: "GitHub" };
	}
}

/** 承認待ちだった job が動き出す・終わると、GitHub の画面で決着したものとして Discord に反映する */
async function settleFromGithub(
	job: WorkflowJob,
	env: Bindings,
): Promise<Response> {
	const repo = job.repository.full_name;
	const runId = job.workflow_job.run_id;
	const matches = await pendingMessages(
		env,
		(t, jobId) =>
			t.repo === repo && t.runId === runId && jobId === job.workflow_job.id,
	);
	if (!matches.ok) return discordError(matches.error);

	const outcome = outcomeOf(job);
	for (const message of matches.value) {
		const res = await editMessage(
			env.DISCORD_BOT_TOKEN,
			env.DISCORD_APPROVAL_CHANNEL_ID,
			message.id,
			settledMessage(message, outcome),
		);
		if (!res.ok) return discordError(res.error);
	}
	return new Response(`settled ${matches.value.length}`);
}

/** 席を動かす出来事だけを受け箱に置く。承認の処理とは別で、Working が止まっていても承認には響かない */
async function putWorkEvent(
	event: string,
	body: string,
	delivery: string | null,
	env: Bindings,
): Promise<Response> {
	if (!delivery) return new Response("missing delivery", { status: 400 });
	const work = toWorkEvent(event, parseJson(body));
	if (work === null) return new Response(null, { status: 204 });
	// 配信のやり直しは同じ X-GitHub-Delivery で来るので、一つにまとめる
	const put = await inboxOf(env).put("github", work, `github:${delivery}`);
	return new Response(put ? "queued" : "duplicate", { status: 202 });
}
