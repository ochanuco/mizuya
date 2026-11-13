import * as v from "valibot";
import type { Exec } from "./exec.ts";
import type { Logger } from "./logger.ts";
import type { MacStateStore } from "./mac-state.ts";

/** 7 日以内に切れるなら、持ち主にログインし直してもらう。 */
export const LOGIN_EXPIRY_WARN_MS = 7 * 24 * 60 * 60 * 1000;
const REPO_LIMIT = 20;
const RENOVATE_REPO_LIMIT = 40;

export type Unavailable = { unavailable: string };

export const failed = (x: unknown): x is Unavailable =>
	typeof x === "object" && x !== null && "unavailable" in x;

export type GithubPr = {
	repo: string;
	number: number;
	title: string;
	url: string;
	draft: boolean;
	author: string | null;
	updated_at: Date | null;
};
export type Handoff = {
	repo: string;
	number: number;
	title: string;
	url: string;
	picked: boolean;
};
export type WorkingPr = {
	repo: string;
	number: number;
	title: string;
	url: string;
	branch: string;
	draft: boolean;
};
export type RenovatePr = WorkingPr & {
	onboarding: boolean;
	ci: "success" | "failure" | "pending";
	mergeable: string;
	merge_state: string;
};

/** 持ち主の目標。記憶（yunomi-memory read）の goals から取る。 */
export type Goal = { id: string; summary: string; created_at: string };

/** 持ち主の見張り。記憶（yunomi-memory read）の watches から取る。時刻は JST の書式の文字列のまま。 */
export type Watch = {
	id: string;
	query: string;
	sources: string[];
	/** schedule の見張りは null。 */
	interval_minutes: number | null;
	/** 日本時間の 5 項目の cron 式（分 時 日 月 曜日）。間隔の見張りは null。 */
	schedule: string | null;
	until_at: string | null;
	last_checked_at: string | null;
	/** Worker が読んだ時点で、前に調べてから間隔が過ぎているか。 */
	due: boolean;
	/** 前に知らせたものの key。 */
	seen: string[];
	/** 新着を書く仕事フォーラムの投稿。席から登録した見張りだけが持つ。 */
	notify_thread_id: string | null;
	/** 見張りを持つパートナー。調べ終えたら、このパートナーの記憶に残す。 */
	partner: string;
};

export type StandupMaterials = {
	memory: unknown;
	/** 時間が来た見張りを拾うため、記憶とは別に型付きで持つ。 */
	watches: Watch[] | Unavailable;
	/** 見回りで新しく足された目標を拾うため、記憶とは別に型付きで持つ。 */
	goals: Goal[] | Unavailable;
	mac_state:
		| {
				received_at: Date;
				worktrees: unknown[];
		  }
		| Unavailable;
	github: {
		open_prs: GithubPr[] | Unavailable;
		failing_prs: GithubPr[] | Unavailable;
		handoffs: Handoff[] | Unavailable;
		working_prs: WorkingPr[] | Unavailable;
		/** repo ごとに引くので、取れなかった repo は `{repo, unavailable}` で入る。 */
		renovate_prs:
			| (RenovatePr | (Unavailable & { repo: string }))[]
			| Unavailable;
	};
	claude_login: { expires_at: Date | null; expires_soon: boolean };
};

export type MaterialDeps = {
	exec: Exec;
	env: Record<string, string>;
	cwd: string;
	claudeBin: string;
	memoryBin: string;
	/**
	 * 見張りを読むパートナー。先頭は接続情報の既定のパートナーで、その記憶を席に渡す。
	 * 見張りは Talking でも Akarin の席でも足されるので、朝会と見回りは全員の分を調べる。
	 */
	partners: readonly [string, ...string[]];
	githubOwner: string;
	macState: MacStateStore;
	now: () => Date;
	logger: Logger;
};

const searchPrSchema = v.array(
	v.object({
		repository: v.object({ nameWithOwner: v.string() }),
		number: v.number(),
		title: v.string(),
		url: v.string(),
		isDraft: v.optional(v.boolean()),
		updatedAt: v.optional(v.string()),
		author: v.optional(v.object({ login: v.string() })),
	}),
);
const searchIssueSchema = v.array(
	v.object({
		repository: v.object({ nameWithOwner: v.string() }),
		number: v.number(),
		title: v.string(),
		url: v.string(),
		labels: v.optional(v.array(v.object({ name: v.string() }))),
	}),
);
const repoPrSchema = v.array(
	v.object({
		number: v.number(),
		title: v.string(),
		url: v.string(),
		headRefName: v.string(),
		isDraft: v.optional(v.boolean()),
	}),
);
const renovatePrSchema = v.array(
	v.object({
		number: v.number(),
		title: v.string(),
		url: v.string(),
		headRefName: v.string(),
		isDraft: v.optional(v.boolean()),
		mergeable: v.optional(v.string()),
		mergeStateStatus: v.optional(v.string()),
		statusCheckRollup: v.optional(
			v.array(
				v.object({
					status: v.nullish(v.string()),
					conclusion: v.nullish(v.string()),
					state: v.nullish(v.string()),
				}),
			),
		),
	}),
);
type Rollup = NonNullable<
	v.InferOutput<typeof renovatePrSchema>[number]["statusCheckRollup"]
