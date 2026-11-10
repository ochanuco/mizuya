import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as v from "valibot";
import type { Exec } from "./exec.ts";
import { err, ok, type Result } from "./lib/core.ts";
import type { Logger } from "./logger.ts";

export type OrcaError =
	| { type: "OrcaFailed"; command: string; reason: string }
	/** 席の作業場所を Claude CLI の信頼済みにできなかった。 */
	| { type: "SeatTrustFailed"; command: string; reason: string }
	/** 止めた席の worktree が無くなっていて、前の会話のまま起こせない。 */
	| { type: "SeatWorktreeMissing"; command: string; reason: string }
	/** 席のセッションを他の機械が借りていて起こせない。reason は持ち主。 */
	| { type: "SeatLeaseHeld"; command: string; reason: string };

/** 席から受付に届くメッセージ。 */
export type SeatMessage = {
	id: string;
	type: string;
	/** 送り手。Dispatch を付けずに送られた status などは、席の端末の handle で引き当てる。 */
	from: string;
	subject: string;
	body: string;
	dispatchId: string | null;
	outcome: "succeeded" | "failed" | null;
	/** 席の Claude が worker_done を送らずにターンを終えたときの escalation に付く。 */
	stopReason: string | null;
};

/** 席で動かす CLI agent。Yukarin は Claude CLI、Akarin は Codex CLI。 */
export type SeatAgent = "claude" | "codex";

/**
 * 席の agent の起こし方。
 * - start: 新規（Codex は ID を外から渡せないので、セッションを預けるときもこれ）
 * - resume: 作業ディレクトリの最新の会話を続ける
 * - session: session_id を決めて起こす。resume なら前の会話を続け、そうでなければその ID で新規に始める
 */
export type SeatHow =
	| "start"
	| "resume"
	| { sessionId: string; resume: boolean };

/**
 * worktree ができてから agent を起こす前に呼ぶ。cwd は agent が動く作業場所（realpath）。
 * 起こし方と、変えるなら spec を返す。席を起こしてはいけないとき（他の機械が借りている）は持ち主を返す。
 * lease は借りた hishaku の番号と世代。hs turn で走らせる席は、これで番号の会話を続けて預ける。
 */
export type SeatPrepare = (cwd: string) => Promise<
	Result<
		{
			how: SeatHow;
			spec?: string;
			lease?: { number: number; generation: number };
		},
		{ holder: string }
	>
>;

/** 席の Claude の居場所。Orca は席を 1 つの Dispatch とその端末で表す。 */
export type SeatHandle = { dispatchId: string; terminal: string; path: string };

export type SeatResidue = {
	worktrees: string[];
	terminals: { handle: string; path: string }[];
};

/** 受付と席のやりとりに使う Orca の操作。受付はこの口だけで Orca に触る。 */
export type Orca = {
	/**
	 * 同じコンテナの orca serve が受け付けられるようになるまで待つ。
	 * serve は受付と同時に起動し、ready になる前の CLI は runtime_unavailable で即座に失敗する。
	 */
	waitReady: (timeoutMs: number) => Promise<Result<void, OrcaError>>;
	/** 受付の端末を作り直し、Run を引き継ぐ（無ければ作る）。 */
	prepare: (prev: {
		runId: string | null;
		reception: string | null;
	}) => Promise<Result<{ runId: string; reception: string }, OrcaError>>;
	/** 新しい worktree に席を作り、Claude に spec を渡す。 */
	startSeat: (input: {
		name: string;
		title: string;
		spec: string;
		agent: SeatAgent;
		/** 席で動かすモデル。null なら CLI の既定のモデル。 */
		model?: string | null;
		prepare?: SeatPrepare;
	}) => Promise<Result<SeatHandle, OrcaError>>;
	/** 止めた席の Claude を前の会話のまま起こし、spec を渡す。 */
	resumeSeat: (input: {
		path: string;
		title: string;
		spec: string;
		agent: SeatAgent;
		model?: string | null;
		prepare?: SeatPrepare;
	}) => Promise<Result<SeatHandle, OrcaError>>;
	/** 手を止めている Claude の席のモデルを、会話を保ったまま切り替える。 */
	switchModel: (input: {
		terminal: string;
		model: string;
	}) => Promise<Result<void, OrcaError>>;
	/** 席に続きを渡す。作業中ならターンの終わりに、終わった席なら続きの Dispatch として届く。 */
	send: (input: {
		dispatchId: string;
		subject: string;
		body: string;
	}) => Promise<
		Result<{ dispatchId: string; terminal: string | null }, OrcaError>
	>;
	reply: (input: {
		messageId: string;
		body: string;
	}) => Promise<Result<void, OrcaError>>;
	/** 席の Claude を止める。worktree は残す。 */
	stopSeat: (seat: {
		dispatchId: string | null;
		terminal: string | null;
	}) => Promise<Result<void, OrcaError>>;
	removeWorktree: (path: string) => Promise<Result<void, OrcaError>>;
	closeTerminal: (handle: string) => Promise<Result<void, OrcaError>>;
	liveTerminals: () => Promise<Result<Set<string>, OrcaError>>;
	/** 席の置き場所にある worktree と、その中の端末。 */
	residue: () => Promise<Result<SeatResidue, OrcaError>>;
	/** 届いたメッセージを待って受け取る。届かないまま timeoutMs たてば空で返す。 */
	waitMessages: (
		timeoutMs: number,
	) => Promise<Result<SeatMessage[], OrcaError>>;
};

