import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Exec } from "./exec.ts";
import { err, ok, type Result } from "./lib/core.ts";
import { silentLogger } from "./logger.ts";
import { createOrcaCli, seatCommand } from "./orca.ts";
import { tempDir } from "./test-support.ts";

type Reply = { code?: number; stdout?: unknown; stderr?: string };

/** orca-ide のモック。コマンドの頭の 2 語で応答を引く。 */
const fakeExec = (
	table: Record<string, Reply | ((args: readonly string[]) => Reply)>,
) =>
	vi.fn<Exec>(async (bin, args) => {
		const key = bin === "git" ? "git" : args.slice(0, 2).join(" ");
		const hit = table[key];
		const r =
			typeof hit === "function"
				? hit(args)
				: (hit ?? { stdout: { ok: true, result: {} } });
		return {
			code: r.code ?? 0,
			stdout:
				typeof r.stdout === "string"
					? r.stdout
					: JSON.stringify(r.stdout ?? {}),
			stderr: r.stderr ?? "",
		};
	});

const setup = (
	table: Parameters<typeof fakeExec>[0],
	trustResult: (dir: string) => Result<string, { reason: string }> = ok,
) => {
	const root = tempDir();
	const order: string[] = [];
	const trusting = async (dir: string) => {
		order.push(`trust ${dir}`);
		return trustResult(dir);
	};
	const seatsRepo = join(root, "seats");
	mkdirSync(join(seatsRepo, ".git"), { recursive: true });
	const exec0 = fakeExec({
		"worktree create": (args) => ({
			stdout: {
				ok: true,
				result: {
					worktree: { path: `/ws/${args[args.indexOf("--name") + 1]}` },
				},
			},
		}),
		"repo list": {
			stdout: { ok: true, result: { repos: [{ id: "r1", path: seatsRepo }] } },
		},
		"terminal list": { stdout: { ok: true, result: { terminals: [] } } },
		"terminal create": {
			stdout: { ok: true, result: { terminal: { handle: "rx" } } },
		},
		"orchestration run-create": {
			stdout: { ok: true, result: { runId: "run-new" } },
		},
		...table,
	});
	const exec = vi.fn<Exec>(async (bin, args, o) => {
		order.push(args.slice(0, 2).join(" "));
		return exec0(bin, args, o);
	});
	const orca = createOrcaCli({
		bin: "orca-ide",
		exec,
		env: { HOME: "/h" },
		cwd: root,
		seatsRepo,
		sleep: async () => {},
		trust: trusting,
		seatsDir: join(root, "ws"),
		specDir: join(root, "specs"),
		logger: silentLogger,
	});
	const argsOf = (cmd: string) =>
		exec.mock.calls
			.filter(([, a]) => a.slice(0, 2).join(" ") === cmd)
			.map(([, a]) => a);
	return { orca, exec, argsOf, seatsRepo, order, root };
};

describe("waitReady", () => {
	const statuses = (states: (string | null)[]) => {
		let i = 0;
		return fakeExec({
			"status --json": () => {
				const state = states[Math.min(i++, states.length - 1)];
				return state === null
					? {
							code: 1,
							stdout: {
								ok: false,
								error: {
									code: "runtime_unavailable",
									message: "This terminal could not connect to Orca.",
								},
							},
						}
					: { stdout: { ok: true, result: { runtime: { state } } } };
			},
		});
	};
	const orcaWith = (exec: Exec) =>
		createOrcaCli({
			bin: "orca-ide",
			exec,
			env: {},
			cwd: "/work",
			seatsRepo: "/s",
			seatsDir: "/w",
			specDir: "/tmp",
			logger: silentLogger,
			sleep: async () => {},
			trust: async (d: string) => ok(d),
		});

	it("serve がつながらない間と ready でない間は待ち、ready になったら返す", async () => {
		const exec = statuses([null, null, "starting", "ready"]);
		expect(await orcaWith(exec).waitReady(60_000)).toEqual({
			ok: true,
			value: undefined,
		});
		expect(exec).toHaveBeenCalledTimes(4);
		// 席の元のリポジトリは prepare まで無いので、orca-ide は起動時からある場所で動かす
		expect(exec.mock.calls.every(([, , o]) => o.cwd === "/work")).toBe(true);
	});

	it("期限までに ready にならなければ、最後の理由で失敗する", async () => {
		const r = await orcaWith(statuses([null])).waitReady(0);
		expect(r).toEqual({
			ok: false,
			error: {
				type: "OrcaFailed",
				command: "status",
				reason: "This terminal could not connect to Orca.",
			},
		});
	});
});

