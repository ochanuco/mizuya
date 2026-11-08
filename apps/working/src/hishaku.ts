import * as v from "valibot";
import type { Exec } from "./exec.ts";
import { err, ok, type Result } from "./lib/core.ts";
import type { SeatAgent } from "./orca.ts";

/**
 * 席の agent のセッションを hishaku の Manager に預ける口。
 * 番号の払い出しだけを受付が Manager に直接頼み、記録の出し入れと貸し出しは hs に任せる。
 * agent ごとの記録の置き場所や session_id の拾い方は hs だけが知っている。
 */
export type Hishaku = {
	/** 投稿の番号を払い出す。同じ投稿の生きている番号があれば Manager はそれを返す。 */
	createSession: (input: {
		postId: string;
		agent: SeatAgent;
		title: string;
		repo: string | null;
		branch: string | null;
	}) => Promise<Result<{ number: number }, HishakuError>>;
	/** 借りて、正本の記録を cwd の agent の置き場所に置く。 */
	prepare: (input: {
		number: number;
		cwd: string;
		takeover?: boolean;
	}) => Promise<Result<Prepared, PrepareError>>;
	/** agent の記録を預ける。release なら貸し出しを返す。 */
	push: (input: {
		number: number;
		generation: number;
		cwd: string;
		release: boolean;
	}) => Promise<Result<void, LeaseError>>;
	renew: (input: {
		number: number;
		generation: number;
	}) => Promise<Result<void, LeaseError>>;
	/** この受付の Commander の ID。 */
	holder: string;
};

export type Prepared = {
	agent: SeatAgent;
	/** 空なら agent が自分で ID を決める（Codex の新規）。 */
	sessionId: string;
	/** 正本に記録があり、前の会話のまま起こす。 */
	resume: boolean;
	generation: number;
};

export type HishakuError = { type: "HishakuFailed"; reason: string };
/** 他の機械が借りている。 */
export type HeldError = {
	type: "LeaseHeld";
	holder: string;
	leaseExpiresAt: string;
};
/** 貸し出しが他に取られていた。hs は記録を forks に預けている。 */
export type StolenError = { type: "LeaseStolen" };
export type PrepareError = HishakuError | HeldError;
export type LeaseError = HishakuError | StolenError;

const metaSchema = v.object({
	number: v.pipe(v.number(), v.integer(), v.minValue(1000), v.maxValue(9999)),
});

const preparedSchema = v.object({
	agent: v.picklist(["claude", "codex"]),
	// 席の端末のコマンドにそのまま入るので、shell が解釈する文字を通さない
	session_id: v.pipe(v.string(), v.regex(/^[A-Za-z0-9-]*$/)),
	resume: v.boolean(),
	generation: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

const heldSchema = v.object({
	holder: v.string(),
	lease_expires_at: v.optional(v.string(), ""),
});

/** hs の取り決めの終了コード。 */
const HELD = 2;
const STOLEN = 3;

const lastJsonLine = (stdout: string): unknown => {
	const line = stdout
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.startsWith("{"))
		.at(-1);
	if (line === undefined) return null;
	try {
		return JSON.parse(line);
	} catch {
		return null;
	}
};

const failure = (out: { code: number | null; stderr: string }) =>
	(out.stderr.trim().split("\n").at(-1) ?? "") || `exit ${out.code}`;

export const createHishaku = (opts: {
	url: string;
	clientId: string;
	clientSecret: string;
	holder: string;
	/** hs の実行ファイル。 */
	bin: string;
	exec: Exec;
	/** hs に渡す環境変数。agent の記録の置き場所（CLAUDE_CONFIG_DIR、CODEX_HOME）を席と揃える。 */
	env: Record<string, string>;
	cwd: string;
	fetch?: typeof fetch;
	timeoutMs?: number;
}): Hishaku => {
	const doFetch = opts.fetch ?? fetch;
	const timeoutMs = opts.timeoutMs ?? 60_000;
	const env = {
		...opts.env,
		HISHAKU_URL: opts.url,
		HISHAKU_ACCESS_CLIENT_ID: opts.clientId,
		HISHAKU_ACCESS_CLIENT_SECRET: opts.clientSecret,
		HISHAKU_HOLDER: opts.holder,
	};
	const hs = (args: readonly string[]) =>
		opts.exec(opts.bin, args, {
			stdin: "",
			cwd: opts.cwd,
			timeoutMs,
			env,
		});

	const lease = async (
		args: readonly string[],
	): Promise<Result<void, LeaseError>> => {
		const out = await hs(args);
		if (out.code === 0) return ok(undefined);
		if (out.code === STOLEN) return err({ type: "LeaseStolen" });
		return err({ type: "HishakuFailed", reason: failure(out).slice(0, 300) });
	};

	return {
		holder: opts.holder,
		createSession: async (input) => {
			try {
				const res = await doFetch(
					`${opts.url.replace(/\/$/, "")}/v1/sessions`,
					{
						method: "POST",
						headers: {
							"Content-Type": "application/json",
							"CF-Access-Client-Id": opts.clientId,
							"CF-Access-Client-Secret": opts.clientSecret,
						},
						body: JSON.stringify({
							post_id: input.postId,
							agent: input.agent,
							title: input.title,
							repo: input.repo,
							branch: input.branch,
						}),
						// Access の login 画面への redirect を成功と取り違えない
						redirect: "manual",
						signal: AbortSignal.timeout(30_000),
					},
				);
				if (res.status !== 200 && res.status !== 201) {
					return err({
						type: "HishakuFailed",
						reason: `POST /v1/sessions ${res.status}`,
					});
				}
				const parsed = v.safeParse(metaSchema, await res.json());
				if (!parsed.success) {
					return err({ type: "HishakuFailed", reason: "unexpected meta" });
				}
				return ok({ number: parsed.output.number });
			} catch (e) {
				return err({ type: "HishakuFailed", reason: String(e).slice(0, 300) });
			}
		},
		prepare: async ({ number, cwd, takeover = false }) => {
			const out = await hs([
				"prepare",
				String(number),
				"--holder",
				opts.holder,
				"--cwd",
				cwd,
				...(takeover ? ["--takeover"] : []),
				"--json",
			]);
			const json = lastJsonLine(out.stdout);
			if (out.code === HELD) {
				const held = v.safeParse(heldSchema, json);
				return err({
					type: "LeaseHeld",
					holder: held.success ? held.output.holder : "",
					leaseExpiresAt: held.success ? held.output.lease_expires_at : "",
				});
			}
			if (out.code !== 0) {
				return err({
					type: "HishakuFailed",
					reason: failure(out).slice(0, 300),
				});
			}
			const parsed = v.safeParse(preparedSchema, json);
			if (!parsed.success) {
				return err({ type: "HishakuFailed", reason: "unexpected prepare" });
			}
			return ok({
				agent: parsed.output.agent,
				sessionId: parsed.output.session_id,
				resume: parsed.output.resume,
				generation: parsed.output.generation,
			});
		},
		push: ({ number, generation, cwd, release }) =>
			lease([
				"push",
				String(number),
				"--generation",
				String(generation),
				"--holder",
				opts.holder,
				"--cwd",
				cwd,
				...(release ? ["--release"] : []),
			]),
		renew: ({ number, generation }) =>
			lease([
				"renew",
				String(number),
				"--generation",
				String(generation),
				"--holder",
				opts.holder,
			]),
	};
};
