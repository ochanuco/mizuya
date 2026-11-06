import { describe, expect, it } from "vitest";
import { toWorkEvent } from "../src/work-events.ts";
import { failedRun } from "./fixtures.ts";

describe("toWorkEvent", () => {
	it("Actions の check_suite は workflow_run と重なるので捨てる", () => {
		const suite = (slug: string) => ({
			action: "completed",
			check_suite: {
				conclusion: "failure",
				head_branch: "main",
				head_sha: "abc",
				app: { slug, name: slug },
				pull_requests: [],
			},
			repository: { full_name: "o/r", html_url: "https://github.com/o/r" },
			sender: { login: "x" },
		});
		expect(toWorkEvent("check_suite", suite("github-actions"))).toBeNull();
		expect(toWorkEvent("check_suite", suite("other-ci"))).toMatchObject({
			kind: "ci_failed",
			url: "https://github.com/o/r/commit/abc/checks",
		});
	});

	it("成功した run、編集されたコメントは席を動かさない", () => {
		expect(toWorkEvent("workflow_run", failedRun("success"))).toBeNull();
		expect(
			toWorkEvent("issue_comment", {
				action: "edited",
				comment: { body: "x", html_url: "u", user: { login: "a" } },
				issue: { number: 1, title: "t" },
				repository: { full_name: "o/r" },
			}),
		).toBeNull();
		expect(toWorkEvent("push", {})).toBeNull();
	});

	it("issue_comment は PR のコメントかどうかと bot かどうかを持つ", () => {
		expect(
			toWorkEvent("issue_comment", {
				action: "created",
				comment: {
					body: "b",
					html_url: "u",
					user: { login: "renovate[bot]", type: "Bot" },
				},
				issue: { number: 4, title: "t", pull_request: {} },
				repository: { full_name: "o/r" },
			}),
		).toEqual({
			kind: "comment",
			repo: "o/r",
			number: 4,
			is_pr: true,
			title: "t",
			body: "b",
			url: "u",
			actor: "renovate[bot]",
			actor_is_bot: true,
		});
	});
});