describe("createOrcaCli", () => {
	it("prepare は前の受付の端末を閉じ、新しい受付の端末で Run を引き継ぐ", async () => {
		const t = setup({
			"orchestration run-use": {
				stdout: { ok: true, result: { runId: "run1" } },
			},
		});
		const r = await t.orca.prepare({ runId: "run1", reception: "rx-old" });
		expect(r).toEqual({ ok: true, value: { runId: "run1", reception: "rx" } });
		expect(t.argsOf("terminal close")[0]).toContain("rx-old");
		expect(t.argsOf("terminal create")[0]).toEqual(
			expect.arrayContaining([
				"--worktree",
				`path:${t.seatsRepo}`,
				"--command",
				"sleep infinity",
			]),
		);
		expect(t.argsOf("orchestration run-use")[0]).toEqual(
			expect.arrayContaining(["--id", "run1", "--from", "rx"]),
		);
		expect(t.argsOf("orchestration run-create")).toEqual([]);
	});

	it("席の元のリポジトリが無ければ、Orca に触らず失敗する", async () => {
		const t = setup({});
		rmSync(join(t.seatsRepo, ".git"), { recursive: true });
		const r = await t.orca.prepare({ runId: null, reception: null });
		expect(!r.ok && r.error.reason).toContain("init-seats-repo.sh");
		expect(t.exec).not.toHaveBeenCalled();
	});

	it("Run を引き継げなければ作り直す", async () => {
		const t = setup({
			"orchestration run-use": {
				code: 1,
				stdout: { ok: false, error: { code: "not_found", message: "no run" } },
			},
		});
		const r = await t.orca.prepare({ runId: "gone", reception: null });
		expect(r.ok && r.value.runId).toBe("run-new");
	});

	it("席は worktree を作って Claude の信頼済みにしてから、その worktree で Claude を起動する", async () => {
		let spec = "";
		const t = setup({
			"orchestration worker-start": (args) => {
				const file = args[args.indexOf("--spec-file") + 1] ?? "";
				spec = readFileSync(file, "utf8");
				return {
					stdout: {
						ok: true,
						result: {
							dispatchId: "d1",
							terminal: "t1",
							workspace: "r1::/ws/seat-p1",
						},
					},
				};
			},
		});
		await t.orca.prepare({ runId: null, reception: null });
		t.order.length = 0;
		const r = await t.orca.startSeat({
			name: "seat-p1",
			title: "件名",
			spec: "頼みます",
			agent: "claude",
		});
		expect(r).toEqual({
			ok: true,
			value: { dispatchId: "d1", terminal: "t1", path: "/ws/seat-p1" },
		});
		expect(spec).toBe("頼みます");
		expect(t.order).toEqual([
			"worktree create",
			"trust /ws/seat-p1",
			"terminal create",
			"orchestration worker-start",
		]);
		// Orca の agent の起動（--dangerously-skip-permissions）ではなく、auto モードの Claude を受付が起動する
		expect(t.argsOf("terminal create").at(-1)).toEqual(
			expect.arrayContaining([
				"--worktree",
				"path:/ws/seat-p1",
				"--command",
				"claude --permission-mode auto",
			]),
		);
		expect(t.argsOf("worktree create")[0]).toEqual(
			expect.arrayContaining([
				"--repo",
				"id:r1",
				"--name",
				"seat-p1",
				"--no-parent",
			]),
		);
		expect(t.argsOf("orchestration worker-start")[0]).toEqual(
			expect.arrayContaining([
				"--from",
				"rx",
				"--run",
				"run-new",
				"--terminal",
				"rx",
				"--worktree",
				"path:/ws/seat-p1",
			]),
		);
		expect(t.argsOf("orchestration worker-start")[0]).not.toContain("--agent");
	});

	it("信頼済みにできなければ Claude を起動しない", async () => {
		const t = setup({}, () => err({ reason: "lock" }));
		await t.orca.prepare({ runId: null, reception: null });
		const r = await t.orca.startSeat({
			name: "seat-p1",
			title: "件名",
			spec: "x",
			agent: "claude",
		});
		expect(r).toEqual({
			ok: false,
			error: {
				type: "SeatTrustFailed",
				command: "claude trust",
				reason: "lock",
			},
		});
		expect(t.argsOf("orchestration worker-start")).toEqual([]);
	});

	it("止めた席は auto モードの claude --continue の端末を作って渡し、前の会話のまま起こす", async () => {
		const t = setup({
			"terminal create": (args) => ({
				stdout: {
					ok: true,
					result: {
						terminal: {
							handle: args.includes("claude --permission-mode auto --continue")
								? "t9"
								: "rx",
						},
					},
				},
			}),
			"orchestration worker-start": {
				stdout: {
					ok: true,
					result: {
						dispatchId: "d9",
						terminal: "t9",
						workspace: "r1::/ws/seat-p1",
					},
				},
			},
		});
		await t.orca.prepare({ runId: null, reception: null });
		const seat = join(t.root, "ws", "seat-p1");
		mkdirSync(seat, { recursive: true });
		const r = await t.orca.resumeSeat({
			path: seat,
			title: "件名",
			spec: "続き",
			agent: "claude",
		});
		expect(r.ok && r.value.dispatchId).toBe("d9");
		expect(t.argsOf("orchestration worker-start")[0]).toEqual(
			expect.arrayContaining([
				"--terminal",
				"t9",
				"--worktree",
				`path:${seat}`,
			]),
		);
		expect(t.argsOf("orchestration worker-start")[0]).not.toContain("--agent");
		expect(t.order.indexOf(`trust ${seat}`)).toBeLessThan(
			t.order.lastIndexOf("terminal create"),
		);
	});

	it("worktree が無くなった席は起こさず、無いと返す", async () => {
		const t = setup({});
		const r = await t.orca.resumeSeat({
			path: join(t.root, "ws", "seat-gone"),
			title: "件名",
			spec: "続き",
			agent: "claude",
		});
		expect(!r.ok && r.error.type).toBe("SeatWorktreeMissing");
		expect(t.argsOf("terminal create")).toEqual([]);
	});

	it("Akarin の席は Claude の信頼を書かず、承認なし・sandbox なしの Codex の端末を作って渡す", async () => {
		const t = setup({
			"orchestration worker-start": {
				stdout: {
					ok: true,
					result: {
						dispatchId: "d1",
						terminal: "rx",
						workspace: "r1::/ws/seat-p1",
					},
				},
			},
		});
		await t.orca.prepare({ runId: null, reception: null });
		t.order.length = 0;
		const r = await t.orca.startSeat({
			name: "seat-p1",
			title: "件名",
			spec: "頼みます",
			agent: "codex",
		});
		expect(r.ok).toBe(true);
		expect(t.order).not.toContain("trust /ws/seat-p1");
		const created = t.argsOf("terminal create").at(-1) ?? [];
		const command = created[created.indexOf("--command") + 1] ?? "";
		expect(command.startsWith("codex ")).toBe(true);
		expect(command).toContain("-a never -s danger-full-access");
		expect(command).toContain(
			"shell_environment_policy.set.YUNOMI_PARTNER=akarin",
		);
	});

	it("止めた Akarin の席は codex resume --last で前の会話のまま起こす", async () => {
		const t = setup({
			"orchestration worker-start": {
				stdout: {
					ok: true,
					result: {
						dispatchId: "d9",
						terminal: "rx",
						workspace: "r1::/ws/seat-p1",
					},
				},
			},
		});
		await t.orca.prepare({ runId: null, reception: null });
		const seat = join(t.root, "ws", "seat-p1");
		mkdirSync(seat, { recursive: true });
		await t.orca.resumeSeat({
			path: seat,
			title: "件名",
			spec: "続き",
			agent: "codex",
		});
		const created = t.argsOf("terminal create").at(-1) ?? [];
		const command = created[created.indexOf("--command") + 1] ?? "";
		expect(command.startsWith("codex resume --last ")).toBe(true);
		expect(command).toContain("-a never -s danger-full-access");
	});

	it("モデルを選んだ席は、起動にも再開にも同じモデルを渡す", async () => {
		const t = setup({
			"orchestration worker-start": {
				stdout: {
					ok: true,
					result: {
						dispatchId: "d9",
						terminal: "rx",
						workspace: "r1::/ws/seat-p1",
					},
				},
			},
		});
		await t.orca.prepare({ runId: null, reception: null });
		const seat = join(t.root, "ws", "seat-p1");
		mkdirSync(seat, { recursive: true });
		const commandOfLast = () => {
			const created = t.argsOf("terminal create").at(-1) ?? [];
			return created[created.indexOf("--command") + 1] ?? "";
		};
		await t.orca.startSeat({
			name: "seat-p1",
			title: "件名",
			spec: "依頼",
			agent: "claude",
			model: "sonnet",
		});
		expect(commandOfLast()).toBe(
			"claude --permission-mode auto --model sonnet",
		);
		await t.orca.resumeSeat({
			path: seat,
			title: "件名",
			spec: "続き",
			agent: "claude",
			model: "sonnet",
		});
		expect(commandOfLast()).toBe(
			"claude --permission-mode auto --model sonnet --continue",
		);
		await t.orca.startSeat({
			name: "seat-p1",
			title: "件名",
			spec: "依頼",
			agent: "codex",
			model: "terra",
		});
		expect(commandOfLast()).toMatch(/^codex -m gpt-5.6-terra -a never /);
		await t.orca.resumeSeat({
			path: seat,
			title: "件名",
			spec: "続き",
			agent: "codex",
			model: "luna",
		});
		expect(commandOfLast()).toMatch(
			/^codex resume --last -m gpt-5.6-luna -a never /,
		);
	});

	it("モデルを選んでいない席はモデルを渡さない", async () => {
		const t = setup({});
		await t.orca.prepare({ runId: null, reception: null });
		await t.orca.startSeat({
			name: "seat-p1",
			title: "件名",
			spec: "依頼",
			agent: "codex",
			model: null,
		});
		const created = t.argsOf("terminal create").at(-1) ?? [];
		expect(created[created.indexOf("--command") + 1]).not.toContain(" -m ");
	});

	it("Claude の席のモデルは、端末に /model を送って切り替える", async () => {
		const t = setup({});
		const r = await t.orca.switchModel({ terminal: "t7", model: "haiku" });
		expect(r.ok).toBe(true);
		expect(t.argsOf("terminal send").at(-1)).toEqual([
			"terminal",
			"send",
			"--terminal",
			"t7",
			"--text",
			"/model haiku",
			"--enter",
			"--json",
		]);
	});

	it("届いたメッセージを読み、失敗は OrcaFailed にする", async () => {
		const t = setup({
			"orchestration check": {
				stdout: {
					ok: true,
					result: {
						messages: [
							{
								id: "m1",
								type: "worker_done",
								body: "済み",
								payload: { dispatchId: "d1", outcome: "succeeded" },
							},
							{
								id: "m2",
								type: "escalation",
								body: "x",
								payload: { dispatchId: "d1", stopReason: "finished" },
							},
						],
					},
				},
			},
			"orchestration reply": { code: 1, stdout: "", stderr: "error: boom" },
		});
		await t.orca.prepare({ runId: null, reception: null });
		const r = await t.orca.waitMessages(1000);
		expect(r.ok && r.value).toEqual([
			{
				id: "m1",
				type: "worker_done",
				from: "",
				subject: "",
				body: "済み",
				dispatchId: "d1",
				outcome: "succeeded",
				stopReason: null,
			},
			{
				id: "m2",
				type: "escalation",
				from: "",
				subject: "",
				body: "x",
				dispatchId: "d1",
				outcome: null,
				stopReason: "finished",
			},
		]);
		expect(t.argsOf("orchestration check")[0]).toEqual(
			expect.arrayContaining([
				"--terminal",
				"rx",
				"--run",
				"run-new",
				"--wait",
			]),
		);
		const failed = await t.orca.reply({ messageId: "q", body: "a" });
		expect(failed).toEqual({
			ok: false,
			error: {
				type: "OrcaFailed",
				command: "orchestration reply",
				reason: "error: boom",
			},
		});
	});

	it("席を止めたあと端末が残っていれば失敗にする", async () => {
		const t = setup({
			"terminal list": {
				stdout: { ok: true, result: { terminals: [{ handle: "t1" }] } },
			},
		});
		const r = await t.orca.stopSeat({ dispatchId: "d1", terminal: "t1" });
		expect(r.ok).toBe(false);
		expect(t.argsOf("orchestration worker-stop")).toHaveLength(1);
		expect(t.argsOf("terminal close")[0]).toContain("t1");
	});
});

