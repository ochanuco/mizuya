import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { tempDir } from "../test-support.ts";
import { classify, decide } from "./decide.ts";
import { GUARD_ENV, guardRunFromEnv } from "./env.ts";
import { createLedger } from "./ledger.ts";

const HOOK = join(import.meta.dirname, "hook.ts");

const runHook = (input: unknown, env: Record<string, string>) => {
	const r = spawnSync(process.execPath, [HOOK], {
		input: typeof input === "string" ? input : JSON.stringify(input),
		env: { PATH: process.env.PATH ?? "", ...env },
		encoding: "utf8",
	});
	return {
		status: r.status,
		out: r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null,
		stderr: r.stderr,
	};
};

const bash = (command: string) => ({
	tool_name: "Bash",
	tool_input: { command },
	cwd: "/home/worker/work",
});

describe("classify: Claude CLI が書き出した道具の応答", () => {
	const { ctx } = guardRunFromEnv({ HOME: "/home/worker" });
	const file = "/home/worker/.claude/projects/p/s/tool-results/a.txt";
	it("Read は通し、書き換えは止める", () => {
		expect(classify({ tool: "Read", target: file }, ctx)).toBeNull();
		expect(classify({ tool: "Write", target: file }, ctx)).not.toBeNull();
	});
});

describe("classify: Codex の席", () => {
	const { ctx } = guardRunFromEnv({ HOME: "/home/worker" });
	const patch = (path: string) =>
		`*** Begin Patch\n*** Update File: ${path}\n@@\n-a\n+b\n*** End Patch`;
	it("apply_patch で Codex のログイン情報や設定の場所を書き換えるのは止める", () => {
		for (const path of [
			"/home/worker/.codex/auth.json",
			"/etc/codex/requirements.toml",
			"/home/worker/state/guard/grants/p1.json",
		]) {
			expect(
				classify({ tool: "apply_patch", target: patch(path) }, ctx),
			).not.toBeNull();
		}
	});
	it("作業場所の中を書き換える apply_patch は hook では決めない", () => {
		expect(
			classify({ tool: "apply_patch", target: patch("r/src/a.ts") }, ctx),
		).toBeNull();
	});
	it("Codex のログイン情報の読み出しは止める", () => {
		expect(
			classify({ tool: "Bash", target: "cat ~/.codex/auth.json" }, ctx),
		).not.toBeNull();
	});
	it("Codex の hook の入力の cwd から席の投稿を引く", () => {
		const run = guardRunFromEnv(
			{ HOME: "/home/worker", [GUARD_ENV.seatsDir]: "/seats" },
			"/seats/seat-p1/repo",
		);
		expect(run.threadId).toBe("p1");
	});
});

describe("classify: Bash 以外の道具", () => {
	const { ctx } = guardRunFromEnv({ HOME: "/home/worker" });
	it("秘密に触らない道具は hook では決めない", () => {
		for (const op of [
			{ tool: "Write", target: "/home/worker/work/r/a.ts" },
			{ tool: "Edit", target: "/home/worker/.bashrc" },
			{ tool: "Read", target: "/etc/hosts" },
			{ tool: "Grep", target: "/home/worker/work foo" },
			{ tool: "ToolSearch", target: "{}" },
			{ tool: "WebFetch", target: "{}" },
			{ tool: "mcp__claude_ai_chimera__create_request", target: "{}" },
			{ tool: "mcp__claude_ai_Gmail__send_message", target: "{}" },
		]) {
			expect(classify(op, ctx), op.tool).toBeNull();
		}
	});
	it("秘密や許可の記録の場所を読む・書く操作は止める", () => {
		for (const op of [
			{ tool: "Read", target: "/home/worker/.claude/.credentials.json" },
			{ tool: "Grep", target: "/home/worker TOKEN" },
			{ tool: "Write", target: "/home/worker/state/guard/grants/t1.json" },
			{ tool: "Edit", target: "/etc/claude-code/managed-settings.json" },
		]) {
			expect(classify(op, ctx), op.target).not.toBeNull();
		}
	});
});

