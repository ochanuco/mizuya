import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawnExec } from "./exec.ts";
import { err, ok } from "./lib/core.ts";
import { silentLogger } from "./logger.ts";
import type { SeatMessage } from "./seat-engine.ts";
import { tempDir } from "./test-support.ts";
import {
	createTurnEngine,
	type SpawnTurn,
	seatEnv,
	type TurnProcess,
} from "./turn-engine.ts";

type Call = {
	args: readonly string[];
	env: Record<string, string>;
	prompt: string;
	signals: string[];
	end: (out: unknown, code?: number) => void;
};

const fakeSpawn = () => {
	const calls: Call[] = [];
	const spawn: SpawnTurn = (_bin, args, opts) => {
		const file = args[args.indexOf("--prompt-file") + 1] ?? "";
		let resolve: (r: {
			code: number | null;
			stdout: string;
			stderr: string;
		}) => void = () => {};
		const done = new Promise<{
			code: number | null;
			stdout: string;
			stderr: string;
		}>((r) => {
			resolve = r;
		});
		const call: Call = {
			args,
			env: opts.env,
			prompt: readFileSync(file, "utf8"),
			signals: [],
			end: (out, code = 0) =>
				resolve({ code, stdout: `${JSON.stringify(out)}\n`, stderr: "" }),
		};
		const proc: TurnProcess = {
			done,
			kill: (signal) => {
				call.signals.push(signal);
				resolve({ code: 143, stdout: "", stderr: "" });
			},
		};
		calls.push(call);
		return proc;
	};
	return { calls, spawn };
};

const engines: { close: () => Promise<void> }[] = [];
afterEach(async () => {
	await Promise.all(engines.splice(0).map((e) => e.close()));
});

const setup = async () => {
	const dir = tempDir();
	const repo = join(dir, "seats-repo");
	execFileSync("bash", [
		"-c",
		`mkdir -p ${repo} && cd ${repo} && git init -q -b main && git -c user.name=t -c user.email=t@example.com commit -q --allow-empty -m init`,
	]);
	const fake = fakeSpawn();
	const engine = createTurnEngine({
		hsBin: "hs",
		exec: spawnExec,
		seatEnv: {
			HOME: dir,
			PATH: process.env.PATH ?? "",
			MIZUYA_STATE_DIR: "/state",
		},
		hishakuEnv: {
			HISHAKU_URL: "https://hishaku.example.com",
			XDG_CACHE_HOME: "/cache",
		},
		seatsRepo: repo,
		seatsDir: join(dir, "seats"),
		specDir: join(dir, "specs"),
		trust: async (d) => ok(d),
		logger: silentLogger,
		spawn: fake.spawn,
		stopTimeoutMs: 100,
	});
	engines.push(engine);
	expect((await engine.start()).ok).toBe(true);
	return { dir, engine, calls: fake.calls };
};

const tick = () => new Promise((r) => setTimeout(r, 20));

const messages = async (engine: ReturnType<typeof createTurnEngine>) => {
	await tick();
	const r = await engine.waitMessages(1);
	if (!r.ok) throw new Error("waitMessages failed");
	return r.value.map((m: SeatMessage) => ({
		type: m.type,
		body: m.body,
		outcome: m.outcome,
		stopReason: m.stopReason,
		dispatchId: m.dispatchId,
	}));
};

const report = (
	call: Call,
	body: unknown,
	token = call.env.HISHAKU_REPORT_TOKEN,
) =>
	fetch(call.env.HISHAKU_REPORT_URL ?? "", {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
		},
		body: JSON.stringify(body),
	});

