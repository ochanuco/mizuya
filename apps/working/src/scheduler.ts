import { createServer, type Server } from "node:http";
import * as v from "valibot";
import {
	err,
	ok,
	PARTNER_IDS,
	type PartnerId,
	type Result,
} from "./lib/core.ts";
import type { Logger } from "./logger.ts";
import { authorized, readBody, reply } from "./server.ts";
import { failed, type Unavailable, type Watch } from "./standup-materials.ts";
import type { TimeOfDay } from "./standup-timer.ts";

export const SCHEDULER_RUN_PATH = "/run";

/** Dkron のジョブのうち、受付が持つものの印。ほかの用途のジョブには触らない。 */
export const JOB_OWNER = "mizuya-working";

export type RunRequest =
	| { kind: "standup" }
	| { kind: "patrol" }
	| { kind: "watch"; partner: PartnerId; watchId: string };

const runSchema = v.variant("kind", [
	v.object({ kind: v.literal("standup") }),
	v.object({ kind: v.literal("patrol") }),
	v.object({
		kind: v.literal("watch"),
		partner: v.picklist(PARTNER_IDS),
		watch_id: v.pipe(v.string(), v.nonEmpty()),
	}),
]);

/**
 * Dkron から朝会・見回り・見張りの回を起こされる口。LAN から届くよう、ほかの口とは別のポートで待ち受ける。
 * 席は長く動くので、受けたらすぐ 202 を返して後ろで回す。Dkron の HTTP の待ち時間に引っかけない。
 */
export const createSchedulerServer = (deps: {
	token: string;
	run: (req: RunRequest) => Promise<void>;
	logger: Logger;
}): Server =>
	createServer(async (req, res) => {
		if (req.url !== SCHEDULER_RUN_PATH) return reply(res, 404);
		if (req.method !== "POST") return reply(res, 405);
		if (!authorized(req.headers.authorization, deps.token)) {
			return reply(res, 401);
		}
		const raw = await readBody(req);
		if (raw === null) return reply(res, 413);
		let json: unknown;
		try {
			json = JSON.parse(raw);
		} catch {
			return reply(res, 400);
		}
		const parsed = v.safeParse(runSchema, json);
		if (!parsed.success) {
			deps.logger.warn("invalid scheduler run", {
				issues: parsed.issues.slice(0, 5).map((i) => i.message),
			});
			return reply(res, 400);
		}
		const o = parsed.output;
		const request: RunRequest =
			o.kind === "watch"
				? { kind: "watch", partner: o.partner, watchId: o.watch_id }
				: { kind: o.kind };
		reply(res, 202);
		deps.logger.info("scheduler run received", { kind: request.kind });
		void deps.run(request).catch((e: unknown) => {
			deps.logger.error("scheduler run crashed", {
				kind: request.kind,
				error: String(e),
			});
		});
	});

/** Dkron のジョブのうち、受付が書いて突き合わせる項目。 */
export type DkronJob = {
	name: string;
	schedule: string;
	timezone: string;
	concurrency: "forbid";
	disabled: boolean;
	retries: number;
	executor: "http";
	executor_config: Record<string, string>;
	metadata: Record<string, string>;
};

const TIMEZONE = "Asia/Tokyo";
/** 起こす口は 202 をすぐ返すので、これで足りる。 */
const RUN_TIMEOUT_SECONDS = "30";
const RUN_RETRIES = 2;

/** 朝会の時刻を Dkron の cron（先頭が秒の 6 フィールド）にする。 */
export const dailyCron = (at: TimeOfDay): string =>
	`0 ${at.minute} ${at.hour} * * *`;

/** Dkron のジョブ名に使えるのは小文字・数字・`_`・`-` だけ。 */
const jobNamePart = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]/g, "-");

export const watchJobName = (partner: string, watchId: string) =>
	`watch-${jobNamePart(partner)}-${jobNamePart(watchId)}`;

/**
 * 見張りの cron 式は日本時間の 5 項目なので、Dkron の秒を前に足して Asia/Tokyo で回す。
 * @every には timezone が効かないので空にする。
 */
const watchTiming = (
	w: Watch,
): { schedule: string; timezone: string } | null => {
	if (w.schedule !== null)
		return { schedule: `0 ${w.schedule}`, timezone: TIMEZONE };
	if (w.interval_minutes !== null)
		return { schedule: `@every ${w.interval_minutes}m`, timezone: "" };
	return null;
};

export type DesiredJobsInput = {
	/** null なら朝会のジョブを置かない。 */
	standupAt: TimeOfDay | null;
	/** null なら見回りのジョブを置かない。 */
	patrolSchedule: string | null;
	/** パートナーごとに記憶から読んだ見張り。 */
	watches: readonly (readonly [PartnerId, Watch[] | Unavailable])[];
	/** Dkron から届く、受付の起こされる口。 */
	selfUrl: string;
	token: string;
};