>;

const RENOVATE_LOGIN = "renovate[bot]";
const CHECK_FAILED = new Set([
	"FAILURE",
	"ERROR",
	"CANCELLED",
	"TIMED_OUT",
	"ACTION_REQUIRED",
	"STARTUP_FAILURE",
]);

/** CheckRun は status と conclusion、StatusContext は state だけを持つ。 */
export const ciOf = (rollup: Rollup): "success" | "failure" | "pending" => {
	let pending = false;
	for (const c of rollup) {
		const result = c.conclusion ?? c.state ?? null;
		if (result !== null && CHECK_FAILED.has(result)) return "failure";
		if (
			(c.status !== null &&
				c.status !== undefined &&
				c.status !== "COMPLETED") ||
			result === "PENDING" ||
			result === "EXPECTED" ||
			result === null
		)
			pending = true;
	}
	return pending ? "pending" : "success";
};

const memoryGoalsSchema = v.object({
	goals: v.array(
		v.object({ id: v.string(), summary: v.string(), created_at: v.string() }),
	),
});

/** 記憶の応答から目標を取り出す。古い Worker は goals を返さないので、取れなければ unavailable にする。 */
export const goalsOf = (memory: unknown): Goal[] | Unavailable => {
	if (failed(memory)) return memory;
	const parsed = v.safeParse(memoryGoalsSchema, memory);
	return parsed.success
		? parsed.output.goals.map((g) => ({
				id: g.id,
				summary: g.summary,
				created_at: g.created_at,
			}))
		: { unavailable: "記憶の目標を読めなかった" };
};

const memoryWatchesSchema = v.object({
	watches: v.array(
		v.object({
			id: v.string(),
			query: v.string(),
			sources: v.array(v.string()),
			interval_minutes: v.nullable(v.number()),
			// schedule を返さない Worker もあるので、無ければ間隔の見張りとして読む
			schedule: v.optional(v.nullable(v.string()), null),
			until_at: v.nullable(v.string()),
			last_checked_at: v.nullable(v.string()),
			due: v.boolean(),
			seen: v.array(v.string()),
			notify_thread_id: v.optional(v.nullable(v.string()), null),
		}),
	),
});

/** 記憶の応答から見張りを取り出す。古い Worker は watches を返さないので、取れなければ unavailable にする。 */
export const watchesOf = (
	memory: unknown,
	partner: string,
): Watch[] | Unavailable => {
	if (failed(memory)) return memory;
	const parsed = v.safeParse(memoryWatchesSchema, memory);
	return parsed.success
		? parsed.output.watches.map((w) => ({ ...w, partner }))
		: { unavailable: "記憶の見張りを読めなかった" };
};

/** 受付の既定のパートナーの記憶を読む。読めなければ unavailable を返し、席はそれと分かって進める。 */
export const readMemory = async (
	deps: Pick<MaterialDeps, "exec" | "env" | "cwd" | "memoryBin" | "logger">,
): Promise<unknown> => {
	const out = await deps.exec(deps.memoryBin, ["read"], {
		stdin: "",
		cwd: deps.cwd,
		timeoutMs: 60_000,
		env: deps.env,
	});
	if (out.code !== 0) {
		deps.logger.warn("memory read failed", {
			code: out.code,
			stderr: out.stderr.slice(0, 300),
		});
		return { unavailable: "記憶を取れなかった" };
	}
	try {
		return JSON.parse(out.stdout);
	} catch {
		return { unavailable: "記憶を読めなかった" };
	}
};

/** 1 人のパートナーの記憶から、動いている見張りを読む。Dkron のジョブの同期と、見張り 1 件の回が使う。 */
export const readWatches = async (
	deps: Pick<MaterialDeps, "exec" | "env" | "cwd" | "memoryBin" | "logger">,
	partner: string,
): Promise<Watch[] | Unavailable> => {
	const out = await deps.exec(deps.memoryBin, ["read"], {
		stdin: "",
		cwd: deps.cwd,
		timeoutMs: 60_000,
		env: { ...deps.env, YUNOMI_PARTNER: partner },
	});
	if (out.code !== 0) {
		deps.logger.warn("watches read failed", {
			partner,
			code: out.code,
			stderr: out.stderr.slice(0, 300),
		});
		return { unavailable: `${partner} の記憶を取れなかった` };
	}
	let json: unknown;
	try {
		json = JSON.parse(out.stdout);
	} catch {
		json = undefined;
	}
	return watchesOf(json, partner);
};