describe("createTurnEngine", () => {
	it("worktree を作って hs turn を番号なしで走らせ、ターンの終わりを worker_done で届ける", async () => {
		const { dir, engine, calls } = await setup();
		const r = await engine.startSeat({
			name: "seat-1",
			title: "t",
			spec: "頼みごと",
			agent: "claude",
			model: "opus",
		});
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const path = join(dir, "seats", "seat-1");
		expect(r.value.path).toBe(path);
		expect(existsSync(join(path, ".git"))).toBe(true);
		const [call] = calls;
		expect(call?.args).toEqual([
			"turn",
			"--agent",
			"claude",
			"--cwd",
			path,
			"--prompt-file",
			expect.any(String),
			"--",
			"--permission-mode",
			"auto",
			"--model",
			"opus",
		]);
		expect(call?.prompt).toBe("頼みごと");
		expect(call?.env.MIZUYA_STATE_DIR).toBe("/state");
		expect(call?.env.HISHAKU_URL).toBeUndefined();
		expect(call?.env.HISHAKU_REPORT_URL).toMatch(
			/^http:\/\/127\.0\.0\.1:\d+\/seats\/turn%3Aseat-1$/,
		);
		expect(
			(await engine.liveTerminals()).ok && [
				...((await engine.liveTerminals()) as { value: Set<string> }).value,
			],
		).toEqual(["turn:seat-1"]);

		call?.end({
			text: "できました\n状態: 完了",
			session_id: "s1",
			failed: false,
		});
		expect(await messages(engine)).toEqual([
			{
				type: "worker_done",
				body: "できました\n状態: 完了",
				outcome: "succeeded",
				stopReason: null,
				dispatchId: r.value.dispatchId,
			},
		]);

		// 番号なしの席は、拾ったセッションで続ける
		await engine.send({
			dispatchId: r.value.dispatchId,
			subject: "持ち主の返事",
			body: "続き",
		});
		expect(calls[1]?.args.slice(0, 5)).toEqual([
			"turn",
			"--agent",
			"claude",
			"--session",
			"s1",
		]);
		expect(calls[1]?.args[5]).toBe("--resume");
		expect(calls[1]?.prompt).toBe("## 持ち主の返事\n\n続き");
	});

	it("借りた番号の会話は番号で走らせ、hishaku の環境を足す", async () => {
		const { engine, calls } = await setup();
		const r = await engine.startSeat({
			name: "seat-2",
			title: "t",
			spec: "s",
			agent: "codex",
			model: null,
			prepare: async () =>
				ok({
					how: { sessionId: "", resume: false },
					lease: { number: 4821, generation: 3 },
				}),
		});
		expect(r.ok).toBe(true);
		expect(calls[0]?.args.slice(0, 4)).toEqual([
			"turn",
			"4821",
			"--generation",
			"3",
		]);
		expect(calls[0]?.args).toContain("danger-full-access");
		expect(calls[0]?.env.HISHAKU_URL).toBe("https://hishaku.example.com");
		expect(calls[0]?.env.XDG_CACHE_HOME).toBe("/cache");
	});

	it("他の機械が借りていれば起こさず、作った worktree を消す", async () => {
		const { dir, engine, calls } = await setup();
		const r = await engine.startSeat({
			name: "seat-3",
			title: "t",
			spec: "s",
			agent: "claude",
			prepare: async () => err({ holder: "mac-a" }),
		});
		expect(!r.ok && r.error).toEqual({
			type: "SeatLeaseHeld",
			command: "hs prepare",
			reason: "mac-a",
		});
		expect(calls).toHaveLength(0);
		expect(existsSync(join(dir, "seats", "seat-3"))).toBe(false);
	});

	it("作業中に届いた言葉はターンの終わりに渡し、そのターンの返事は途中経過にする", async () => {
		const { engine, calls } = await setup();
		const r = await engine.startSeat({
			name: "seat-4",
			title: "t",
			spec: "s",
			agent: "claude",
		});
		if (!r.ok) throw new Error();
		const sent = await engine.send({
			dispatchId: r.value.dispatchId,
			subject: "持ち主の返事",
			body: "追加",
		});
		expect(sent.ok && sent.value.dispatchId).toBe(r.value.dispatchId);
		expect(calls).toHaveLength(1);
		calls[0]?.end({ text: "途中です\n状態: 完了" });
		expect(await messages(engine)).toEqual([
			{
				type: "status",
				body: "途中です\n状態: 完了",
				outcome: null,
				stopReason: null,
				dispatchId: r.value.dispatchId,
			},
		]);
		expect(calls[1]?.prompt).toBe("## 持ち主の返事\n\n追加");
	});

	it("hs ask は question で届け、そのターンの終わりは返事にせず、答えで次のターンを走らせる", async () => {
		const { engine, calls } = await setup();
		const r = await engine.startSeat({
			name: "seat-5",
			title: "t",
			spec: "s",
			agent: "claude",
		});
		if (!r.ok) throw new Error();
		const call = calls[0] as Call;
		expect(
			(await report(call, { type: "ask", body: "push してよい？" }, "wrong"))
				.status,
		).toBe(401);
		const res = await report(call, { type: "ask", body: "push してよい？" });
		expect(res.status).toBe(202);
		const { id } = (await res.json()) as { id: string };
		const asked = await engine.waitMessages(1);
		expect(asked.ok && asked.value.map((m) => [m.type, m.id, m.body])).toEqual([
			["question", id, "push してよい？"],
		]);

		call.end({ text: "聞きました" });
		expect(await messages(engine)).toEqual([
			{
				type: "escalation",
				body: "",
				outcome: null,
				stopReason: "asked",
				dispatchId: r.value.dispatchId,
			},
		]);
		expect((await engine.reply({ messageId: id, body: "よい" })).ok).toBe(true);
		expect(calls[1]?.prompt).toBe("## 質問への答え\n\nよい");
	});

	it("hs status は status で届ける", async () => {
		const { engine, calls } = await setup();
		await engine.startSeat({
			name: "seat-6",
			title: "t",
			spec: "s",
			agent: "claude",
		});
		expect(
			(await report(calls[0] as Call, { type: "status", body: "描画中" }))
				.status,
		).toBe(202);
		const r = await engine.waitMessages(1);
		expect(r.ok && r.value.map((m) => [m.type, m.body, m.from])).toEqual([
			["status", "描画中", "turn:seat-6"],
		]);
	});

	it("返事の無いターンは escalation、失敗したターンは failed の worker_done", async () => {
		const { engine, calls } = await setup();
		const r = await engine.startSeat({
			name: "seat-7",
			title: "t",
			spec: "s",
			agent: "claude",
		});
		if (!r.ok) throw new Error();
		calls[0]?.end({ text: "" });
		expect((await messages(engine))[0]?.stopReason).toBe("no_reply");
		await engine.send({
			dispatchId: r.value.dispatchId,
			subject: "x",
			body: "y",
		});
		calls[1]?.end({ text: "", failed: true, reason: "error_max_turns" }, 4);
		expect(await messages(engine)).toEqual([
			{
				type: "worker_done",
				body: "席の agent が止まりました（error_max_turns）",
				outcome: "failed",
				stopReason: null,
				dispatchId: r.value.dispatchId,
			},
		]);
		await engine.send({
			dispatchId: r.value.dispatchId,
			subject: "x",
			body: "y",
		});
		calls[2]?.end("not a result", 1);
		expect((await messages(engine))[0]?.stopReason).toBe("turn_failed");
	});

	it("止めた席は SIGTERM で止め、何も届けず、送れなくなる", async () => {
		const { engine, calls } = await setup();
		const r = await engine.startSeat({
			name: "seat-8",
			title: "t",
			spec: "s",
			agent: "claude",
		});
		if (!r.ok) throw new Error();
		expect(
			(
				await engine.stopSeat({
					dispatchId: r.value.dispatchId,
					terminal: null,
				})
			).ok,
		).toBe(true);
		expect(calls[0]?.signals).toEqual(["SIGTERM"]);
		expect(await messages(engine)).toEqual([]);
		const live = await engine.liveTerminals();
		expect(live.ok && live.value.size).toBe(0);
		expect(
			(
				await engine.send({
					dispatchId: r.value.dispatchId,
					subject: "x",
					body: "y",
				})
			).ok,
		).toBe(false);
	});

	it("止めた席を前の会話のまま起こし、消えた worktree は知らせる", async () => {
		const { dir, engine, calls } = await setup();
		const r = await engine.startSeat({
			name: "seat-9",
			title: "t",
			spec: "s",
			agent: "codex",
		});
		if (!r.ok) throw new Error();
		await engine.stopSeat({ dispatchId: null, terminal: r.value.terminal });
		const resumed = await engine.resumeSeat({
			path: r.value.path,
			title: "t",
			spec: "続き",
			agent: "codex",
		});
		expect(resumed.ok).toBe(true);
		expect(calls[1]?.args.slice(0, 4)).toEqual([
			"turn",
			"--agent",
			"codex",
			"--continue",
		]);
		const missing = await engine.resumeSeat({
			path: join(dir, "seats", "none"),
			title: "t",
			spec: "s",
			agent: "codex",
		});
		expect(!missing.ok && missing.error.type).toBe("SeatWorktreeMissing");
	});

	it("worktree を消すと residue から外れる", async () => {
		const { engine } = await setup();
		const r = await engine.startSeat({
			name: "seat-10",
			title: "t",
			spec: "s",
			agent: "claude",
		});
		if (!r.ok) throw new Error();
		await engine.stopSeat({ dispatchId: r.value.dispatchId, terminal: null });
		expect(
			(await engine.residue()).ok &&
				((await engine.residue()) as { value: { worktrees: string[] } }).value
					.worktrees,
		).toEqual([r.value.path]);
		expect((await engine.removeWorktree(r.value.path)).ok).toBe(true);
		expect(
			(await engine.residue()).ok &&
				((await engine.residue()) as { value: { worktrees: string[] } }).value
					.worktrees,
		).toEqual([]);
	});
});

describe("seatEnv", () => {
	it("受付の秘密を渡さず、席の場所と mise の shims を足す", () => {
		const env = seatEnv(
			{
				HOME: "/home/w",
				PATH: "/usr/bin",
				GH_TOKEN: "gh",
				DISCORD_TOKEN: "secret",
				HISHAKU_ACCESS_CLIENT_SECRET: "secret",
			},
			{ stateDir: "/state", seatsDir: "/seats" },
		);
		expect(env).toEqual({
			HOME: "/home/w",
			GH_TOKEN: "gh",
			PATH: "/home/w/.local/share/mise/shims:/usr/bin",
			MIZUYA_STATE_DIR: "/state",
			MIZUYA_SEATS_DIR: "/seats",
		});
	});
});