export type DesiredJobs = {
	jobs: DkronJob[];
	/** 見張りを読めなかったパートナー。そのパートナーの見張りのジョブは消さずに残す。 */
	unknownPartners: PartnerId[];
	/** schedule も interval_minutes も無く、ジョブを置けなかった見張り。 */
	unscheduledWatches: { partner: PartnerId; watch_id: string }[];
};

/** 受付があるべきとするジョブの一覧。 */
export const desiredJobs = (input: DesiredJobsInput): DesiredJobs => {
	const job = (
		name: string,
		schedule: string,
		timezone: string,
		body: unknown,
		metadata: Record<string, string>,
	): DkronJob => ({
		name,
		schedule,
		timezone,
		concurrency: "forbid",
		disabled: false,
		retries: RUN_RETRIES,
		executor: "http",
		executor_config: {
			method: "POST",
			url: input.selfUrl,
			headers: JSON.stringify([
				`Authorization: Bearer ${input.token}`,
				"Content-Type: application/json",
			]),
			body: JSON.stringify(body),
			timeout: RUN_TIMEOUT_SECONDS,
			expectCode: "202",
		},
		metadata: { owner: JOB_OWNER, ...metadata },
	});
	const jobs: DkronJob[] = [];
	if (input.standupAt !== null) {
		jobs.push(
			job(
				"standup",
				dailyCron(input.standupAt),
				TIMEZONE,
				{ kind: "standup" },
				{ kind: "standup" },
			),
		);
	}
	if (input.patrolSchedule !== null) {
		jobs.push(
			job(
				"patrol",
				input.patrolSchedule,
				TIMEZONE,
				{ kind: "patrol" },
				{ kind: "patrol" },
			),
		);
	}
	const unknownPartners: PartnerId[] = [];
	const unscheduledWatches: DesiredJobs["unscheduledWatches"] = [];
	for (const [partner, watches] of input.watches) {
		if (failed(watches)) {
			unknownPartners.push(partner);
			continue;
		}
		for (const w of watches) {
			const timing = watchTiming(w);
			if (timing === null) {
				unscheduledWatches.push({ partner, watch_id: w.id });
				continue;
			}
			jobs.push(
				job(
					watchJobName(partner, w.id),
					timing.schedule,
					timing.timezone,
					{ kind: "watch", partner, watch_id: w.id },
					{ kind: "watch", partner },
				),
			);
		}
	}
	return { jobs, unknownPartners, unscheduledWatches };
};

const stringRecord = v.nullish(v.record(v.string(), v.string()), {});

const currentJobSchema = v.object({
	name: v.string(),
	schedule: v.optional(v.string(), ""),
	timezone: v.optional(v.string(), ""),
	concurrency: v.optional(v.string(), ""),
	disabled: v.optional(v.boolean(), false),
	retries: v.optional(v.number(), 0),
	executor: v.optional(v.string(), ""),
	executor_config: stringRecord,
	metadata: stringRecord,
});

export type CurrentJob = v.InferOutput<typeof currentJobSchema>;

const sameRecord = (
	want: Record<string, string>,
	got: Record<string, string>,
) =>
	Object.keys(want).length === Object.keys(got).length &&
	Object.entries(want).every(([k, val]) => got[k] === val);

const sameJob = (want: DkronJob, got: CurrentJob) =>
	want.schedule === got.schedule &&
	want.timezone === got.timezone &&
	want.concurrency === got.concurrency &&
	want.disabled === got.disabled &&
	want.retries === got.retries &&
	want.executor === got.executor &&
	sameRecord(want.executor_config, got.executor_config) &&
	sameRecord(want.metadata, got.metadata);

export type SyncPlan = {
	create: DkronJob[];
	update: DkronJob[];
	remove: string[];
};

/** あるべきジョブと Dkron の今のジョブを突き合わせる。受付の印の無いジョブには触らない。 */
export const planSync = (
	desired: DesiredJobs,
	current: readonly CurrentJob[],
): SyncPlan => {
	const owned = current.filter((j) => j.metadata.owner === JOB_OWNER);
	const byName = new Map(owned.map((j) => [j.name, j]));
	const wanted = new Set(desired.jobs.map((j) => j.name));
	const plan: SyncPlan = { create: [], update: [], remove: [] };
	for (const job of desired.jobs) {
		const got = byName.get(job.name);
		if (got === undefined) plan.create.push(job);
		else if (!sameJob(job, got)) plan.update.push(job);
	}
	const keep = new Set<string>(desired.unknownPartners);
	for (const j of owned) {
		if (wanted.has(j.name)) continue;
		if (j.metadata.kind === "watch" && keep.has(j.metadata.partner ?? ""))
			continue;
		plan.remove.push(j.name);
	}
	return plan;
};

export type DkronError = { reason: string };

export type DkronClient = {
	list: () => Promise<Result<CurrentJob[], DkronError>>;
	upsert: (job: DkronJob) => Promise<Result<void, DkronError>>;
	remove: (name: string) => Promise<Result<void, DkronError>>;
};

