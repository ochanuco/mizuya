import { describe, expect, it, vi } from "vitest";
import type { Exec } from "./exec.ts";
import { createGhIssueTracker } from "./issue-close.ts";

const ISSUE = { repo: "example/repo", number: 7 };

const trackerWith = (stdout: string, code = 0) => {
	const exec = vi.fn<Exec>(async () => ({ code, stdout, stderr: "boom" }));
	return {
		exec,
		tracker: createGhIssueTracker({ exec, env: {}, cwd: "/tmp" }),
	};
};

describe("createGhIssueTracker", () => {
	it("issue の state が OPEN なら開いているとみなす", async () => {
		expect(await trackerWith("OPEN\n").tracker.isOpen(ISSUE)).toEqual({
			ok: true,
			value: true,
		});
		expect(await trackerWith("CLOSED\n").tracker.isOpen(ISSUE)).toEqual({
			ok: true,
			value: false,
		});
	});

	it("gh が失敗したら状態を引けなかったと返す", async () => {
		const r = await trackerWith("", 1).tracker.isOpen(ISSUE);
		expect(r.ok).toBe(false);
	});

	it("閉じるときはコメントを添えて gh issue close を呼ぶ", async () => {
		const { exec, tracker } = trackerWith("");
		expect((await tracker.close(ISSUE)).ok).toBe(true);
		expect(exec.mock.calls[0]?.[1].slice(0, 5)).toEqual([
			"issue",
			"close",
			"7",
			"--repo",
			"example/repo",
		]);
		expect(exec.mock.calls[0]?.[1]).toContain("--comment");
	});
});
