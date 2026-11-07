import type { Button } from "./discord-rest.ts";
import type { Exec } from "./exec.ts";
import { err, ok, type Result } from "./lib/result.ts";
import type { IssueRef } from "./seat-store.ts";

const CLOSE_ISSUE_ID = "issue:close";

/** issue から立てた投稿が完了したときに付けるボタン。持ち主が押すと issue を閉じる。 */
export const CLOSE_ISSUE_BUTTON: Button = {
	customId: CLOSE_ISSUE_ID,
	label: "issue を閉じる",
	style: "success",
};

export const isCloseIssueButton = (customId: string) =>
	customId === CLOSE_ISSUE_ID;

export const issueRefText = (issue: IssueRef) =>
	`${issue.repo}#${issue.number}`;

/** open が null なら、issue の状態を引けなかった。閉じるボタンは出しておき、押したときに確かめる。 */
export const issueDoneText = (
	owner: string | null,
	issue: IssueRef,
	open: boolean | null,
) => {
	const head = owner ? `<@${owner}> ` : "";
	const ref = issueRefText(issue);
	return open === false
		? `${head}issue ${ref} の作業が終わりました。issue はもう閉じています。`
		: `${head}issue ${ref} の作業が終わりました。確かめて問題なければ「issue を閉じる」を押すと閉じます。`;
};

export const issueClosedText = (content: string) =>
	`${content}\n\nissue を閉じました。`;

export type IssueTracker = {
	isOpen: (issue: IssueRef) => Promise<Result<boolean, { reason: string }>>;
	close: (issue: IssueRef) => Promise<Result<void, { reason: string }>>;
};

const GH_TIMEOUT_MS = 60_000;

export const createGhIssueTracker = (deps: {
	exec: Exec;
	env: Record<string, string>;
	cwd: string;
}): IssueTracker => {
	const gh = (args: readonly string[]) =>
		deps.exec("gh", args, {
			stdin: "",
			cwd: deps.cwd,
			timeoutMs: GH_TIMEOUT_MS,
			env: deps.env,
		});
	const target = (issue: IssueRef) => [
		String(issue.number),
		"--repo",
		issue.repo,
	];
	return {
		isOpen: async (issue) => {
			const r = await gh([
				"issue",
				"view",
				...target(issue),
				"--json",
				"state",
				"--jq",
				".state",
			]);
			if (r.code !== 0) return err({ reason: r.stderr.slice(0, 300) });
			return ok(r.stdout.trim() === "OPEN");
		},
		close: async (issue) => {
			const r = await gh([
				"issue",
				"close",
				...target(issue),
				"--comment",
				"Working の作業を持ち主が確かめ、閉じました。",
			]);
			return r.code === 0
				? ok(undefined)
				: err({ reason: r.stderr.slice(0, 300) });
		},
	};
};
