import * as v from "valibot";
import type { Exec } from "./exec.ts";
import { err, ok, type Result } from "./lib/core.ts";
import type { SeatAgent } from "./seat-engine.ts";

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
	/** 貸し出しを延ばす。他の機械が返してほしいと頼んでいれば、その持ち主を返す。 */
	renew: (input: {
		number: number;
		generation: number;
	}) => Promise<Result<Renewed, LeaseError>>;
	/** Manager の meta を読む。貸し出しの見張りが、Mac が借りているか・返したかを見る。 */
	meta: (number: number) => Promise<Result<SessionMeta, HishakuError>>;
	/** 席が作業した repo とブランチを meta に書く。Mac の hs open がそのブランチで worktree を作る。 */
	update: (
		number: number,
		input: { repo: string; branch: string },
	) => Promise<Result<void, HishakuError>>;
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

export type Renewed = {
	/** 返してほしいと頼んだ Commander の ID。頼まれていなければ null。 */
	releaseRequestedBy: string | null;
};

export type SessionMeta = {
	/** 今の持ち主。返した後は null。期限切れでも次に借りられるまでは残る。 */
	holder: string | null;
	generation: number;
	leaseExpiresAt: Date | null;
	/** 最後に正本の記録を置いた時刻。まだ置かれていないか、Manager が知らせなければ null。 */
	pushedAt: Date | null;
	/** `org/repo`。 */
	repo: string | null;
	branch: string | null;
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

const renewedSchema = v.object({
	release_requested_by: v.optional(v.nullable(v.string()), null),
});

const timestamp = v.pipe(
	v.string(),
	v.isoTimestamp(),
	v.transform((t) => new Date(t)),
);

const sessionMetaSchema = v.object({
	holder: v.nullable(v.string()),
	generation: v.pipe(v.number(), v.integer(), v.minValue(0)),
	lease_expires_at: v.nullable(timestamp),
	pushed_at: v.optional(v.nullable(timestamp), null),
	repo: v.optional(v.nullable(v.string()), null),
	branch: v.optional(v.nullable(v.string()), null),
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
	): Promise<Result<string, LeaseError>> => {
		const out = await hs(args);
		if (out.code === 0) return ok(out.stdout);
		if (out.code === STOLEN) return err({ type: "LeaseStolen" });
		return err({ type: "HishakuFailed", reason: failure(out).slice(0, 300) });
	};
	const base = opts.url.replace(/\/$/, "");
	const access = {
		"CF-Access-Client-Id": opts.clientId,
		"CF-Access-Client-Secret": opts.clientSecret,
	};

	return {
		holder: opts.holder,
		createSession: async (input) => {
			try {
				const res = await doFetch(`${base}/v1/sessions`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...access,
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
				});
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
		push: async ({ number, generation, cwd, release }) => {
			const r = await lease([
				"push",
				String(number),
				"--generation",
				String(generation),
				"--holder",
				opts.holder,
				"--cwd",
				cwd,
				...(release ? ["--release"] : []),
			]);
			return r.ok ? ok(undefined) : r;
		},
		renew: async ({ number, generation }) => {
			const r = await lease([
				"renew",
				String(number),
				"--generation",
				String(generation),
				"--holder",
				opts.holder,
				"--json",
			]);
			if (!r.ok) return r;
			// 延ばせたことは終了コードで分かるので、読めない応答は頼まれていないとみなす
			const parsed = v.safeParse(renewedSchema, lastJsonLine(r.value));
			return ok({
				releaseRequestedBy: parsed.success
					? parsed.output.release_requested_by
					: null,
			});
		},
		meta: async (number) => {
			try {
				const res = await doFetch(`${base}/v1/sessions/${number}`, {
					headers: access,
					redirect: "manual",
					signal: AbortSignal.timeout(30_000),
				});
				if (res.status !== 200) {
					return err({
						type: "HishakuFailed",
						reason: `GET /v1/sessions/${number} ${res.status}`,
					});
				}
				const parsed = v.safeParse(sessionMetaSchema, await res.json());
				if (!parsed.success) {
					return err({ type: "HishakuFailed", reason: "unexpected meta" });
				}
				return ok({
					holder: parsed.output.holder,
					generation: parsed.output.generation,
					leaseExpiresAt: parsed.output.lease_expires_at,
					pushedAt: parsed.output.pushed_at,
					repo: parsed.output.repo,
					branch: parsed.output.branch,
				});
			} catch (e) {
				return err({ type: "HishakuFailed", reason: String(e).slice(0, 300) });
			}
		},
		update: async (number, input) => {
			try {
				const res = await doFetch(`${base}/v1/sessions/${number}`, {
					method: "PATCH",
					headers: { "Content-Type": "application/json", ...access },
					body: JSON.stringify({ repo: input.repo, branch: input.branch }),
					redirect: "manual",
					signal: AbortSignal.timeout(30_000),
				});
				if (res.status !== 200) {
					return err({
						type: "HishakuFailed",
						reason: `PATCH /v1/sessions/${number} ${res.status}`,
					});
				}
				return ok(undefined);
			} catch (e) {
				return err({ type: "HishakuFailed", reason: String(e).slice(0, 300) });
			}
		},
	};
};