/** Cloudflare Access の内側にある Dkron の REST API。Dkron には認証が無いので、Access の service token で通る。 */
export const createDkronClient = (deps: {
	url: string;
	clientId: string;
	clientSecret: string;
	fetch?: typeof fetch;
}): DkronClient => {
	const doFetch = deps.fetch ?? fetch;
	const base = deps.url.replace(/\/+$/, "");
	const call = async (
		path: string,
		init: RequestInit = {},
	): Promise<Result<Response, DkronError>> => {
		try {
			const res = await doFetch(`${base}${path}`, {
				...init,
				headers: {
					"CF-Access-Client-Id": deps.clientId,
					"CF-Access-Client-Secret": deps.clientSecret,
					...(init.body ? { "Content-Type": "application/json" } : {}),
				},
				redirect: "manual",
				signal: AbortSignal.timeout(30_000),
			});
			// Access に弾かれるとログイン画面への redirect になる
			if (!res.ok) {
				return err({
					reason: `${init.method ?? "GET"} ${path}: ${res.status}`,
				});
			}
			return ok(res);
		} catch (e) {
			return err({ reason: `${init.method ?? "GET"} ${path}: ${String(e)}` });
		}
	};
	return {
		list: async () => {
			const r = await call(
				`/v1/jobs?metadata[owner]=${encodeURIComponent(JOB_OWNER)}`,
			);
			if (!r.ok) return r;
			let json: unknown;
			try {
				json = await r.value.json();
			} catch {
				return err({ reason: "GET /v1/jobs: JSON ではない" });
			}
			const parsed = v.safeParse(v.array(currentJobSchema), json);
			return parsed.success
				? ok(parsed.output)
				: err({ reason: "GET /v1/jobs: 形が違う" });
		},
		upsert: async (job) => {
			const r = await call("/v1/jobs", {
				method: "POST",
				body: JSON.stringify(job),
			});
			return r.ok ? ok(undefined) : r;
		},
		remove: async (name) => {
			const r = await call(`/v1/jobs/${encodeURIComponent(name)}`, {
				method: "DELETE",
			});
			return r.ok ? ok(undefined) : r;
		},
	};
};

export type SyncReport = {
	created: number;
	updated: number;
	removed: number;
	failed: number;
};

/** 1 回突き合わせる。1 件書けなくても残りは書き、書けなかった数を返す。 */
export const syncJobs = async (deps: {
	client: DkronClient;
	desired: () => Promise<DesiredJobs>;
	logger: Logger;
}): Promise<Result<SyncReport, DkronError>> => {
	const [desired, current] = await Promise.all([
		deps.desired(),
		deps.client.list(),
	]);
	if (!current.ok) return current;
	for (const w of desired.unscheduledWatches)
		deps.logger.warn("watch has no schedule", w);
	const plan = planSync(desired, current.value);
	const report: SyncReport = { created: 0, updated: 0, removed: 0, failed: 0 };
	const write = async (
		r: Promise<Result<void, DkronError>>,
		name: string,
		done: "created" | "updated" | "removed",
	) => {
		const out = await r;
		if (out.ok) {
			report[done]++;
			return;
		}
		report.failed++;
		deps.logger.warn("scheduler job write failed", {
			job: name,
			reason: out.error.reason,
		});
	};
	for (const job of plan.create)
		await write(deps.client.upsert(job), job.name, "created");
	for (const job of plan.update)
		await write(deps.client.upsert(job), job.name, "updated");
	for (const name of plan.remove)
		await write(deps.client.remove(name), name, "removed");
	return ok(report);
};

/**
 * 起動時と一定の間隔で Dkron のジョブを突き合わせる。前の回が終わっていなければ重ねない。
 * Dkron に届かなければログだけ残して次の回に任せ、受付は止めない。
 */
export const startSchedulerSync = (deps: {
	client: DkronClient;
	desired: () => Promise<DesiredJobs>;
	intervalMs: number;
	logger: Logger;
}): { stop: () => void; syncNow: () => Promise<void> } => {
	let running: Promise<void> | null = null;
	const syncNow = () => {
		if (running) return running;
		running = (async () => {
			try {
				const r = await syncJobs(deps);
				if (r.ok) {
					const { created, updated, removed, failed } = r.value;
					const changed = created + updated + removed + failed > 0;
					deps.logger[changed ? "info" : "debug"]("scheduler synced", r.value);
				} else
					deps.logger.warn("scheduler unreachable", {
						reason: r.error.reason,
					});
			} catch (e) {
				deps.logger.error("scheduler sync crashed", { error: String(e) });
			} finally {
				running = null;
			}
		})();
		return running;
	};
	void syncNow();
	const timer = setInterval(() => void syncNow(), deps.intervalMs);
	return { stop: () => clearInterval(timer), syncNow };
};