describe("hishaku に預けた席の起動", () => {
	const commandOf = (t: ReturnType<typeof setup>) => {
		const created = t.argsOf("terminal create").at(-1) ?? [];
		return created[created.indexOf("--command") + 1] ?? "";
	};
	const started = {
		"orchestration worker-start": {
			stdout: {
				ok: true,
				result: {
					dispatchId: "d1",
					terminal: "rx",
					workspace: "r1::/ws/seat-p1",
				},
			},
		},
	};

	it("先頭は agent のまま、session_id で新規・再開のコマンドを組む", () => {
		const id = "0b0b0b0b-1111-4222-8333-444444444444";
		expect(seatCommand("claude", { sessionId: id, resume: false }, null)).toBe(
			`claude --permission-mode auto --session-id ${id}`,
		);
		expect(seatCommand("claude", { sessionId: id, resume: true }, "opus")).toBe(
			`claude --permission-mode auto --model opus -r ${id}`,
		);
		expect(seatCommand("codex", { sessionId: id, resume: true }, null)).toMatch(
			new RegExp(`^codex resume ${id} -a never `),
		);
		// Codex は新規の ID を外から渡せない。空の session_id は今の起動と同じ
		expect(seatCommand("codex", { sessionId: "", resume: false }, null)).toBe(
			seatCommand("codex", "start", null),
		);
	});

	it("worktree を信頼済みにしてから prepare を呼び、返った起こし方と spec で起こす", async () => {
		let spec = "";
		const t = setup({
			"orchestration worker-start": (args) => {
				spec = readFileSync(
					args[args.indexOf("--spec-file") + 1] ?? "",
					"utf8",
				);
				return started["orchestration worker-start"];
			},
		});
		await t.orca.prepare({ runId: null, reception: null });
		t.order.length = 0;
		const prepare = vi.fn(async (cwd: string) => {
			t.order.push(`prepare ${cwd}`);
			return ok({
				how: { sessionId: "abc-1", resume: true },
				spec: "続きだけ",
			});
		});
		const r = await t.orca.startSeat({
			name: "seat-p1",
			title: "件名",
			spec: "前置きとやりとり",
			agent: "claude",
			prepare,
		});
		expect(r.ok).toBe(true);
		expect(t.order.slice(1, 3)).toEqual([
			"trust /ws/seat-p1",
			"prepare /ws/seat-p1",
		]);
		expect(commandOf(t)).toBe("claude --permission-mode auto -r abc-1");
		expect(spec).toBe("続きだけ");
	});

	it("他の機械が借りていれば起こさず、作った worktree を消す", async () => {
		const t = setup(started);
		await t.orca.prepare({ runId: null, reception: null });
		const r = await t.orca.startSeat({
			name: "seat-p1",
			title: "件名",
			spec: "x",
			agent: "codex",
			prepare: async () => err({ holder: "mac-example" }),
		});
		expect(r).toEqual({
			ok: false,
			error: {
				type: "SeatLeaseHeld",
				command: "hs prepare",
				reason: "mac-example",
			},
		});
		expect(t.argsOf("orchestration worker-start")).toEqual([]);
		expect(t.argsOf("worktree rm").at(-1)).toEqual(
			expect.arrayContaining(["--worktree", "path:/ws/seat-p1"]),
		);
	});
});
