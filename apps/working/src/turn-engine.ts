import { spawn } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { basename, join } from "node:path";
import * as v from "valibot";
import type { Exec } from "./exec.ts";
import { err, ok, type Result } from "./lib/core.ts";
import type { Logger } from "./logger.ts";
import type {
	Orca,
	OrcaError,
	SeatAgent,
	SeatHandle,
	SeatHow,
	SeatMessage,
	SeatPrepare,
} from "./orca.ts";

/** 走らせている hs turn。テストでは偽物に差し替える。 */
export type TurnProcess = {
	done: Promise<{ code: number | null; stdout: string; stderr: string }>;
	kill: (signal: NodeJS.Signals) => void;
};

export type SpawnTurn = (
	bin: string,
	args: readonly string[],
	opts: { cwd: string; env: Record<string, string> },
) => TurnProcess;

export const spawnTurn: SpawnTurn = (bin, args, opts) => {
	const child = spawn(bin, args, {
		cwd: opts.cwd,
		env: opts.env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (d) => {
		stdout += d;
	});
	child.stderr.on("data", (d) => {
		stderr += d;
	});
	const done = new Promise<{
		code: number | null;
		stdout: string;
		stderr: string;
	}>((resolve) => {
		child.on("error", (e) =>
			resolve({ code: null, stdout, stderr: `${stderr}${String(e)}` }),
		);
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
	return { done, kill: (signal) => child.kill(signal) };
};

/**
 * 席の agent に渡してよい環境変数。受付の秘密（Discord のトークン、記憶の口と chimera の service token）は渡さない。
 * MIZUYA_* は hook（src/guard）が席と許可の記録を探すのに使う。
 */
const SEAT_ENV_KEYS = [
	"HOME",
	"LANG",
	"LC_ALL",
	"TZ",
	"USER",
	"CLAUDE_CONFIG_DIR",
	"CODEX_HOME",
	"XDG_CONFIG_HOME",
	"GH_TOKEN",
	"GIT_AUTHOR_NAME",
	"GIT_AUTHOR_EMAIL",
	"GIT_COMMITTER_NAME",
	"GIT_COMMITTER_EMAIL",
	"MISE_DATA_DIR",
	"MISE_CACHE_DIR",
	"MISE_STATE_DIR",
	"MISE_TRUSTED_CONFIG_PATHS",
	"UV_CACHE_DIR",
	"UV_PYTHON_INSTALL_DIR",
	"npm_config_store_dir",
] as const;

export const seatEnv = (
	env: Record<string, string | undefined>,
	dirs: { stateDir: string; seatsDir: string },
): Record<string, string> => {
	const out: Record<string, string> = {};
	for (const key of SEAT_ENV_KEYS) {
		const val = env[key];
		if (val !== undefined && val !== "") out[key] = val;
	}
	// shims は席の中だけで通す。受付の node が mise の node に替わらないように
	const home = env.HOME ?? "";
	out.PATH = `${env.MISE_DATA_DIR ?? `${home}/.local/share/mise`}/shims:${env.PATH ?? ""}`;
	out.MIZUYA_STATE_DIR = dirs.stateDir;
	out.MIZUYA_SEATS_DIR = dirs.seatsDir;
	return out;
};

export type TurnEngineOptions = {
	hsBin: string;
	exec: Exec;
	/** 席の agent に渡す環境（seatEnv）。 */
	seatEnv: Record<string, string>;
	/** 番号の会話を走らせるときに hs に足す環境（HISHAKU_* と、prepare と同じ XDG_CACHE_HOME）。 */
	hishakuEnv: Record<string, string>;
	/** 席の worktree の元にする git リポジトリ。 */
	seatsRepo: string;
	/** 席の worktree を作る場所。 */
	seatsDir: string;
	/** ターンの指示を一時的に置く場所。 */
	specDir: string;
	/** 席の作業場所を Claude CLI の信頼済みにし、登録した realpath を返す。 */
	trust: (dir: string) => Promise<Result<string, { reason: string }>>;
	logger: Logger;
	spawn?: SpawnTurn;
	/** 止めるときに SIGTERM から SIGKILL に切り替えるまでの時間。 */
	stopTimeoutMs?: number;
};

const turnSchema = v.object({
	text: v.optional(v.string(), ""),
	session_id: v.optional(v.string(), ""),
	failed: v.optional(v.boolean(), false),
	reason: v.optional(v.string()),
	push_error: v.optional(v.string()),
	stolen: v.optional(v.boolean(), false),
});

const reportSchema = v.object({
	type: v.picklist(["ask", "status"]),
	subject: v.optional(v.string()),
	body: v.string(),
});

type Run = {
	terminal: string;
	/** 受付が覚える worktree の場所。 */
	path: string;
	/** agent を起こす場所（realpath）。 */
	cwd: string;
	agent: SeatAgent;
	model: string | null;
	/** 借りている番号の会話。null なら Manager を使わずに走らせる。 */
	lease: { number: number; generation: number } | null;
	how: SeatHow;
	token: string;
	dispatchId: string;
	proc: TurnProcess | null;
	/** ターンの間に届いた言葉。ターンが終わったらまとめて次のターンに渡す。 */
	queue: string[];
	/** このターンで質問した。ターンの終わりは返事ではない。 */
	asked: boolean;
	stopped: boolean;
};

const TERMINAL_PREFIX = "turn:";
const STOP_TIMEOUT_MS = 60_000;
const SEAT_CLAUDE_FLAGS = ["--permission-mode", "auto"];
/**
 * 承認なし・sandbox なしで動かす（持ち主の方針）。コンテナが外側の囲いで、秘密の読み出しは managed hook（src/guard）が止める。
 * 記憶の道具が Akarin の記憶を読み書きするよう、Codex が動かすコマンドにだけ YUNOMI_PARTNER を渡す。
 */
const SEAT_CODEX_FLAGS = [
	"-s",
	"danger-full-access",
	"-c",
	"check_for_update_on_startup=false",
	"-c",
	"shell_environment_policy.set.YUNOMI_PARTNER=akarin",
];

const agentArgs = (agent: SeatAgent, model: string | null) =>
	agent === "claude"
		? [...SEAT_CLAUDE_FLAGS, ...(model ? ["--model", model] : [])]
		: // Codex は Claude の opus のような短い名前を解決しない
			[...SEAT_CODEX_FLAGS, ...(model ? ["-m", `gpt-5.6-${model}`] : [])];

const localHowArgs = (how: SeatHow): string[] => {
	if (how === "start") return [];
	if (how === "resume") return ["--continue"];
	if (how.sessionId === "") return how.resume ? ["--continue"] : [];
	return ["--session", how.sessionId, ...(how.resume ? ["--resume"] : [])];
};

const lastJson = (stdout: string): unknown => {
	const lines = stdout.trim().split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		try {
			return JSON.parse(lines[i] ?? "");
		} catch {}
	}
	return null;
};

const sameToken = (a: string, b: string) => {
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
};

const failed = (command: string, reason: string): OrcaError => ({
	type: "OrcaFailed",
	command,
	reason,
});

/**
 * Orca の代わりに hs turn で席を回す。席は worktree と、指示が届くたびに走らせる hs turn のターンで表す。
 * 受付から見た口は Orca と同じで、ターンの終わりを worker_done、hs ask と hs status をそれぞれ question と status として届ける。
 * 席の状態はこのプロセスの中だけにあるので、受付が作り直されると生きている席は無くなり、reconcile が止めた席にする。
 */
export const createTurnEngine = (
	opts: TurnEngineOptions,
): Orca & { reportUrl: () => string | null; close: () => Promise<void> } => {
	const log = opts.logger;
	const spawnFn = opts.spawn ?? spawnTurn;
	const stopTimeoutMs = opts.stopTimeoutMs ?? STOP_TIMEOUT_MS;
	const runs = new Map<string, Run>();
	const asks = new Map<string, string>();
	const inbox: SeatMessage[] = [];
	let wake: (() => void) | null = null;
	let base: string | null = null;
	const server = createServer((req, res) => {
		void onReport(req, res);
	});

	const emit = (
		msg: Omit<SeatMessage, "outcome" | "stopReason"> & Partial<SeatMessage>,
	) => {
		inbox.push({ outcome: null, stopReason: null, ...msg });
		wake?.();
	};

	const git = async (args: readonly string[]) => {
		const r = await opts.exec("git", ["-C", opts.seatsRepo, ...args], {
			stdin: "",
			cwd: opts.seatsRepo,
			timeoutMs: 60_000,
			env: { ...opts.seatEnv, GIT_TERMINAL_PROMPT: "0" },
		});
		return r.code === 0
			? ok(r.stdout)
			: err(
					failed(`git ${args.join(" ")}`, r.stderr.trim() || `exit ${r.code}`),
				);
	};

	const exists = (path: string) =>
		stat(path).then(
			() => true,
			() => false,
		);

	const removeWorktree = async (
		path: string,
	): Promise<Result<void, OrcaError>> => {
		const removed = await git(["worktree", "remove", "--force", path]);
		if (!removed.ok) {
			// worktree の記録が壊れていても場所は消す
			try {
				await rm(path, { recursive: true, force: true });
			} catch (e) {
				return err(failed("rm", String(e)));
			}
			await git(["worktree", "prune"]);
		}
		await git(["branch", "-D", basename(path)]);
		return ok(undefined);
	};

	const writePrompt = async (text: string) => {
		await mkdir(opts.specDir, { recursive: true, mode: 0o700 });
		const file = join(opts.specDir, `${randomUUID()}.md`);
		await writeFile(file, text, { mode: 0o600 });
		return file;
	};

	const startTurn = async (run: Run, prompt: string) => {
		const file = await writePrompt(prompt);
		const common = [
			"--cwd",
			run.cwd,
			"--prompt-file",
			file,
			"--",
			...agentArgs(run.agent, run.model),
		];
		// 番号の会話は meta が決めるので、前の会話が正本に無い席（"resume" など）だけ手元の会話で走らせる
		const byNumber = run.lease !== null && typeof run.how === "object";
		const args =
			byNumber && run.lease
				? [
						"turn",
						String(run.lease.number),
						"--generation",
						String(run.lease.generation),
						...common,
					]
				: ["turn", "--agent", run.agent, ...localHowArgs(run.how), ...common];
		const env = {
			...opts.seatEnv,
			...(byNumber ? opts.hishakuEnv : {}),
			HISHAKU_REPORT_URL: `${base ?? ""}/seats/${encodeURIComponent(run.terminal)}`,
			HISHAKU_REPORT_TOKEN: run.token,
		};
		const proc = spawnFn(opts.hsBin, args, { cwd: run.cwd, env });
		run.proc = proc;
		log.info("seat turn started", {
			terminal: run.terminal,
			dispatch_id: run.dispatchId,
			by_number: byNumber,
		});
		void proc.done.then(async (res) => {
			await rm(file, { force: true });
			if (run.proc !== proc) return;
			run.proc = null;
			if (run.stopped) return;
			finish(run, res);
		});
	};

	const finish = (
		run: Run,
		res: { code: number | null; stdout: string; stderr: string },
	) => {
		const parsed = v.safeParse(turnSchema, lastJson(res.stdout));
		const asked = run.asked;
		run.asked = false;
		const queued = run.queue.splice(0);
		const head = {
			id: randomUUID(),
			from: run.terminal,
			subject: "",
			dispatchId: run.dispatchId,
		};
		if (!parsed.success) {
			log.error("seat turn failed", {
				terminal: run.terminal,
				code: res.code,
				stderr: res.stderr.trim().slice(-1000),
			});
			emit({
				...head,
				type: "escalation",
				body: "",
				stopReason: "turn_failed",
			});
		} else {
			const t = parsed.output;
			if (run.lease === null || typeof run.how !== "object") {
				if (t.session_id !== "")
					run.how = { sessionId: t.session_id, resume: true };
			}
			if (t.push_error) {
				log.warn("seat turn push failed", {
					terminal: run.terminal,
					reason: t.push_error,
				});
			}
			const text = t.text.trim();
			if (asked) {
				// 質問した後のターンの終わり。受付は質問の時点で答えを待っている
				emit({ ...head, type: "escalation", body: "", stopReason: "asked" });
			} else if (queued.length > 0 && !t.failed) {
				// 続きをすぐ渡すので、このターンの返事は途中経過として書く
				if (text !== "") emit({ ...head, type: "status", body: t.text });
			} else if (t.failed) {
				emit({
					...head,
					type: "worker_done",
					body:
						text !== ""
							? t.text
							: `席の agent が止まりました（${t.reason ?? "理由不明"}）`,
					outcome: "failed",
				});
			} else if (text === "") {
				emit({ ...head, type: "escalation", body: "", stopReason: "no_reply" });
			} else {
				emit({
					...head,
					type: "worker_done",
					body: t.text,
					outcome: "succeeded",
				});
			}
		}
		if (queued.length > 0) void startTurn(run, queued.join("\n\n---\n\n"));
	};

	const deliver = async (run: Run, text: string) => {
		if (run.proc) {
			run.queue.push(text);
			return;
		}
		await startTurn(run, text);
	};

	const stop = async (run: Run) => {
		run.stopped = true;
		runs.delete(run.terminal);
		for (const [id, terminal] of asks)
			if (terminal === run.terminal) asks.delete(id);
		const proc = run.proc;
		if (!proc) return;
		// hs は agent を止めてから記録を預けるので、終わるのを待つ
		proc.kill("SIGTERM");
		const timer = new Promise<"timeout">((r) =>
			setTimeout(() => r("timeout"), stopTimeoutMs),
		);
		if ((await Promise.race([proc.done, timer])) === "timeout") {
			proc.kill("SIGKILL");
			await proc.done;
		}
		run.proc = null;
	};

	const launch = async (
		path: string,
		spec: string,
		agent: SeatAgent,
		input: { how: SeatHow; model: string | null; prepare?: SeatPrepare },
	): Promise<Result<SeatHandle, OrcaError>> => {
		let cwd = path;
		// Codex は worktree の元のリポジトリ（席の元）で信頼を引くので、受付が起動時に 1 度だけ登録する
		if (agent === "claude") {
			const trusted = await opts.trust(path);
			if (!trusted.ok) {
				return err({
					type: "SeatTrustFailed",
					command: "trust",
					reason: trusted.error.reason,
				});
			}
			cwd = trusted.value;
		}
		let how = input.how;
		let text = spec;
		let lease: Run["lease"] = null;
		if (input.prepare) {
			const prepared = await input.prepare(cwd);
			if (!prepared.ok) {
				return err({
					type: "SeatLeaseHeld",
					command: "hs prepare",
					reason: prepared.error.holder,
				});
			}
			how = prepared.value.how;
			text = prepared.value.spec ?? text;
			lease = prepared.value.lease ?? null;
		}
		const terminal = `${TERMINAL_PREFIX}${basename(path)}`;
		const prev = runs.get(terminal);
		if (prev) await stop(prev);
		const run: Run = {
			terminal,
			path,
			cwd,
			agent,
			model: input.model,
			lease,
			how,
			token: randomBytes(24).toString("hex"),
			dispatchId: randomUUID(),
			proc: null,
			queue: [],
			asked: false,
			stopped: false,
		};
		runs.set(terminal, run);
		await startTurn(run, text);
		return ok({ dispatchId: run.dispatchId, terminal, path });
	};

	const readBody = (req: IncomingMessage) =>
		new Promise<string>((resolve, reject) => {
			let body = "";
			req.on("data", (d) => {
				body += d;
				if (body.length > 1_000_000) req.destroy();
			});
			req.on("end", () => resolve(body));
			req.on("error", reject);
		});

	const reply = (res: ServerResponse, code: number, body: unknown) => {
		res.writeHead(code, { "content-type": "application/json" });
		res.end(JSON.stringify(body));
	};

	const onReport = async (req: IncomingMessage, res: ServerResponse) => {
		const match = /^\/seats\/([^/]+)$/.exec(req.url ?? "");
		if (req.method !== "POST" || !match?.[1])
			return reply(res, 404, { error: "not found" });
		const run = runs.get(decodeURIComponent(match[1]));
		const auth = req.headers.authorization ?? "";
		// 止めた席の古い token と、ほかの席の token は通さない
		if (!run || !sameToken(auth, `Bearer ${run.token}`)) {
			return reply(res, 401, { error: "unauthorized" });
		}
		let body: unknown;
		try {
			body = JSON.parse(await readBody(req));
		} catch {
			return reply(res, 400, { error: "invalid json" });
		}
		const r = v.safeParse(reportSchema, body);
		if (!r.success || r.output.body.trim() === "") {
			return reply(res, 400, { error: "invalid report" });
		}
		const id = randomUUID();
		const msg = {
			id,
			from: run.terminal,
			subject: r.output.subject ?? "",
			body: r.output.body,
			dispatchId: run.dispatchId,
		};
		if (r.output.type === "ask") {
			asks.set(id, run.terminal);
			run.asked = true;
			emit({ ...msg, type: "question" });
		} else {
			emit({ ...msg, type: "status" });
		}
		return reply(res, 202, { id });
	};

	return {
		reportUrl: () => base,
		close: async () => {
			await Promise.all([...runs.values()].map(stop));
			await new Promise<void>((r) => server.close(() => r()));
		},
		waitReady: async () => {
			if (base !== null) return ok(undefined);
			// 席の agent は同じコンテナで動くので、ループバックだけで待ち受ける
			const listened = await new Promise<Result<void, OrcaError>>((resolve) => {
				server.once("error", (e) => resolve(err(failed("listen", String(e)))));
				server.listen(0, "127.0.0.1", () => resolve(ok(undefined)));
			});
			if (!listened.ok) return listened;
			const { port } = server.address() as AddressInfo;
			base = `http://127.0.0.1:${port}`;
			return ok(undefined);
		},
		prepare: async (prev) =>
			ok({ runId: prev.runId ?? "turn", reception: "turn" }),
		startSeat: async ({ name, spec, agent, model = null, prepare }) => {
			const path = join(opts.seatsDir, name);
			// 前に閉じそこねた同じ名前の worktree があると作れない
			if (await exists(path)) await removeWorktree(path);
			await mkdir(opts.seatsDir, { recursive: true });
			const created = await git(["worktree", "add", "-B", name, path]);
			if (!created.ok) return created;
			const launched = await launch(path, spec, agent, {
				how: "start",
				model,
				prepare,
			});
			// 起こせなかった新しい席の worktree は、次に同じ名前で作るときの邪魔になる
			if (!launched.ok && launched.error.type === "SeatLeaseHeld") {
				await removeWorktree(path);
			}
			return launched;
		},
		resumeSeat: async ({ path, spec, agent, model = null, prepare }) => {
			if (!(await exists(path))) {
				return err({
					type: "SeatWorktreeMissing",
					command: "resume",
					reason: path,
				});
			}
			return launch(path, spec, agent, { how: "resume", model, prepare });
		},
		switchModel: async ({ terminal, model }) => {
			const run = runs.get(terminal);
			if (!run) return err(failed("switchModel", `no seat: ${terminal}`));
			// 次のターンから効く
			run.model = model;
			return ok(undefined);
		},
		send: async ({ dispatchId, subject, body }) => {
			const run = [...runs.values()].find((r) => r.dispatchId === dispatchId);
			if (!run)
				return err(failed("send", `no seat for dispatch ${dispatchId}`));
			await deliver(run, `## ${subject}\n\n${body}`);
			return ok({ dispatchId: run.dispatchId, terminal: run.terminal });
		},
		reply: async ({ messageId, body }) => {
			const terminal = asks.get(messageId);
			const run = terminal === undefined ? undefined : runs.get(terminal);
			if (!run) return err(failed("reply", `no question ${messageId}`));
			asks.delete(messageId);
			await deliver(run, `## 質問への答え\n\n${body}`);
			return ok(undefined);
		},
		stopSeat: async ({ dispatchId, terminal }) => {
			const run =
				(terminal ? runs.get(terminal) : undefined) ??
				[...runs.values()].find(
					(r) => dispatchId !== null && r.dispatchId === dispatchId,
				);
			if (run) await stop(run);
			return ok(undefined);
		},
		removeWorktree,
		closeTerminal: async (handle) => {
			const run = runs.get(handle);
			if (run) await stop(run);
			return ok(undefined);
		},
		liveTerminals: async () => ok(new Set(runs.keys())),
		residue: async () => {
			try {
				const entries = await readdir(opts.seatsDir, { withFileTypes: true });
				return ok({
					worktrees: entries
						.filter((e) => e.isDirectory())
						.map((e) => join(opts.seatsDir, e.name)),
					terminals: [],
				});
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code === "ENOENT") {
					return ok({ worktrees: [], terminals: [] });
				}
				return err(failed("residue", String(e)));
			}
		},
		waitMessages: async (timeoutMs) => {
			if (inbox.length === 0) {
				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, timeoutMs);
					wake = () => {
						clearTimeout(timer);
						resolve();
					};
				});
				wake = null;
			}
			return ok(inbox.splice(0));
		},
	};
};
