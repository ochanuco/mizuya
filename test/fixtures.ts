export const REPO = "example/app";
export const RUN_ID = 123456789;

const workflowRun = {
	id: RUN_ID,
	name: "deploy",
	html_url: `https://github.com/${REPO}/actions/runs/${RUN_ID}`,
	head_branch: "main",
	head_sha: "0123456789abcdef0123456789abcdef01234567",
};

const repository = {
	full_name: REPO,
	html_url: `https://github.com/${REPO}`,
};

export function requestedPayload() {
	return {
		action: "requested",
		environment: "production-approval",
		requestor: { login: "octocat" },
		reviewers: [],
		workflow_job_run: {
			id: 1,
			name: "approve",
			environment: "production-approval",
			html_url: `${workflowRun.html_url}/job/1`,
		},
		workflow_run: workflowRun,
		repository,
		sender: { login: "octocat" },
	};
}

export function reviewedPayload(action: "approved" | "rejected") {
	return {
		action,
		approver: { login: "octocat" },
		comment: "",
		workflow_job_runs: [{ id: 1, environment: "production-approval" }],
		workflow_run: workflowRun,
		repository,
		sender: { login: "octocat" },
	};
}

export function pendingMessage(
	id: string,
	{
		environment = "production-approval",
		repo = REPO,
		runId = RUN_ID,
	}: { environment?: string; repo?: string; runId?: number } = {},
) {
	return {
		id,
		embeds: [
			{
				title: `承認待ち: ${repo}`,
				url: `https://github.com/${repo}/actions/runs/${runId}`,
				color: 0xf1c40f,
				fields: [
					{ name: "workflow", value: "deploy", inline: true },
					{ name: "Environment", value: environment, inline: true },
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
