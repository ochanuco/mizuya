import * as v from "valibot";
import { createMessage, editMessage, findMessages } from "./discord.ts";
import type { Bindings } from "./env.ts";
import {
	type ReviewTarget,
	requestedMessage,
	sameTarget,
	settledMessage,
	targetOf,
} from "./review.ts";
import { verifyGithubSignature } from "./signature.ts";

const UserSchema = v.object({ login: v.string() });

const JobRunSchema = v.object({ environment: v.string() });

const DeploymentReviewSchema = v.object({
	action: v.string(),
	repository: v.object({ full_name: v.string(), html_url: v.string() }),
	workflow_run: v.object({
		id: v.number(),
		name: v.nullish(v.string()),
		html_url: v.string(),
		head_branch: v.nullish(v.string()),
		head_sha: v.string(),
	}),
	environment: v.optional(v.string()),
	requestor: v.nullish(UserSchema),
	approver: v.nullish(UserSchema),
	workflow_job_run: v.nullish(JobRunSchema),
	workflow_job_runs: v.nullish(v.array(JobRunSchema)),
});

type DeploymentReview = v.InferOutput<typeof DeploymentReviewSchema>;

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
	if (event !== "deployment_review") return new Response(null, { status: 204 });

	const parsed = v.safeParse(DeploymentReviewSchema, parseJson(body));
	if (!parsed.success) {
		return new Response("unexpected payload", { status: 400 });
	}
	const review = parsed.output;

	// 結果は GitHub の配信ログに残るよう、Discord への反映を待ってから応答する
	switch (review.action) {
		case "requested":
			return postRequested(review, env);
		case "approved":
		case "rejected":
			return settleFromGithub(review, env);
		default:
			return new Response(null, { status: 204 });
	}
}

export function parseJson(body: string): unknown {
	try {
		return JSON.parse(body);
	} catch {
		return undefined;
	}
}

function pendingMessages(env: Bindings, matches: (t: ReviewTarget) => boolean) {
	return findMessages(
		env.DISCORD_BOT_TOKEN,
		env.DISCORD_APPROVAL_CHANNEL_ID,
		(message) => {
			const target = targetOf(message);
			return target !== null && matches(target);
		},
	);
}

async function postRequested(
	review: DeploymentReview,
	env: Bindings,
): Promise<Response> {
	const environment =
		review.environment ?? review.workflow_job_run?.environment;
	if (!environment) return new Response("environment missing", { status: 400 });

	// 配信のやり直しで同じ承認待ちのボタンが二つ並ばないよう、未決着のものがあれば投稿しない
	const target = {
		repo: review.repository.full_name,
		runId: review.workflow_run.id,
		environment,
	};
	const existing = await pendingMessages(env, (t) => sameTarget(t, target));
	if (!existing.ok) {
		console.error("discord: メッセージ一覧の取得に失敗", existing.error);
		return new Response("discord error", { status: 502 });
	}
	if (existing.value.length > 0) return new Response("already posted");

	const res = await createMessage(
		env.DISCORD_BOT_TOKEN,
		env.DISCORD_APPROVAL_CHANNEL_ID,
		requestedMessage({
			repo: review.repository.full_name,
			repoUrl: review.repository.html_url,
			runId: review.workflow_run.id,
			runUrl: review.workflow_run.html_url,
			workflow: review.workflow_run.name ?? "(不明)",
			ref: review.workflow_run.head_branch ?? null,
			sha: review.workflow_run.head_sha,
			environment,
			requestor: review.requestor?.login ?? null,
		}),
	);
	if (!res.ok) {
		console.error("discord: 承認待ちの投稿に失敗", res.error);
		return new Response("discord error", { status: 502 });
	}
	return new Response("posted");
}

/** GitHub の画面で決着した承認待ちを、Discord のメッセージにも反映する */
async function settleFromGithub(
	review: DeploymentReview,
	env: Bindings,
): Promise<Response> {
	const environments = new Set(
		[
			...(review.workflow_job_runs ?? []),
			...(review.workflow_job_run ? [review.workflow_job_run] : []),
		].map((j) => j.environment),
	);
	const repo = review.repository.full_name;
	const runId = review.workflow_run.id;

	// 対応表を持たず、承認用チャンネルのボタンが残るメッセージを run の URL と Environment で探す
	const recent = await pendingMessages(
		env,
		(t) =>
			t.repo === repo && t.runId === runId && environments.has(t.environment),
	);
	if (!recent.ok) {
		console.error("discord: メッセージ一覧の取得に失敗", recent.error);
		return new Response("discord error", { status: 502 });
	}
	const matches = recent.value;

	const by = `GitHub で ${review.approver?.login ?? "不明"}`;
	const outcome =
		review.action === "approved"
			? ({ type: "approved", by } as const)
			: ({ type: "rejected", by } as const);
	for (const message of matches) {
		const res = await editMessage(
			env.DISCORD_BOT_TOKEN,
			env.DISCORD_APPROVAL_CHANNEL_ID,
			message.id,
			settledMessage(message, outcome),
		);
		if (!res.ok) {
			console.error("discord: メッセージの更新に失敗", res.error);
			return new Response("discord error", { status: 502 });
		}
	}
	return new Response(`settled ${matches.length}`);
}
