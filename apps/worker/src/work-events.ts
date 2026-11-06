import * as v from "valibot";

/**
 * 席を動かす GitHub の出来事。webhook の payload は大きく、席に要らない値も多いので、席の材料になる分だけに絞って受け箱に置く。
 * 形は Working の `inbox.ts` が読む形と揃える。
 */
export type GithubWorkEvent =
	| {
			kind: "ci_failed";
			repo: string;
			/** 落ちた run が属する PR。main など PR の無い branch なら空。 */
			prs: number[];
			name: string;
			branch: string | null;
			conclusion: string;
			url: string;
			actor: string | null;
	  }
	| {
			kind: "review";
			repo: string;
			pr: number;
			title: string;
			state: string;
			body: string;
			url: string;
			actor: string;
			actor_is_bot: boolean;
	  }
	| {
			kind: "comment";
			repo: string;
			number: number;
			is_pr: boolean;
			title: string;
			body: string;
			url: string;
			actor: string;
			actor_is_bot: boolean;
	  };

/** 受け箱に置く出来事の名前。webhook はこれと workflow_job を送る。 */
export const WORK_EVENT_NAMES = new Set([
	"check_suite",
	"workflow_run",
	"pull_request_review",
	"issue_comment",
]);

/** 席に渡す本文の上限。長いレビューは先頭だけで足り、残りは席が URL から読む。 */
const BODY_LIMIT = 2000;
const FAILED = ["failure", "timed_out", "startup_failure"];

const repository = v.object({ full_name: v.string() });
const user = v.object({ login: v.string(), type: v.optional(v.string()) });
const prRefs = v.array(v.object({ number: v.number() }));

const checkSuiteSchema = v.object({
	action: v.literal("completed"),
	check_suite: v.object({
		conclusion: v.nullable(v.string()),
		head_branch: v.nullable(v.string()),
		head_sha: v.string(),
		app: v.nullish(v.object({ slug: v.string(), name: v.string() })),
		pull_requests: prRefs,
	}),
	repository: v.object({ full_name: v.string(), html_url: v.string() }),
	sender: v.nullish(user),
});

const workflowRunSchema = v.object({
	action: v.literal("completed"),
	workflow_run: v.object({
		conclusion: v.nullable(v.string()),
		name: v.nullish(v.string()),
		head_branch: v.nullable(v.string()),
		html_url: v.string(),
		pull_requests: prRefs,
		triggering_actor: v.nullish(user),
	}),
	repository,
});

const reviewSchema = v.object({
	action: v.literal("submitted"),
	review: v.object({
		state: v.string(),
		body: v.nullable(v.string()),
		html_url: v.string(),
		user,
	}),
	pull_request: v.object({ number: v.number(), title: v.string() }),
	repository,
});

const commentSchema = v.object({
	action: v.literal("created"),
	comment: v.object({ body: v.string(), html_url: v.string(), user }),
	issue: v.object({
		number: v.number(),
		title: v.string(),
		pull_request: v.optional(v.unknown()),
	}),
	repository,
});

const clip = (s: string | null) => {
	const t = s ?? "";
	return t.length > BODY_LIMIT ? `${t.slice(0, BODY_LIMIT)}…` : t;
};

const isBot = (u: v.InferOutput<typeof user>) => u.type === "Bot";

/** 席を動かす出来事だけを抜き出す。それ以外（成功した CI、編集、削除など）は null。 */
export const toWorkEvent = (
	name: string,
	payload: unknown,
): GithubWorkEvent | null => {
	switch (name) {
		case "check_suite": {
			const p = v.safeParse(checkSuiteSchema, payload);
			if (!p.success) return null;
			const s = p.output.check_suite;
			// Actions の失敗は workflow_run で受ける。両方を受けると同じ失敗が二度来る
			if (s.app?.slug === "github-actions") return null;
			if (!s.conclusion || !FAILED.includes(s.conclusion)) return null;
			return {
				kind: "ci_failed",
				repo: p.output.repository.full_name,
				prs: s.pull_requests.map((x) => x.number),
				name: s.app?.name ?? "check_suite",
				branch: s.head_branch,
				conclusion: s.conclusion,
				url: `${p.output.repository.html_url}/commit/${s.head_sha}/checks`,
				actor: p.output.sender?.login ?? null,
			};
		}
		case "workflow_run": {
			const p = v.safeParse(workflowRunSchema, payload);
			if (!p.success) return null;
			const r = p.output.workflow_run;
			if (!r.conclusion || !FAILED.includes(r.conclusion)) return null;
			return {
				kind: "ci_failed",
				repo: p.output.repository.full_name,
				prs: r.pull_requests.map((x) => x.number),
				name: r.name ?? "workflow_run",
				branch: r.head_branch,
				conclusion: r.conclusion,
				url: r.html_url,
				actor: r.triggering_actor?.login ?? null,
			};
		}
		case "pull_request_review": {
			const p = v.safeParse(reviewSchema, payload);
			if (!p.success) return null;
			const r = p.output.review;
			return {
				kind: "review",
				repo: p.output.repository.full_name,
				pr: p.output.pull_request.number,
				title: p.output.pull_request.title,
				state: r.state,
				body: clip(r.body),
				url: r.html_url,
				actor: r.user.login,
				actor_is_bot: isBot(r.user),
			};
		}
		case "issue_comment": {
			const p = v.safeParse(commentSchema, payload);
			if (!p.success) return null;
			const c = p.output.comment;
			return {
				kind: "comment",
				repo: p.output.repository.full_name,
				number: p.output.issue.number,
				is_pr: p.output.issue.pull_request !== undefined,
				title: p.output.issue.title,
				body: clip(c.body),
				url: c.html_url,
				actor: c.user.login,
				actor_is_bot: isBot(c.user),
			};
		}
		default:
			return null;
	}
};