const envelope = v.object({
	ok: v.boolean(),
	result: v.optional(v.unknown()),
	error: v.optional(
		v.object({ code: v.optional(v.string()), message: v.optional(v.string()) }),
	),
});

const runSchema = v.object({ runId: v.string() });
const worktreeSchema = v.object({ worktree: v.object({ path: v.string() }) });
const statusSchema = v.object({
	runtime: v.optional(v.object({ state: v.optional(v.string()) })),
});
const terminalSchema = v.object({
	terminal: v.object({ handle: v.string() }),
});
const startSchema = v.object({
	dispatchId: v.string(),
	terminal: v.string(),
	workspace: v.string(),
});
const sendSchema = v.object({
	dispatchId: v.optional(v.string()),
	terminal: v.optional(v.string()),
});
const reposSchema = v.object({
	repos: v.array(v.object({ id: v.string(), path: v.string() })),
});
const worktreesSchema = v.object({
	worktrees: v.array(v.object({ path: v.string() })),
});
const terminalsSchema = v.object({
	terminals: v.array(
		v.object({
			handle: v.string(),
			worktreePath: v.optional(v.string()),
			title: v.optional(v.nullish(v.string())),
		}),
	),
});
const messagesSchema = v.object({
	messages: v.optional(
		v.array(
			v.object({
				id: v.string(),
				type: v.string(),
				from: v.optional(v.nullish(v.string())),
				subject: v.optional(v.nullish(v.string())),
				body: v.optional(v.nullish(v.string())),
				payload: v.optional(
					v.nullish(
						v.object({
							dispatchId: v.optional(v.string()),
							outcome: v.optional(v.string()),
							stopReason: v.optional(v.string()),
						}),
					),
				),
			}),
		),
	),
});

/** worker-start の workspace は `<repoId>::<path>`。 */
const pathOfWorkspace = (workspace: string) =>
	workspace.includes("::")
		? workspace.slice(workspace.indexOf("::") + 2)
		: workspace;

const isUnder = (path: string, dir: string) =>
	path === dir || path.startsWith(`${dir.replace(/\/$/, "")}/`);

const parseJson = (stdout: string): unknown => {
	const start = stdout.indexOf("{");
	const end = stdout.lastIndexOf("}");
	if (start === -1 || end < start) return null;
	try {
		return JSON.parse(stdout.slice(start, end + 1));
	} catch {
		return null;
	}
};

export type OrcaCliOptions = {
	bin: string;
	exec: Exec;
	env: Record<string, string>;
	/**
	 * orca-ide を動かす作業ディレクトリ。受付の起動時からあるディレクトリにする。
	 * 席の元のリポジトリは prepare で作るので、空の volume ではそれより前に cwd にできない。
	 */
	cwd: string;
	/** 席の worktree の元にする空の git リポジトリ。 */
	seatsRepo: string;
	/** Orca が席の worktree を作る場所（realpath）。 */
	seatsDir: string;
	/** spec を一時的に置く場所。 */
	specDir: string;
	/** 席の作業場所を Claude CLI の信頼済みにし、登録した realpath を返す。 */
	trust: (dir: string) => Promise<Result<string, { reason: string }>>;
	logger: Logger;
	timeoutMs?: number;
	sleep?: (ms: number) => Promise<void>;
};

