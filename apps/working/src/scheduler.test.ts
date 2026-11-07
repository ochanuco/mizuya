import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { silentLogger } from "./logger.ts";
import {
	type CurrentJob,
	createDkronClient,
	createSchedulerServer,
	type DesiredJobs,
	type DkronJob,
	dailyCron,
	desiredJobs,
	JOB_OWNER,
	planSync,
	type RunRequest,
	syncJobs,
	watchJobName,
} from "./scheduler.ts";
import type { Watch } from "./standup-materials.ts";

let close = () => {};
afterEach(() => close());

const start = async () => {
	const runs: RunRequest[] = [];
	let release = () => {};
	const blocked = new Promise<void>((r) => {
		release = r;
	});
	const server = createSchedulerServer({
		token: "run-token",
		run: async (r) => {
			runs.push(r);
			// 席は長く動くので、回が終わる前に 202 が返ることを確かめる
			await blocked;
		},
		logger: silentLogger,
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	close = () => {
		release();
		server.close();
	};
	const { port } = server.address() as AddressInfo;
	return { runs, url: `http://127.0.0.1:${port}/run` };
};

const post = (url: string, body: unknown, token?: string) =>
	fetch(url, {
		method: "POST",
		headers: token ? { authorization: `Bearer ${token}` } : {},
		body: typeof body === "string" ? body : JSON.stringify(body),
	});

describe("起こされる口", () => {
	it("トークンが合えば回が終わるのを待たずに 202 を返し、回を渡す", async () => {
		const { runs, url } = await start();
		expect((await post(url, { kind: "standup" }, "run-token")).status).toBe(
			202,
		);
		expect(
			(
				await post(
					url,
					{ kind: "watch", partner: "akarin", watch_id: "w-1" },
					"run-token",
				)
			).status,
		).toBe(202);
		expect(runs).toEqual([
			{ kind: "standup" },
			{ kind: "watch", partner: "akarin", watchId: "w-1" },
		]);
	});

	it("トークンが無いか違えば 401 で、回さない", async () => {
		const { runs, url } = await start();
		expect((await post(url, { kind: "patrol" })).status).toBe(401);
		expect((await post(url, { kind: "patrol" }, "other")).status).toBe(401);
		expect(runs).toEqual([]);
	});

	it("本文の形が違えば 400", async () => {
		const { runs, url } = await start();
		for (const body of [
			"{",
			{ kind: "event" },
			{ kind: "watch", partner: "someone", watch_id: "w-1" },
			{ kind: "watch", partner: "yukarin" },
		]) {
			expect((await post(url, body, "run-token")).status).toBe(400);
		}
		expect(runs).toEqual([]);
	});

	it("ほかの道と GET は受けない", async () => {
		const { url } = await start();
		expect(
			(await post(url.replace("/run", "/jobs"), {}, "run-token")).status,
		).toBe(404);
		expect((await fetch(url)).status).toBe(405);
	});
});

const watch = (
	id: string,
	interval: number | null,
	schedule: string | null = null,
): Watch => ({
	id,
	query: "中古の GPU",
	sources: [],
	interval_minutes: interval,
	schedule,
	until_at: null,
	last_checked_at: null,
	due: false,
	seen: [],
	notify_thread_id: null,
	partner: "yukarin",
});

const input = {
	standupAt: { hour: 9, minute: 5 },
	patrolSchedule: "0 0 */2 * * *",
	watches: [] as const,
	selfUrl: "http://working.example.com:8192/run",
	token: "run-token",
};

describe("desiredJobs", () => {
	it("朝会の時刻を秒から始まる cron にする", () => {
		expect(dailyCron({ hour: 9, minute: 5 })).toBe("0 5 9 * * *");
		expect(dailyCron({ hour: 0, minute: 0 })).toBe("0 0 0 * * *");
	});

	it("朝会と見回りを Asia/Tokyo で、重ねずに受付の口へ POST するジョブにする", () => {
		const { jobs } = desiredJobs(input);
		expect(jobs.map((j) => [j.name, j.schedule, j.timezone])).toEqual([
			["standup", "0 5 9 * * *", "Asia/Tokyo"],
			["patrol", "0 0 */2 * * *", "Asia/Tokyo"],
		]);
		expect(jobs[0]).toMatchObject({
			concurrency: "forbid",
			disabled: false,
			executor: "http",
			metadata: { owner: JOB_OWNER, kind: "standup" },
			executor_config: {
				method: "POST",
				url: "http://working.example.com:8192/run",
				headers:
					'["Authorization: Bearer run-token","Content-Type: application/json"]',
				body: '{"kind":"standup"}',
				expectCode: "202",
			},
		});
	});

	it("見張りは 1 件ずつ、間隔ごとのジョブにする。読めなかったパートナーは覚えておく", () => {
		const r = desiredJobs({
			...input,
			standupAt: null,
			patrolSchedule: null,
			watches: [
				["yukarin", [watch("W_01.a", 360)]],
				["akarin", { unavailable: "x" }],
			],
		});
		expect(r.unknownPartners).toEqual(["akarin"]);
		expect(r.jobs).toHaveLength(1);
		expect(r.jobs[0]).toMatchObject({
			name: "watch-yukarin-w_01-a",
			schedule: "@every 360m",
			timezone: "",
			metadata: { owner: JOB_OWNER, kind: "watch", partner: "yukarin" },
		});
		expect(JSON.parse(r.jobs[0]?.executor_config.body ?? "")).toEqual({
			kind: "watch",
			partner: "yukarin",
			watch_id: "W_01.a",
		});
	});

	it("cron 式の見張りは秒を足して Asia/Tokyo で回し、時刻の無い見張りはジョブを置かない", () => {
		const r = desiredJobs({
			...input,
			standupAt: null,
			patrolSchedule: null,
			watches: [
				[
					"yukarin",
					[
						watch("w1", null, "0 9-18 * * 1-5"),
						watch("w2", null),
						watch("w3", 60),
					],
				],
			],
		});
		expect(r.jobs.map((j) => [j.name, j.schedule, j.timezone])).toEqual([
			["watch-yukarin-w1", "0 0 9-18 * * 1-5", "Asia/Tokyo"],
			["watch-yukarin-w3", "@every 60m", ""],
		]);
		expect(r.unscheduledWatches).toEqual([
			{ partner: "yukarin", watch_id: "w2" },
		]);
	});

	it("ジョブ名は Dkron が受ける文字だけにする", () => {
		expect(watchJobName("yukarin", "01JX ABC/def")).toBe(
			"watch-yukarin-01jx-abc-def",
		);
	});
});

const asCurrent = (j: DkronJob): CurrentJob => ({ ...j });

describe("planSync", () => {
	const desired = (over: Partial<DesiredJobs> = {}): DesiredJobs => ({
		...desiredJobs({
			...input,
			watches: [["yukarin", [watch("w1", 120)]]],
		}),
		...over,
	});

	it("無いものは作り、違うものは更新し、同じものは触らない", () => {
		const d = desired();
		const [standup, patrol] = d.jobs;
		if (!standup || !patrol) throw new Error("jobs");
		const plan = planSync(d, [
			asCurrent(standup),
			asCurrent({ ...patrol, schedule: "0 0 */3 * * *" }),
		]);
		expect(plan.create.map((j) => j.name)).toEqual(["watch-yukarin-w1"]);
		expect(plan.update.map((j) => j.name)).toEqual(["patrol"]);
		expect(plan.remove).toEqual([]);
	});

	it("あるべき一覧に無い受付のジョブは消し、ほかの持ち主のジョブには触らない", () => {
		const d = desired();
		const plan = planSync(d, [
			...d.jobs.map(asCurrent),
			asCurrent({
				...(d.jobs[2] as DkronJob),
				name: "watch-yukarin-old",
			}),
			{
				...asCurrent(d.jobs[0] as DkronJob),
				name: "backup",
				metadata: { owner: "someone-else" },
			},
		]);
		expect(plan).toEqual({
			create: [],
			update: [],
			remove: ["watch-yukarin-old"],
		});
	});

	it("見張りを読めなかったパートナーの見張りのジョブは残す", () => {
		const d = desired({ jobs: [], unknownPartners: ["akarin"] });
		const akarinJob = asCurrent({
			...(desired().jobs[2] as DkronJob),
			name: "watch-akarin-w9",
			metadata: { owner: JOB_OWNER, kind: "watch", partner: "akarin" },
		});
		const yukarinJob = asCurrent(desired().jobs[2] as DkronJob);
		expect(planSync(d, [akarinJob, yukarinJob]).remove).toEqual([
			"watch-yukarin-w1",
		]);
	});
});

describe("syncJobs", () => {
	const fakeFetch = (jobs: unknown, status = 200) => {
		const calls: { method: string; url: string; headers: Headers }[] = [];
		const f: typeof fetch = async (url, init) => {
			const method = init?.method ?? "GET";
			calls.push({
				method,
				url: String(url),
				headers: new Headers(init?.headers),
			});
			if (method === "GET") return Response.json(jobs, { status });
			return new Response(null, { status: method === "POST" ? 201 : 200 });
		};
		return { f, calls };
	};

	it("Access の service token で Dkron を読み、差分だけを書く", async () => {
		const d = desiredJobs({ ...input, patrolSchedule: null });
		const { f, calls } = fakeFetch([
			{ name: "patrol", metadata: { owner: JOB_OWNER }, schedule: "x" },
		]);
		const r = await syncJobs({
			client: createDkronClient({
				url: "https://scheduler.example.com/",
				clientId: "sid",
				clientSecret: "ssecret",
				fetch: f,
			}),
			desired: async () => d,
			logger: silentLogger,
		});
		expect(r).toEqual({
			ok: true,
			value: { created: 1, updated: 0, removed: 1, failed: 0 },
		});
		expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
			"GET https://scheduler.example.com/v1/jobs?metadata[owner]=mizuya-working",
			"POST https://scheduler.example.com/v1/jobs",
			"DELETE https://scheduler.example.com/v1/jobs/patrol",
		]);
		expect(calls[0]?.headers.get("CF-Access-Client-Id")).toBe("sid");
		expect(calls[0]?.headers.get("CF-Access-Client-Secret")).toBe("ssecret");
	});

	it("Dkron に届かなければ書かずに失敗を返す", async () => {
		const { f, calls } = fakeFetch([], 502);
		const r = await syncJobs({
			client: createDkronClient({
				url: "https://scheduler.example.com",
				clientId: "sid",
				clientSecret: "ssecret",
				fetch: f,
			}),
			desired: async () => desiredJobs(input),
			logger: silentLogger,
		});
		expect(r.ok).toBe(false);
		expect(calls).toHaveLength(1);
	});
});
