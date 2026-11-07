import * as v from "valibot";

const API = "https://api.github.com";

const PendingDeploymentsSchema = v.array(
	v.object({
		environment: v.object({ id: v.number(), name: v.string() }),
		current_user_can_approve: v.boolean(),
		reviewers: v.optional(v.array(v.unknown()), []),
	}),
);

export type PendingDeployment = v.InferOutput<
	typeof PendingDeploymentsSchema
>[number];

export type GithubError = {
	type: "github_error";
	status: number;
	message: string;
};

function headers(token: string): HeadersInit {
	return {
		accept: "application/vnd.github+json",
		authorization: `Bearer ${token}`,
		"x-github-api-version": "2022-11-28",
		"user-agent": "mizuya",
	};
}

async function errorOf(res: Response): Promise<GithubError> {
	const text = await res.text();
	let message = text;
	try {
		const parsed = JSON.parse(text) as { message?: unknown };
		if (typeof parsed.message === "string") message = parsed.message;
	} catch {}
	return { type: "github_error", status: res.status, message };
}

export async function listPendingDeployments(
	token: string,
	repo: string,
	runId: number,
): Promise<
	{ ok: true; value: PendingDeployment[] } | { ok: false; error: GithubError }
> {
	const res = await fetch(
		`${API}/repos/${repo}/actions/runs/${runId}/pending_deployments`,
		{ headers: headers(token) },
	);
	if (!res.ok) return { ok: false, error: await errorOf(res) };
	const parsed = v.safeParse(PendingDeploymentsSchema, await res.json());
	if (!parsed.success) {
		return {
			ok: false,
			error: {
				type: "github_error",
				status: res.status,
				message: "pending_deployments の応答が想定と違う",
			},
		};
	}
	return { ok: true, value: parsed.output };
}

export async function reviewPendingDeployments(
	token: string,
	repo: string,
	runId: number,
	environmentIds: number[],
	state: "approved" | "rejected",
	comment: string,
): Promise<{ ok: true } | { ok: false; error: GithubError }> {
	const res = await fetch(
		`${API}/repos/${repo}/actions/runs/${runId}/pending_deployments`,
		{
			method: "POST",
			headers: { ...headers(token), "content-type": "application/json" },
			body: JSON.stringify({ environment_ids: environmentIds, state, comment }),
		},
	);
	if (!res.ok) return { ok: false, error: await errorOf(res) };
	return { ok: true };
}