/** Dkron が見張りを 1 件ずつ起こすときの、朝会と見回りの材料。見張りを外し、二度調べないようにする。 */
export const withoutWatches = (m: StandupMaterials): StandupMaterials => ({
	...m,
	watches: [],
});

/** パートナーごとの見張りを 1 つにまとめる。読めたパートナーの分だけで回し、どれも読めなければ unavailable にする。 */
const mergeWatches = (
	lists: readonly (Watch[] | Unavailable)[],
): Watch[] | Unavailable => {
	const ok = lists.filter((l): l is Watch[] => !failed(l));
	return ok.length === 0 && lists[0] !== undefined ? lists[0] : ok.flat();
};

/** 席に渡す記憶。見張りは時間が来たものだけを別に渡すので、記憶からは外す。 */
export const memoryForSeat = (memory: unknown): unknown => {
	if (typeof memory !== "object" || memory === null || !("watches" in memory))
		return memory;
	const { watches: _omit, ...rest } = memory as Record<string, unknown>;
	return rest;
};

const authSchema = v.object({
	loggedIn: v.optional(v.boolean()),
	loginExpiresAt: v.nullish(v.string()),
});

const toDate = (iso: string | undefined | null): Date | null => {
	if (!iso) return null;
	const t = Date.parse(iso);
	return Number.isNaN(t) ? null : new Date(t);
};

const msToDate = (ms: number | null | undefined) =>
	ms === null || ms === undefined ? null : new Date(ms);

/**
 * 朝会に渡す材料を集める。どれかが取れなくても朝会は回し、取れなかったことを材料に書く。
 * 時刻は Date にして返し、prompt にするときに toModelJson で JST の書式にする。
 */
