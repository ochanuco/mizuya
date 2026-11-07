import { describe, expect, it, vi } from "vitest";
import { childEnv, createSummarizer } from "./claude-cli.ts";
import type { Exec } from "./exec.ts";

const execReturning = (code: number | null, stdout: string, stderr = "") =>
	vi.fn<Exec>(async () => ({ code, stdout, stderr }));

const summarizer = (exec: Exec) =>
	createSummarizer({ bin: "claude", cwd: "/work", env: { HOME: "/h" }, exec });

describe("childEnv", () => {
	it("受付の秘密と記憶の口の service token は子のプロセスに渡さない", () => {
		const env = childEnv(
			{
				HOME: "/home/w",
				PATH: "/bin",
				GH_TOKEN: "gh",
				DISCORD_TOKEN: "secret",
				MIZUYA_INBOX_TOKEN: "secret",
				MAC_STATE_TOKEN: "secret",
				CF_ACCESS_CLIENT_SECRET: "secret",
			},
			"/home/w/state",
		);
		expect(env).toEqual({
			HOME: "/home/w",
			PATH: "/bin",
			GH_TOKEN: "gh",
			MIZUYA_STATE_DIR: "/home/w/state",
		});
	});
});

describe("createSummarizer", () => {
	it("指示を system prompt に分け、道具なし・セッションなしで頼む", async () => {
		const exec = execReturning(0, JSON.stringify({ result: "請求書の整理" }));
		const r = await summarizer(exec)("請求書を…");
		expect(r).toEqual({ ok: true, value: "請求書の整理" });
		const [, args, o] = exec.mock.calls[0] ?? [];
		expect(args).toEqual(
			expect.arrayContaining(["--no-session-persistence", "--tools", ""]),
		);
		expect(args?.[(args?.indexOf("--system-prompt") ?? -2) + 1]).toContain(
			"件名を付ける係",
		);
		expect(o?.stdin).toBe("<依頼>請求書を…</依頼>");
	});

	it("前置きやメタ発言の出力、異常終了は err を返す", async () => {
		for (const result of [
			"件名だけを出力する依頼なので、要約を返します。",
			"件名だけを出力する依頼なので、要約を返します。\n請求書の整理",
		]) {
			const r = await summarizer(execReturning(0, JSON.stringify({ result })))(
				"x",
			);
			expect(r).toEqual({
				ok: false,
				error: { type: "SummaryFailed", reason: "summary rejected" },
			});
		}
		const crashed = await summarizer(execReturning(null, "", "spawn ENOENT"))(
			"x",
		);
		expect(!crashed.ok && crashed.error.type).toBe("SummaryFailed");
	});
});