const RECEPTION_TITLE = "受付";
const START_TIMEOUT_MS = 180_000;
/** 席の Claude の起動。持ち主が手元で使うのと同じ auto モードにする。 */
const SEAT_CLAUDE = "claude --permission-mode auto";
/**
 * 席の Codex の起動。持ち主の方針（都度許可を求めない、手元と同じものが見える）に合わせ、承認なし・sandbox なしで動かす。
 * コンテナが外側の囲いで、秘密の読み出しは /etc/codex/requirements.toml の managed hook（src/guard）が止める。
 * 記憶の道具が Akarin の記憶を読み書きするよう、Codex が動かすコマンドにだけ YUNOMI_PARTNER を渡す。
 * 先頭を codex のままにするのは、Orca が端末のコマンドから agent を見分けるため。
 */
const SEAT_CODEX_FLAGS =
	"-a never -s danger-full-access -c check_for_update_on_startup=false -c shell_environment_policy.set.YUNOMI_PARTNER=akarin";
/**
 * 起動と、止めた席を前の会話のまま起こすコマンド。Codex の resume --last は作業ディレクトリ（席の worktree）の最新の会話を選ぶ。
 * 再開にも同じモデルを渡さないと、CLI の既定のモデルに戻る。
 * hishaku に預けたセッションも先頭は agent のままにする。hs resume を先頭にすると、Orca は終わった席に続きを渡せなくなる。
 */
export const seatCommand = (
	agent: SeatAgent,
	how: SeatHow,
	model: string | null,
): string => {
	const session = typeof how === "object" && how.sessionId !== "" ? how : null;
	if (agent === "claude") {
		const withModel = model ? `${SEAT_CLAUDE} --model ${model}` : SEAT_CLAUDE;
		if (session) {
			return session.resume
				? `${withModel} -r ${session.sessionId}`
				: `${withModel} --session-id ${session.sessionId}`;
		}
		return how === "resume" ? `${withModel} --continue` : withModel;
	}
	const head = session?.resume
		? `codex resume ${session.sessionId}`
		: how === "resume"
			? "codex resume --last"
			: "codex";
	// Codex は Claude の opus のような短い名前を解決せず、ChatGPT のアカウントでは model_not_found で起動前に落ちる
	return model
		? `${head} -m gpt-5.6-${model} ${SEAT_CODEX_FLAGS}`
		: `${head} ${SEAT_CODEX_FLAGS}`;
};
/** 席の Claude を起動してから spec を渡すまで待つ時間。手元では 10 秒でコネクタが読み込まれていた。 */
const MCP_WARMUP_MS = 15_000;