describe("decide", () => {
	it("許可は同じ操作に 1 回だけ使え、秘密に触らない操作はそのあと auto モードに任せる", () => {
		const dir = tempDir();
		const ledger = createLedger(dir);
		const base = guardRunFromEnv({ HOME: "/home/worker" });
		const op = { tool: "Bash", target: "git push origin main" };
		const run = { ...base, threadId: "t1", grants: [op], grantId: "g1" };

		expect(decide(bash("git push origin main"), run, ledger)?.decision).toBe(
			"allow",
		);
		expect(decide(bash("git push origin main"), run, ledger)).toBeNull();
		expect(decide(bash("printenv"), run, ledger)?.decision).toBe("deny");
		expect(ledger.takePending("t1").map((p) => p.operation.target)).toEqual([
			"printenv",
		]);
		const events = readFileSync(join(dir, "log.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l).event);
		expect(events).toEqual(["used", "blocked"]);
	});
});

describe("guardRunFromEnv: 席の中かどうか", () => {
	const env = {
		HOME: "/home/worker",
		[GUARD_ENV.seatsDir]: "/home/worker/work/orca/workspaces/seats",
	};
	it("席の中なら、その席の worktree を作業場所にし、名前から投稿を引く", () => {
		const run = guardRunFromEnv(
			env,
			"/home/worker/work/orca/workspaces/seats/seat-123/repo",
		);
		expect(run.threadId).toBe("123");
		expect(run.ctx.workDir).toBe(
			"/home/worker/work/orca/workspaces/seats/seat-123",
		);
	});
	it("席の外や、席の名前でない場所は投稿に紐づけない", () => {
		for (const dir of [
			"/home/worker/work",
			"/home/worker/work/orca/workspaces/seats",
			"/home/worker/work/orca/workspaces/seats/other",
			"/home/worker/work/orca/workspaces/seats/seat-../x",
		]) {
			const run = guardRunFromEnv(env, dir);
			expect(run.threadId).toBe("_");
			expect(run.ctx.workDir).toBe("/home/worker/work");
		}
	});
	it("CLAUDE_PROJECT_DIR があれば cwd より優先する", () => {
		const run = guardRunFromEnv(
			{
				...env,
				CLAUDE_PROJECT_DIR: "/home/worker/work/orca/workspaces/seats/seat-9",
			},
			"/tmp",
		);
		expect(run.threadId).toBe("9");
	});
});

describe("hook.ts（Claude CLI から呼ばれる形で動かす）", () => {
	const SEATS = "/home/worker/work/orca/workspaces/seats";
	const envFor = (stateDir: string) => ({
		HOME: "/home/worker",
		[GUARD_ENV.stateDir]: stateDir,
		[GUARD_ENV.seatsDir]: SEATS,
		CLAUDE_PROJECT_DIR: `${SEATS}/seat-t1`,
	});
	const seatBash = (command: string) => ({
		tool_name: "Bash",
		tool_input: { command },
		cwd: `${SEATS}/seat-t1`,
	});

	it("秘密に触らない操作には何も返さず、auto モードに任せる", () => {
		const state = tempDir();
		const r = runHook(seatBash("git push origin main"), envFor(state));
		expect(r.status).toBe(0);
		expect(r.out).toBeNull();
	});

	it("秘密の読み出しは deny を返し、席の投稿に紐づけて残す", () => {
		const state = tempDir();
		const r = runHook(seatBash("printenv"), envFor(state));
		expect(r.status).toBe(0);
		expect(r.out.permissionDecision).toBe("deny");
		expect(r.out.permissionDecisionReason).toContain("orca orchestration ask");
		expect(createLedger(join(state, "guard")).takePending("t1")).toEqual([
			{
				operation: { tool: "Bash", target: "printenv" },
				reason: "秘密情報の読み出し",
			},
		]);
	});

	it("auto モードが止めた操作（PermissionDenied）を、席の投稿に紐づけて残す", () => {
		const state = tempDir();
		const r = runHook(
			{
				hook_event_name: "PermissionDenied",
				...seatBash("gh pr merge 3"),
				tool_use_id: "u1",
				reason: "マージは持ち主の確認が要る",
			},
			envFor(state),
		);
		expect(r.status).toBe(0);
		expect(createLedger(join(state, "guard")).takePending("t1")).toEqual([
			{
				operation: { tool: "Bash", target: "gh pr merge 3" },
				reason: "auto モードが止めた（マージは持ち主の確認が要る）",
			},
		]);
	});

	it("受付が書いた許可は auto モードによらず 1 回だけ通す", () => {
		const state = tempDir();
		createLedger(join(state, "guard")).grant("t1", {
			grant_id: "g1",
			operations: [{ tool: "Bash", target: "gh pr merge 3" }],
		});
		const env = envFor(state);
		expect(runHook(seatBash("gh pr merge 3"), env).out.permissionDecision).toBe(
			"allow",
		);
		expect(runHook(seatBash("gh pr merge 3"), env).out).toBeNull();
	});

	it("入力が読めないときは exit 2 で止める", () => {
		const r = runHook("not json", envFor(tempDir()));
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("guard failed");
	});
});
