import { describe, expect, it } from "vitest";
import { requestedMessage, targetOf } from "../src/review.ts";
import { pendingMessage, REPO, RUN_ID } from "./fixtures.ts";

describe("targetOf", () => {
	it("投稿したメッセージから repo・run・Environment を読む", () => {
		const longEnvironment = `env:${"x".repeat(200)}`;
		const posted = requestedMessage({
			repo: "example-organization/a-repository-with-a-very-long-name",
			repoUrl: "https://github.com/example/app",
			runId: 98765432101,
			runUrl:
				"https://github.com/example-organization/a-repository-with-a-very-long-name/actions/runs/98765432101",
			workflow: "deploy",
			ref: "main",
			sha: "0123456789abcdef0123456789abcdef01234567",
			environment: longEnvironment,
			requestor: null,
		});
		const message = {
			embeds: posted.embeds,
			components: posted.components as never,
		};
		expect(targetOf(message)).toEqual({
			repo: "example-organization/a-repository-with-a-very-long-name",
			runId: 98765432101,
			environment: longEnvironment,
		});
		for (const row of posted.components as {
			components: { custom_id: string }[];
		}[]) {
			for (const button of row.components) {
				expect(button.custom_id.length).toBeLessThanOrEqual(100);
			}
		}
	});

	it("Environment が * でも、その名前のまま扱う", () => {
		expect(targetOf(pendingMessage("m", { environment: "*" }))).toEqual({
			repo: REPO,
			runId: RUN_ID,
			environment: "*",
		});
	});

	it("ボタンが無い（決着済み）メッセージは対象にしない", () => {
		expect(targetOf({ ...pendingMessage("m"), components: [] })).toBeNull();
	});
});
