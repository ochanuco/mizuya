export const REPO = "example/app";
export const RUN_ID = 123456789;

export const JOB_ID = 555;
const RUN_URL = `https://github.com/${REPO}/actions/runs/${RUN_ID}`;

export function workflowJobPayload(
	action: "queued" | "waiting" | "in_progress" | "completed",
	{
		jobId = JOB_ID,
		conclusion = null,
	}: { jobId?: number; conclusion?: string | null } = {},
) {
	return {
		action,
		workflow_job: {
			id: jobId,
			run_id: RUN_ID,
			run_attempt: 1,
			run_url: `https://api.github.com/repos/${REPO}/actions/runs/${RUN_ID}`,
			html_url: `${RUN_URL}/job/${jobId}`,
			name: "deploy / approve",
			workflow_name: "deploy",
			head_branch: "main",
			head_sha: "0123456789abcdef0123456789abcdef01234567",
			status: action,
			conclusion,
			labels: [],
			steps: [],
		},
		deployment: null,
		repository: { full_name: REPO, html_url: `https://github.com/${REPO}` },
		sender: { login: "octocat" },
	};
}

export function pendingMessage(
	id: string,
	{
		environment = "production-approval",
		repo = REPO,
		runId = RUN_ID,
		jobId = JOB_ID,
	}: {
		environment?: string;
		repo?: string;
		runId?: number;
		jobId?: number;
	} = {},
) {
	return {
		id,
		content: "<@100000000000000001> 承認待ちがあります",
		embeds: [
			{
				title: `承認待ち: ${repo}`,
				url: `https://github.com/${repo}/actions/runs/${runId}`,
				color: 0xf1c40f,
				fields: [
					{ name: "workflow", value: "deploy", inline: true },
					{ name: "Environment", value: environment, inline: true },
					{
						name: "job",
						value: `[deploy / approve](https://github.com/${repo}/actions/runs/${runId}/job/${jobId})`,
						inline: true,
					},
				],
			},
		],
		components: [
			{
				type: 1,
				components: [
					{ type: 2, style: 3, label: "承認", custom_id: "mizuya:approve" },
					{ type: 2, style: 4, label: "却下", custom_id: "mizuya:reject" },
				],
			},
		],
	};
}

export const failedRun = (conclusion = "failure") => ({
	action: "completed",
	workflow_run: {
		conclusion,
		name: "ci",
		head_branch: "dev/x",
		html_url: "https://github.com/o/r/actions/runs/1",
		pull_requests: [{ number: 12 }],
		triggering_actor: { login: "someone" },
	},
	repository: { full_name: "o/r" },
});

export const review = {
	action: "submitted",
	review: {
		state: "changes_requested",
		body: "ここを直して",
		html_url: "https://github.com/o/r/pull/3#pullrequestreview-1",
		user: { login: "reviewer", type: "User" },
	},
	pull_request: { number: 3, title: "直す" },
	repository: { full_name: "o/r" },
};