export const createOrcaCli = (opts: OrcaCliOptions): Orca => {
	const log = opts.logger;
	let reception: string | null = null;
	let runId: string | null = null;
	let repoId: string | null = null;

	const call = async <T>(
		args: readonly string[],
		schema: v.GenericSchema<unknown, T>,
		timeoutMs = opts.timeoutMs ?? 60_000,
	): Promise<Result<T, OrcaError>> => {
		const command = args.slice(0, 2).join(" ");
		const out = await opts.exec(opts.bin, [...args, "--json"], {
			stdin: "",
			cwd: opts.cwd,
			timeoutMs,
			env: opts.env,
		});
		const env = v.safeParse(envelope, parseJson(out.stdout));
		if (!env.success) {
			return err({
				type: "OrcaFailed",
				command,
				reason: (out.stderr || out.stdout).slice(0, 300) || `exit ${out.code}`,
			});
		}
		if (!env.output.ok) {
			const reason =
				env.output.error?.message ??
				(out.stderr.trim().split("\n").at(-1) || `exit ${out.code}`);
			return err({ type: "OrcaFailed", command, reason: reason.slice(0, 300) });
		}
		const parsed = v.safeParse(schema, env.output.result);
		if (!parsed.success) {
			return err({ type: "OrcaFailed", command, reason: "unexpected result" });
		}
		return ok(parsed.output);
	};

	const ignore = v.unknown();
	const asCoordinator = () => ["--from", reception ?? "", "--run", runId ?? ""];

	/** 席の元のリポジトリを Orca に登録する。リポジトリは start.sh が serve より先に作っておく。 */
	const ensureSeatsRepo = async (): Promise<Result<string, OrcaError>> => {
		const hasGit = await stat(join(opts.seatsRepo, ".git")).then(
			() => true,
			() => false,
		);
		if (!hasGit) {
			return err({
				type: "OrcaFailed",
				command: "repo list",
				reason: `${opts.seatsRepo} に git リポジトリが無い（start.sh の init-seats-repo.sh が作る）`,
			});
		}
		const repos = await call(["repo", "list"], reposSchema);
		if (!repos.ok) return repos;
		const found = repos.value.repos.find((r) => r.path === opts.seatsRepo);
		if (found) return ok(found.id);
		const added = await call(
			["repo", "add", "--path", opts.seatsRepo],
			v.object({ repo: v.object({ id: v.string() }) }),
		);
		return added.ok ? ok(added.value.repo.id) : added;
	};

	const writeSpec = async (spec: string) => {
		await mkdir(opts.specDir, { recursive: true });
		const path = join(
			opts.specDir,
			`${Date.now()}-${Math.random().toString(36).slice(2)}.md`,
		);
		await writeFile(path, spec, { mode: 0o600 });
		return path;
	};

	const trustSeat = async (
		path: string,
	): Promise<Result<string, OrcaError>> => {
		const r = await opts.trust(path);
		if (r.ok) return r;
		log.error("seat trust failed", { path, reason: r.error.reason });
		return err({
			type: "SeatTrustFailed",
			command: "claude trust",
			reason: r.error.reason,
		});
	};

	/**
	 * 席の agent を受付が起動する。Orca の agent の起動は Orca の設定の権限（--dangerously-skip-permissions）で動くので、
	 * 端末を作って Claude を auto モードで（Codex は SEAT_CODEX_FLAGS で）起動し、その端末に spec を渡す。
	 */
	const launchAgent = async (
		path: string,
		title: string,
		spec: string,
		agent: SeatAgent,
		input: { how: SeatHow; model: string | null; prepare?: SeatPrepare },
	): Promise<Result<SeatHandle, OrcaError>> => {
		let cwd = path;
		// Codex は worktree の元のリポジトリ（席の元）で信頼を引くので、受付が起動時に 1 度だけ登録する
		if (agent === "claude") {
			const trusted = await trustSeat(path);
			if (!trusted.ok) return trusted;
			cwd = trusted.value;
		}
		let how = input.how;
		let text = spec;
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
		}
		const command = seatCommand(agent, how, input.model);
		const created = await call(
			[
				"terminal",
				"create",
				"--worktree",
				`path:${path}`,
				"--title",
				title,
				"--command",
				command,
			],
			terminalSchema,
		);
		if (!created.ok) return created;
		// claude.ai のコネクタ（chimera など）は Claude の起動から少し遅れて読み込まれ、最初のターンに間に合わない
		await sleep(MCP_WARMUP_MS);
		return startWith(
			[
				"--terminal",
				created.value.terminal.handle,
				"--worktree",
				`path:${path}`,
			],
			text,
			title,
		);
	};

	const startWith = async (
		args: readonly string[],
		spec: string,
		title: string,
	): Promise<Result<SeatHandle, OrcaError>> => {
		const specFile = await writeSpec(spec);
		try {
			const r = await call(
				[
					"orchestration",
					"worker-start",
					...asCoordinator(),
					"--spec-file",
					specFile,
					"--task-title",
					title,
					"--timeout-ms",
					String(START_TIMEOUT_MS),
					...args,
				],
				startSchema,
				START_TIMEOUT_MS + 30_000,
			);
			if (!r.ok) return r;
			return ok({
				dispatchId: r.value.dispatchId,
				terminal: r.value.terminal,
				path: pathOfWorkspace(r.value.workspace),
			});
		} finally {
			await rm(specFile, { force: true });
		}
	};

	const terminals = () => call(["terminal", "list"], terminalsSchema);

	const sleep =
		opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

	const createReception = () =>
		call(
			[
				"terminal",
				"create",
				"--worktree",
				`path:${opts.seatsRepo}`,
				"--title",
				RECEPTION_TITLE,
				"--command",
				"sleep infinity",
			],
			terminalSchema,
		);

	return {
		waitReady: async (timeoutMs) => {
			const deadline = Date.now() + timeoutMs;
			let last = "not checked";
			for (;;) {
				const r = await call(["status"], statusSchema, 10_000);
				if (r.ok && r.value.runtime?.state === "ready") return ok(undefined);
				const reason = r.ok
					? `state ${r.value.runtime?.state ?? "unknown"}`
					: r.error.reason;
				if (reason !== last) log.info("waiting for orca serve", { reason });
				last = reason;
				if (Date.now() >= deadline) {
					return err({ type: "OrcaFailed", command: "status", reason: last });
				}
				await sleep(1_000);
			}
		},
		prepare: async (prev) => {
			const repo = await ensureSeatsRepo();
			if (!repo.ok) return repo;
			repoId = repo.value;
			// 前の受付の端末が残っていると Run を引き継げない
			if (prev.reception) {
				await call(["terminal", "close", "--terminal", prev.reception], ignore);
			}
			const listed = await terminals();
			if (listed.ok) {
				for (const t of listed.value.terminals) {
					if (
						t.title === RECEPTION_TITLE &&
						t.worktreePath === opts.seatsRepo
					) {
						await call(["terminal", "close", "--terminal", t.handle], ignore);
					}
				}
			}
			const created = await createReception();
			if (!created.ok) return created;
			reception = created.value.terminal.handle;
			if (prev.runId) {
				const used = await call(
					["orchestration", "run-use", "--id", prev.runId, "--from", reception],
					runSchema,
				);
				if (used.ok) {
					runId = used.value.runId;
					return ok({ runId, reception });
				}
				log.warn("orca run-use failed; creating a new run", {
					reason: used.error.reason,
				});
			}
			const run = await call(
				[
					"orchestration",
					"run-create",
					"--objective",
					"仕事フォーラムの投稿ごとの席",
					"--from",
					reception,
				],
				runSchema,
			);
			if (!run.ok) return run;
			runId = run.value.runId;
			return ok({ runId, reception });
		},
		startSeat: async ({ name, title, spec, agent, model = null, prepare }) => {
			// 前に閉じそこねた同じ名前の worktree があると作れない
			const stale = join(opts.seatsDir, name);
			if (
				await stat(stale).then(
					() => true,
					() => false,
				)
			) {
				await call(
					[
						"worktree",
						"rm",
						"--worktree",
						`path:${stale}`,
						"--force",
						"--delete-branch",
					],
					ignore,
				);
			}
			// worktree を先に作り、Claude の信頼済みにしてから起動する。信頼していない場所の Claude は確認の画面で止まる
			const created = await call(
				[
					"worktree",
					"create",
					"--repo",
					`id:${repoId ?? ""}`,
					"--name",
					name,
					"--no-parent",
					"--setup",
					"skip",
				],
				worktreeSchema,
			);
			if (!created.ok) return created;
			const path = created.value.worktree.path;
			const launched = await launchAgent(path, title, spec, agent, {
				how: "start",
				model,
				prepare,
			});
			// 起こせなかった新しい席の worktree は、次に同じ名前で作るときの邪魔になる
			if (!launched.ok && launched.error.type === "SeatLeaseHeld") {
				await call(
					[
						"worktree",
						"rm",
						"--worktree",
						`path:${path}`,
						"--force",
						"--delete-branch",
					],
					ignore,
				);
			}
			return launched;
		},
		resumeSeat: async ({ path, title, spec, agent, model = null, prepare }) => {
			const exists = await stat(path).then(
				() => true,
				() => false,
			);
			if (!exists) {
				return err({
					type: "SeatWorktreeMissing",
					command: "resume",
					reason: path,
				});
			}
			// 前の会話のまま起こす
			return launchAgent(path, title, spec, agent, {
				how: "resume",
				model,
				prepare,
			});
		},
		switchModel: async ({ terminal, model }) => {
			const r = await call(
				[
					"terminal",
					"send",
					"--terminal",
					terminal,
					"--text",
					`/model ${model}`,
					"--enter",
				],
				ignore,
			);
			return r.ok ? ok(undefined) : r;
		},
		send: async ({ dispatchId, subject, body }) => {
			const r = await call(
				[
					"orchestration",
					"send",
					...asCoordinator(),
					"--to",
					`dispatch:${dispatchId}`,
					"--subject",
					subject,
					"--body",
					body,
				],
				sendSchema,
				START_TIMEOUT_MS + 30_000,
			);
			if (!r.ok) return r;
			return ok({
				dispatchId: r.value.dispatchId ?? dispatchId,
				terminal: r.value.terminal ?? null,
			});
		},
		reply: async ({ messageId, body }) => {
			const r = await call(
				[
					"orchestration",
					"reply",
					...asCoordinator(),
					"--id",
					messageId,
					"--body",
					body,
				],
				ignore,
			);
			return r.ok ? ok(undefined) : r;
		},
		stopSeat: async ({ dispatchId, terminal }) => {
			// 席の端末は Orca が起動したものと受付が --continue で作ったものがあり、止め方が違う。
			// どれが効いたかは問わず、最後に端末が消えたかだけを見る。
			if (dispatchId) {
				await call(
					["orchestration", "worker-stop", "--dispatch", dispatchId],
					ignore,
				);
				await call(
					["orchestration", "worker-release", "--dispatch", dispatchId],
					ignore,
				);
			}
			if (terminal) {
				await call(["terminal", "close", "--terminal", terminal], ignore);
			}
			if (dispatchId) {
				await call(
					["orchestration", "worker-abandon", "--dispatch", dispatchId],
					ignore,
				);
			}
			if (!terminal) return ok(undefined);
			const live = await terminals();
			if (!live.ok) return live;
			return live.value.terminals.some((t) => t.handle === terminal)
				? err({
						type: "OrcaFailed",
						command: "terminal close",
						reason: "still running",
					})
				: ok(undefined);
		},
		removeWorktree: async (path) => {
			const r = await call(
				[
					"worktree",
					"rm",
					"--worktree",
					`path:${path}`,
					"--force",
					"--delete-branch",
				],
				ignore,
			);
			return r.ok ? ok(undefined) : r;
		},
		closeTerminal: async (handle) => {
			const r = await call(["terminal", "close", "--terminal", handle], ignore);
			return r.ok ? ok(undefined) : r;
		},
		liveTerminals: async () => {
			const r = await terminals();
			return r.ok ? ok(new Set(r.value.terminals.map((t) => t.handle))) : r;
		},
		residue: async () => {
			const [wts, terms] = await Promise.all([
				call(["worktree", "list"], worktreesSchema),
				terminals(),
			]);
			if (!wts.ok) return wts;
			if (!terms.ok) return terms;
			return ok({
				worktrees: wts.value.worktrees
					.map((w) => w.path)
					.filter((p) => p !== opts.seatsDir && isUnder(p, opts.seatsDir)),
				terminals: terms.value.terminals.flatMap((t) =>
					t.worktreePath && isUnder(t.worktreePath, opts.seatsDir)
						? [{ handle: t.handle, path: t.worktreePath }]
						: [],
				),
			});
		},
		waitMessages: async (timeoutMs) => {
			const r = await call(
				[
					"orchestration",
					"check",
					"--terminal",
					reception ?? "",
					"--run",
					runId ?? "",
					"--wait",
					"--timeout-ms",
					String(timeoutMs),
				],
				messagesSchema,
				timeoutMs + 30_000,
			);
			if (!r.ok) return r;
			return ok(
				(r.value.messages ?? []).map((m) => ({
					id: m.id,
					type: m.type,
					from: m.from ?? "",
					subject: m.subject ?? "",
					body: m.body ?? "",
					dispatchId: m.payload?.dispatchId ?? null,
					outcome:
						m.payload?.outcome === "succeeded" ||
						m.payload?.outcome === "failed"
							? m.payload.outcome
							: null,
					stopReason: m.payload?.stopReason ?? null,
				})),
			);
		},
	};
};