export const gatherStandupMaterials = async (
	deps: MaterialDeps,
): Promise<StandupMaterials> => {
	const run = async <T>(
		label: string,
		bin: string,
		args: readonly string[],
		schema: v.GenericSchema<unknown, T>,
		env: Record<string, string> = deps.env,
	): Promise<T | Unavailable> => {
		const out = await deps.exec(bin, args, {
			stdin: "",
			cwd: deps.cwd,
			timeoutMs: 60_000,
			env,
		});
		if (out.code !== 0) {
			deps.logger.warn("standup material failed", {
				label,
				code: out.code,
				stderr: out.stderr.slice(0, 300),
			});
			return { unavailable: `${label} を取れなかった` };
		}
		let json: unknown;
		try {
			json = JSON.parse(out.stdout);
		} catch {
			json = undefined;
		}
		const parsed = v.safeParse(schema, json);
		if (!parsed.success) {
			deps.logger.warn("standup material unreadable", { label });
			return { unavailable: `${label} を読めなかった` };
		}
		return parsed.output;
	};
	const owner = deps.githubOwner;
	const prFields = "repository,number,title,url,isDraft,updatedAt,author";
	const [primary, ...others] = deps.partners;
	const otherWatches = Promise.all(
		others.map(async (partner) =>
			watchesOf(
				await run(`${partner} の記憶`, deps.memoryBin, ["read"], v.unknown(), {
					...deps.env,
					YUNOMI_PARTNER: partner,
				}),
				partner,
			),
		),
	);
	const [memory, latest, openPrs, failingPrs, handoffs, auth] =
		await Promise.all([
			run("記憶", deps.memoryBin, ["read"], v.unknown()),
			deps.macState.latest(),
			run(
				"open な PR",
				"gh",
				[
					"search",
					"prs",
					"--owner",
					owner,
					"--state",
					"open",
					"--json",
					prFields,
					"--limit",
					"100",
				],
				searchPrSchema,
			),
			run(
				"CI が落ちている PR",
				"gh",
				[
					"search",
					"prs",
					"--owner",
					owner,
					"--state",
					"open",
					"--checks",
					"failure",
					"--json",
					prFields,
					"--limit",
					"50",
				],
				searchPrSchema,
			),
			run(
				"申し送り",
				"gh",
				[
					"search",
					"issues",
					"--owner",
					owner,
					"--label",
					"working-handoff",
					"--state",
					"open",
					"--json",
					"repository,number,title,url,labels",
					"--limit",
					"50",
				],
				searchIssueSchema,
			),
			run(
				"Claude CLI のログイン",
				deps.claudeBin,
				["auth", "status", "--json"],
				authSchema,
			),
		]);

	const pr = (p: v.InferOutput<typeof searchPrSchema>[number]): GithubPr => ({
		repo: p.repository.nameWithOwner,
		number: p.number,
		title: p.title,
		url: p.url,
		draft: p.isDraft ?? false,
		author: p.author?.login ?? null,
		updated_at: toDate(p.updatedAt),
	});

	// Working が出す PR は GH_TOKEN の人が dev/ ブランチから出したもの。search は head を返さないので、repo ごとに引く
	let workingPrs: WorkingPr[] | Unavailable;
	if (failed(openPrs)) {
		workingPrs = openPrs;
	} else {
		const repos = [
			...new Set(openPrs.map((p) => p.repository.nameWithOwner)),
		].slice(0, REPO_LIMIT);
		const perRepo = await Promise.all(
			repos.map(async (repo) => {
				const r = await run(
					`${repo} の PR`,
					"gh",
					[
						"pr",
						"list",
						"--repo",
						repo,
						"--state",
						"open",
						"--author",
						"@me",
						"--json",
						"number,title,url,headRefName,isDraft",
						"--limit",
						"50",
					],
					repoPrSchema,
				);
				return failed(r)
					? []
					: r
							.filter((p) => p.headRefName.startsWith("dev/"))
							.map((p) => ({
								repo,
								number: p.number,
								title: p.title,
								url: p.url,
								branch: p.headRefName,
								draft: p.isDraft ?? false,
							}));
			}),
		);
		workingPrs = perRepo.flat();
	}

	// Renovate の PR は CI とコンフリクトの状態が要る。search はそれを返さないので、repo ごとに引く
	let renovatePrs: StandupMaterials["github"]["renovate_prs"];
	if (failed(openPrs)) {
		renovatePrs = openPrs;
	} else {
		const repos = [
			...new Set(
				openPrs
					.filter((p) => p.author?.login === RENOVATE_LOGIN)
					.map((p) => p.repository.nameWithOwner),
			),
		].slice(0, RENOVATE_REPO_LIMIT);
		const perRepo = await Promise.all(
			repos.map(async (repo) => {
				const r = await run(
					`${repo} の Renovate の PR`,
					"gh",
					[
						"pr",
						"list",
						"--repo",
						repo,
						"--state",
						"open",
						"--author",
						"app/renovate",
						"--json",
						"number,title,url,headRefName,isDraft,mergeable,mergeStateStatus,statusCheckRollup",
						"--limit",
						"50",
					],
					renovatePrSchema,
				);
				return failed(r)
					? [{ repo, ...r }]
					: r.map((p) => ({
							repo,
							number: p.number,
							title: p.title,
							url: p.url,
							branch: p.headRefName,
							draft: p.isDraft ?? false,
							// Renovate を入れる最初の PR。入れるかどうかは持ち主が決める
							onboarding: p.headRefName === "renovate/configure",
							ci: ciOf(p.statusCheckRollup ?? []),
							mergeable: p.mergeable ?? "UNKNOWN",
							merge_state: p.mergeStateStatus ?? "UNKNOWN",
						}));
			}),
		);
		renovatePrs = perRepo.flat();
	}
	const watches = mergeWatches([
		watchesOf(memory, primary),
		...(await otherWatches),
	]);

	const expiresAt = failed(auth) ? null : toDate(auth.loginExpiresAt);
	return {
		memory,
		goals: goalsOf(memory),
		watches,
		mac_state:
			latest === null
				? { unavailable: "Mac から席の状態が届いたことがない" }
				: {
						received_at: latest.receivedAt,
						worktrees: latest.state.worktrees.map((w) => ({
							...w,
							last_activity_at: msToDate(w.last_activity_at),
							agents: w.agents.map((a) => ({
								...a,
								updated_at: msToDate(a.updated_at),
							})),
						})),
					},
		github: {
			open_prs: failed(openPrs) ? openPrs : openPrs.map(pr),
			failing_prs: failed(failingPrs) ? failingPrs : failingPrs.map(pr),
			handoffs: failed(handoffs)
				? handoffs
				: handoffs.map((i) => ({
						repo: i.repository.nameWithOwner,
						number: i.number,
						title: i.title,
						url: i.url,
						picked: (i.labels ?? []).some(
							(l) => l.name === "working-handoff-picked",
						),
					})),
			working_prs: workingPrs,
			renovate_prs: renovatePrs,
		},
		claude_login: {
			expires_at: expiresAt,
			expires_soon:
				expiresAt !== null &&
				expiresAt.getTime() - deps.now().getTime() <= LOGIN_EXPIRY_WARN_MS,
		},
	};
};
