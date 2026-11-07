import { describe, expect, it, vi } from "vitest";
import type { ActivityEntry } from "./activity-log.ts";
import type { ExecResult } from "./exec.ts";
import { err, externalServiceUnavailable } from "./lib/core.ts";
import { silentLogger } from "./logger.ts";
import { openMacStateStore } from "./mac-state.ts";
import type { PatrolSnapshot, PatrolStore } from "./patrol.ts";
import {
	finishStandup,
	parseDecisions,
	startStandup,
	startWatch,
	type WatchTarget,
} from "./standup.ts";
import {
	ciOf,
	gatherStandupMaterials,
	goalsOf,
	type StandupMaterials,
	watchesOf,
} from "./standup-materials.ts";
import {
	FORUM,
	fakeDiscord,
	memoryApprovals,
	OWNER,
	TEXT,
	tempDir,
	tempLedger,
} from "./test-support.ts";

const NOW = new Date("2026-11-05T00:00:00Z");

const materials = (
	over: Partial<StandupMaterials["claude_login"]> = {},
	github: Partial<StandupMaterials["github"]> = {},
): StandupMaterials => ({
	memory: { facts: [] },
	goals: [],
	watches: [],
	mac_state: { unavailable: "x" },
	github: {
		open_prs: [],
		failing_prs: [],
		handoffs: [],
		working_prs: [],
		renovate_prs: [],
		...github,
	},
	claude_login: {
		expires_at: new Date("2026-12-01T00:00:00Z"),
		expires_soon: false,
		...over,
	},
});

const memoryStore = (initial: PatrolSnapshot | null = null) => {
	const store: PatrolStore & { saved: PatrolSnapshot | null } = {
		saved: initial,
		load: async () => store.saved,
		save: async (s) => {
			store.saved = s;
		},
	};
	return store;
};

const failingPr = (number: number) => ({
	repo: "ochanuco/yunomi",
	number,
	title: `PR ${number}`,
	url: `https://github.com/ochanuco/yunomi/pull/${number}`,
	draft: false,
	author: "ochanuco",
	updated_at: NOW,
});

const decisionsReply = (n: number) =>
	`朝会のメモ\n\n\`\`\`json\n${JSON.stringify({
		decisions: Array.from({ length: n }, (_, i) => ({
			title: `件${i + 1}`,
			body: `本文${i + 1}`,
		})),
	})}\n\`\`\``;

const setup = () => {
	const discord = fakeDiscord();
	const system = fakeDiscord();
	const approvals = memoryApprovals();
	const ledger = tempLedger();
	const activity: ActivityEntry[] = [];
	const deps = {
		discord: discord.api,
		system: system.api,
		ownerUserId: OWNER,
		approvals,
		ledger,
		workForumChannelId: FORUM,
		workTextChannelId: TEXT,
		recordActivity: async (e: ActivityEntry) => {
			activity.push(e);
		},
		now: () => NOW,
		logger: silentLogger,
	};
	return { deps, discord, system, approvals, ledger, activity };
};

describe("startStandup", () => {
	it("材料を JST の書式にした spec で朝会の席を作る", async () => {
		const t = setup();
		const start = vi.fn(async (_spec: string) => "standup-1");
		await startStandup({
			deps: t.deps,
			kind: "standup",
			store: memoryStore(),
			gather: async () => materials(),
			start,
		});
		const spec = start.mock.calls[0]?.[0] ?? "";
		expect(spec).toContain("朝会をする");
		expect(spec).toContain("2026-12-01 09:00 JST");
		expect(spec).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/);
		expect(t.discord.posts).toEqual([]);
	});

	it("朝会の材料に目標を入れ、目標に効く提案を頼む", async () => {
		const start = vi.fn(async (_spec: string, _kind: string) => "standup-1");
		const goal = {
			id: "g1",
			summary: "本を書く",
			created_at: "2026-11-05 21:00 JST",
		};
		await startStandup({
			deps: setup().deps,
			kind: "standup",
			store: memoryStore(),
			gather: async () => ({ ...materials(), goals: [goal] }),
			start,
		});
		const [spec] = start.mock.calls[0] ?? [];
		expect(spec).toContain('"goals":[{"id":"g1","summary":"本を書く"');
		expect(spec).toContain("目標（goals）に効く提案があれば");
	});

	it("ログインの期限が近ければ、席の返事を待たずに 1 件立てる", async () => {
		const t = setup();
		await startStandup({
			deps: t.deps,
			kind: "standup",
			store: memoryStore(),
			gather: async () =>
				materials({
					expires_at: new Date("2026-11-08T00:00:00Z"),
					expires_soon: true,
				}),
			start: async () => "standup-1",
		});
		expect(t.discord.posts[0]?.name).toContain("ログイン");
		expect(t.discord.posts[0]?.content).toContain("2026-11-08 09:00 JST");
	});
});

describe("startStandup の見回り", () => {
	const patrol = (
		store: PatrolStore,
		github: Partial<StandupMaterials["github"]>,
		start = vi.fn(async (_spec: string, _kind: string) => "patrol-1"),
	) =>
		startStandup({
			deps: setup().deps,
			kind: "patrol",
			store,
			gather: async () =>
				materials(
					{ expires_at: new Date("2026-11-06T00:00:00Z"), expires_soon: true },
					github,
				),
			start,
		}).then((id) => ({ id, start }));

	it("初めての回は覚えるだけで、席を立てない", async () => {
		const store = memoryStore();
		const r = await patrol(store, { failing_prs: [failingPr(1)] });
		expect(r.id).toBeNull();
		expect(r.start).not.toHaveBeenCalled();
		expect(store.saved?.failing_prs).toEqual({ "ochanuco/yunomi#1": "" });
	});

	it("前の回から変わっていなければ席を立てない", async () => {
		const store = memoryStore();
		await patrol(store, { failing_prs: [failingPr(1)] });
		const r = await patrol(store, { failing_prs: [failingPr(1)] });
		expect(r.start).not.toHaveBeenCalled();
	});

	it("新しく落ちた PR だけを材料にして席を立て、ログインの期限は投稿しない", async () => {
		const store = memoryStore();
		await patrol(store, { failing_prs: [failingPr(1)] });
		const t = setup();
		const start = vi.fn(async (_spec: string, _kind: string) => "patrol-1");
		await startStandup({
			deps: t.deps,
			kind: "patrol",
			store,
			gather: async () =>
				materials(
					{ expires_at: new Date("2026-11-06T00:00:00Z"), expires_soon: true },
					{ failing_prs: [failingPr(1), failingPr(2)] },
				),
			start,
		});
		const [spec, kind] = start.mock.calls[0] ?? [];
		expect(kind).toBe("patrol");
		expect(spec).toContain("見回りをする");
		expect(spec).toContain("pull/2");
		expect(spec).not.toContain('pull/1"');
		expect(t.discord.posts).toEqual([]);
		// 同じ件は次の回では拾わない
		const again = await patrol(store, {
			failing_prs: [failingPr(1), failingPr(2)],
		});
		expect(again.start).not.toHaveBeenCalled();
	});

	it("会話で足された目標があれば、それを材料にして席を立て、目標に効く提案を頼む", async () => {
		const store = memoryStore();
		await patrol(store, {});
		const goal = {
			id: "g1",
			summary: "家の電気代を下げる",
			created_at: "2026-11-05 21:00 JST",
		};
		const start = vi.fn(async (_spec: string, _kind: string) => "patrol-1");
		await startStandup({
			deps: setup().deps,
			kind: "patrol",
			store,
			gather: async () => ({ ...materials(), goals: [goal] }),
			start,
		});
		const [spec] = start.mock.calls[0] ?? [];
		expect(spec).toContain('"goals":[{"id":"g1"');
		expect(spec).toContain("目標（goals）に効く提案があれば");
		expect(spec).toContain("根拠があるときだけ");
	});

	const watch = (id: string, due: boolean, thread: string | null = null) => ({
		id,
		query: "RTX3090 の中古、24GB",
		sources: ["https://shop.example/gpu"],
		interval_minutes: 360,
		schedule: null,
		until_at: null,
		last_checked_at: due ? "2026-11-04 12:00 JST" : "2026-11-05 08:00 JST",
		due,
		seen: ["https://shop.example/gpu/1"],
		notify_thread_id: thread,
		partner: "yukarin",
	});

	it("GitHub に変わりが無くても、時間が来た見張りがあれば、その見張りだけを渡して席を立てる", async () => {
		for (const first of [true, false]) {
			const store = memoryStore();
			if (!first) await patrol(store, {});
			const start = vi.fn(async (_spec: string, _kind: string) => "patrol-1");
			await startStandup({
				deps: setup().deps,
				kind: "patrol",
				store,
				gather: async () => ({
					...materials(),
					memory: { facts: [], watches: [watch("w1", true)] },
					watches: [watch("w1", true), watch("w2", false)],
				}),
				start,
			});
			const [spec] = start.mock.calls[0] ?? [];
			expect(spec).toContain('"due_watches":[{"id":"w1"');
			expect(spec).not.toContain('"id":"w2"');
			// 見張りは記憶からは外し、時間が来たものだけを渡す
			expect(spec).toContain('"memory":{"facts":[]}');
			expect(spec).toContain(
				"yunomi-memory watch-checked --partner <見張りの partner> --id",
			);
			expect(spec).toContain('"partner":"yukarin"');
			expect(spec).toContain('"changes":{}');
		}
	});

	it("見張りの新着は、その見張りを頼まれた投稿に書く", async () => {
		const t = setup();
		const deps = { ...t.deps, watchThreads: new Map<string, WatchTarget>() };
		const store = memoryStore();
		await patrol(store, {});
		const start = vi.fn(async (_spec: string, _kind: string) => "patrol-1");
		await startStandup({
			deps,
			kind: "patrol",
			store,
			gather: async () => ({
				...materials(),
				watches: [watch("w1", true, "777"), watch("w3", true)],
			}),
			start,
		});
		const [spec] = start.mock.calls[0] ?? [];
		expect(spec).not.toContain("notify_thread_id");
		await finishStandup(
			deps,
			'```json\n{"decisions": [], "notices": [{"watch_id": "w1", "text": "A 店に出ていました https://a.example/1"}, {"watch_id": "w3", "text": "B 店に出ていました"}, "C 店に出ていました"]}\n```',
			[],
			"patrol",
		);
		expect(t.discord.sentTo("777")).toEqual([
			"A 店に出ていました https://a.example/1",
		]);
		expect(t.discord.sentTo(TEXT)).toEqual([
			"B 店に出ていました\nC 店に出ていました",
		]);
	});

	it("時間が来た見張りが無く、変わりも無ければ席を立てない", async () => {
		const store = memoryStore();
		await patrol(store, {});
		const start = vi.fn(async (_spec: string, _kind: string) => "patrol-1");
		const id = await startStandup({
			deps: setup().deps,
			kind: "patrol",
			store,
			gather: async () => ({ ...materials(), watches: [watch("w2", false)] }),
			start,
		});
		expect(id).toBeNull();
		expect(start).not.toHaveBeenCalled();
	});

	it("席を立てられなければ覚えず、次の回で拾い直す", async () => {
		const store = memoryStore();
		await patrol(store, {});
		await expect(
			patrol(
				store,
				{ failing_prs: [failingPr(3)] },
				vi.fn(async () => {
					throw new Error("orca down");
				}),
			),
		).rejects.toThrow("orca down");
		const r = await patrol(store, { failing_prs: [failingPr(3)] });
		expect(r.start).toHaveBeenCalledOnce();
	});
});

describe("finishStandup", () => {
	it("決めてほしいことが 0 件なら何も投稿しない", async () => {
		const t = setup();
		const r = await finishStandup(t.deps, decisionsReply(0), []);
		expect(r.posted).toEqual([]);
		expect(t.discord.api.createForumPost).not.toHaveBeenCalled();
	});

	it("N 件なら N 投稿を立ててタグを決めてほしいにする", async () => {
		const t = setup();
		const r = await finishStandup(t.deps, decisionsReply(3), []);
		expect(r.posted).toEqual(["thread1", "thread2", "thread3"]);
		expect(t.discord.posts.map((p) => p.name)).toEqual(["件1", "件2", "件3"]);
		expect(t.discord.posts.every((p) => p.tagIds[0] === "tag-decide")).toBe(
			true,
		);
		expect(t.discord.posts[0]?.content).toContain("本文1");
		expect(t.discord.posts[0]?.content).toContain("2026-11-05 の朝会");
		expect(t.discord.posts[0]?.buttons).toBeUndefined();
		expect(t.discord.posts[0]?.content.startsWith(`<@${OWNER}> `)).toBe(true);
		expect(t.discord.posts[0]?.notify).toEqual([OWNER]);
		expect(t.system.sent[0]).toMatchObject({
			channelId: "thread1",
			buttons: ["thread:dismiss"],
		});
	});

	it("読めない返事なら投稿しない", async () => {
		const t = setup();
		const r = await finishStandup(t.deps, "決めてほしいことはありません", []);
		expect(r.posted).toEqual([]);
	});

	it("hook が止めた操作は 1 投稿にまとめ、許可を待つ", async () => {
		const t = setup();
		const op = { tool: "Bash", target: "gh pr merge 3" };
		const r = await finishStandup(t.deps, decisionsReply(0), [
			{ operation: op, reason: "gh pr merge" },
		]);
		expect(r.posted).toEqual(["thread1"]);
		expect(t.discord.posts[0]?.content).toContain("gh pr merge 3");
		expect(t.system.sent).toEqual([
			expect.objectContaining({
				channelId: "thread1",
				buttons: ["approval:grant", "approval:deny", "thread:dismiss"],
			}),
		]);
		expect(t.approvals.get("thread1")).toEqual({
			messageIds: ["thread1", "sent1"],
			operations: [op],
		});
	});

	it("見張りの新着は仕事チャンネルに 1 件 1 行で書き、投稿は立てない", async () => {
		const t = setup();
		await finishStandup(
			t.deps,
			'```json\n{"decisions": [], "notices": ["RTX3090 の中古が A 店に 89,800 円で出ていました https://shop.example/gpu/2", "B 店にも 92,000 円で https://b.example/3"]}\n```',
			[],
			"patrol",
		);
		expect(t.discord.posts).toEqual([]);
		expect(t.discord.sentTo(TEXT)).toEqual([
			"RTX3090 の中古が A 店に 89,800 円で出ていました https://shop.example/gpu/2\nB 店にも 92,000 円で https://b.example/3",
		]);
	});

	it("見張りの新着が書けなければ、間をおいてやり直す", async () => {
		const t = setup();
		const send = t.deps.discord.send;
		let failures = 2;
		const waits: number[] = [];
		const deps = {
			...t.deps,
			discord: {
				...t.deps.discord,
				send: (async (...args: Parameters<typeof send>) =>
					failures-- > 0
						? err(externalServiceUnavailable({ service: "discord" }))
						: send(...args)) as typeof send,
			},
			sleep: async (ms: number) => {
				waits.push(ms);
			},
		};
		await finishStandup(
			deps,
			'```json\n{"decisions": [], "notices": ["A 店に出ていました https://a.example/1"]}\n```',
			[],
			"patrol",
		);
		expect(waits).toEqual([10_000, 60_000]);
		expect(t.discord.sentTo(TEXT)).toEqual([
			"A 店に出ていました https://a.example/1",
		]);
	});

	it("新着が無ければ仕事チャンネルにも書かない", async () => {
		const t = setup();
		await finishStandup(
			t.deps,
			'```json\n{"decisions": []}\n```',
			[],
			"patrol",
		);
		expect(t.discord.sentTo(TEXT)).toEqual([]);
	});

	it("GitHub の知らせの席が止められた操作も、道具の名前だけを活動ログに残す", async () => {
		const t = setup();
		await finishStandup(
			t.deps,
			decisionsReply(0),
			[{ operation: { tool: "Bash", target: "gh pr merge 3" }, reason: "x" }],
			"event",
		);
		expect(t.activity).toEqual([
			{
				at: NOW,
				kind: "blocked",
				threadId: "thread1",
				title: "GitHub の知らせで止めた操作",
				partner: "yukarin",
				tools: ["Bash"],
			},
		]);
	});

	it("見回りの投稿は時刻で、止めた操作の件名も見回りにする", async () => {
		const t = setup();
		await finishStandup(
			t.deps,
			decisionsReply(1),
			[{ operation: { tool: "Bash", target: "gh pr merge 3" }, reason: "x" }],
			"patrol",
		);
		expect(t.discord.posts[0]?.content).toContain("09:00 の見回りから");
		expect(t.discord.posts[1]?.name).toBe("見回りで止めた操作");
	});
});

describe("parseDecisions", () => {
	it("最後の json ブロックを読み、長い件名は切る", () => {
		const text = `\`\`\`json\n{"decisions":[]}\n\`\`\`\n\n\`\`\`json\n{"decisions":[{"title":"${"あ".repeat(70)}","body":"b"}]}\n\`\`\``;
		const d = parseDecisions(text);
		expect(d).toHaveLength(1);
		expect(d?.[0]?.title.length).toBe(61);
	});
	it("形が違えば null", () => {
		expect(parseDecisions('```json\n{"decisions":[{"title":""}]}\n```')).toBe(
			null,
		);
		expect(parseDecisions("なし")).toBe(null);
	});
});

describe("gatherStandupMaterials", () => {
	const exec = (table: Record<string, Partial<ExecResult>>) =>
		vi.fn(async (bin: string, args: readonly string[]) => {
			const key = `${bin} ${args.slice(0, 2).join(" ")}`;
			const hit =
				Object.entries(table).find(([k]) => key.startsWith(k))?.[1] ?? {};
			return { code: 0, stdout: "[]", stderr: "", ...hit };
		});

	it("記憶・席の状態・GitHub・ログインの期限を集め、取れなかったものは印を付ける", async () => {
		const dir = tempDir();
		const store = openMacStateStore(dir);
		await store.save(
			{
				sent_at: 1,
				worktrees: [
					{
						repo: "yunomi",
						last_activity_at: Date.parse("2026-11-04T12:00:00Z"),
						agents: [{ type: "claude", state: "done", updated_at: null }],
					},
				],
			},
			new Date("2026-11-04T13:00:00Z"),
		);
		const pr = {
			repository: { nameWithOwner: "o/a" },
			number: 1,
			title: "t",
			url: "u",
			updatedAt: "2026-11-04T00:00:00Z",
		};
		const run = exec({
			"yunomi-memory read": { stdout: '{"facts":[]}' },
			"gh search prs": { stdout: JSON.stringify([pr]) },
			"gh search issues": { code: 1, stderr: "boom" },
			"gh pr list": {
				stdout: JSON.stringify([
					{ number: 1, title: "t", url: "u", headRefName: "dev/x" },
					{ number: 2, title: "t", url: "u", headRefName: "feature" },
				]),
			},
			"claude auth status": {
				stdout: JSON.stringify({ loginExpiresAt: "2026-11-10T00:00:00.000Z" }),
			},
		});
		const m = await gatherStandupMaterials({
			exec: run,
			env: {},
			cwd: "/w",
			claudeBin: "claude",
			memoryBin: "yunomi-memory",
			partners: ["yukarin"],
			githubOwner: "o",
			macState: store,
			now: () => NOW,
			logger: silentLogger,
		});
		expect(m.memory).toEqual({ facts: [] });
		// goals を返さない記憶は、目標を読めなかったことにする
		expect(m.goals).toEqual({ unavailable: "記憶の目標を読めなかった" });
		expect(m.mac_state).toMatchObject({
			received_at: new Date("2026-11-04T13:00:00Z"),
		});
		expect(m.github.handoffs).toEqual({
			unavailable: "申し送り を取れなかった",
		});
		expect(m.github.working_prs).toEqual([
			expect.objectContaining({ number: 1, branch: "dev/x" }),
		]);
		expect(m.claude_login).toEqual({
			expires_at: new Date("2026-11-10T00:00:00.000Z"),
			expires_soon: true,
		});
	});

	it("見張りは全員の記憶から読み、持ち主のパートナーを付ける。記憶は既定のパートナーの分だけ", async () => {
		const watchOf = (id: string) => ({
			id,
			query: "q",
			sources: [],
			interval_minutes: 360,
			until_at: null,
			last_checked_at: null,
			due: true,
			seen: [],
		});
		const run = vi.fn(
			async (
				bin: string,
				args: readonly string[],
				opts: { env?: Record<string, string> },
			) => {
				if (bin !== "yunomi-memory" || args[0] !== "read")
					return { code: 0, stdout: "[]", stderr: "" };
				const partner = opts.env?.YUNOMI_PARTNER ?? "yukarin";
				return partner === "yukarin"
					? {
							code: 0,
							stderr: "",
							stdout: JSON.stringify({ facts: [], watches: [watchOf("y1")] }),
						}
					: {
							code: 0,
							stderr: "",
							stdout: JSON.stringify({
								facts: ["a"],
								watches: [watchOf("a1")],
							}),
						};
			},
		);
		const m = await gatherStandupMaterials({
			exec: run,
			env: {},
			cwd: "/w",
			claudeBin: "claude",
			memoryBin: "yunomi-memory",
			partners: ["yukarin", "akarin"],
			githubOwner: "o",
			macState: openMacStateStore(tempDir()),
			now: () => NOW,
			logger: silentLogger,
		});
		expect(m.memory).toEqual({ facts: [], watches: [watchOf("y1")] });
		expect(m.watches).toEqual([
			expect.objectContaining({ id: "y1", partner: "yukarin" }),
			expect.objectContaining({ id: "a1", partner: "akarin" }),
		]);
	});

	it("読めなかったパートナーの見張りだけを外し、残りで回す", async () => {
		const run = vi.fn(
			async (
				bin: string,
				args: readonly string[],
				opts: { env?: Record<string, string> },
			) => {
				if (bin !== "yunomi-memory" || args[0] !== "read")
					return { code: 0, stdout: "[]", stderr: "" };
				return opts.env?.YUNOMI_PARTNER === "akarin"
					? { code: 0, stderr: "", stdout: JSON.stringify({ watches: [] }) }
					: { code: 1, stderr: "boom", stdout: "" };
			},
		);
		const m = await gatherStandupMaterials({
			exec: run,
			env: {},
			cwd: "/w",
			claudeBin: "claude",
			memoryBin: "yunomi-memory",
			partners: ["yukarin", "akarin"],
			githubOwner: "o",
			macState: openMacStateStore(tempDir()),
			now: () => NOW,
			logger: silentLogger,
		});
		expect(m.watches).toEqual([]);
		expect(m.memory).toEqual({ unavailable: "記憶 を取れなかった" });
	});

	it("Renovate の PR は repo ごとに CI とコンフリクトの状態を引く", async () => {
		const run = vi.fn(async (bin: string, args: readonly string[]) => {
			const line = `${bin} ${args.join(" ")}`;
			if (line.startsWith("gh search prs"))
				return {
					code: 0,
					stderr: "",
					stdout: JSON.stringify([
						{
							repository: { nameWithOwner: "o/a" },
							number: 5,
							title: "Update tooling",
							url: "u5",
							author: { login: "renovate[bot]" },
						},
					]),
				};
			if (line.includes("--author app/renovate"))
				return {
					code: 0,
					stderr: "",
					stdout: JSON.stringify([
						{
							number: 5,
							title: "Update tooling",
							url: "u5",
							headRefName: "renovate/tooling-non-major",
							mergeable: "CONFLICTING",
							mergeStateStatus: "DIRTY",
							statusCheckRollup: [
								{ status: "COMPLETED", conclusion: "SUCCESS" },
								{ state: "SUCCESS" },
							],
						},
						{
							number: 1,
							title: "Configure Renovate",
							url: "u1",
							headRefName: "renovate/configure",
						},
					]),
				};
			return { code: 0, stdout: "[]", stderr: "" };
		});
		const m = await gatherStandupMaterials({
			exec: run,
			env: {},
			cwd: "/w",
			claudeBin: "claude",
			memoryBin: "yunomi-memory",
			partners: ["yukarin"],
			githubOwner: "o",
			macState: openMacStateStore(tempDir()),
			now: () => NOW,
			logger: silentLogger,
		});
		expect(m.github.renovate_prs).toEqual([
			expect.objectContaining({
				repo: "o/a",
				number: 5,
				ci: "success",
				mergeable: "CONFLICTING",
				merge_state: "DIRTY",
				onboarding: false,
			}),
			expect.objectContaining({ number: 1, onboarding: true }),
		]);
	});
});

describe("watchesOf", () => {
	it("記憶の watches を取り出し、無ければ読めなかったことにする", () => {
		const w = {
			id: "w1",
			query: "q",
			sources: [],
			interval_minutes: 1440,
			until_at: null,
			last_checked_at: null,
			due: true,
			seen: [],
		};
		expect(watchesOf({ watches: [w] }, "akarin")).toEqual([
			{ ...w, schedule: null, notify_thread_id: null, partner: "akarin" },
		]);
		expect(watchesOf({ facts: [] }, "akarin")).toEqual({
			unavailable: "記憶の見張りを読めなかった",
		});
	});

	it("cron 式の見張りは間隔が null でも読む", () => {
		const w = {
			id: "w2",
			query: "q",
			sources: [],
			interval_minutes: null,
			schedule: "0 9-18 * * 1-5",
			until_at: null,
			last_checked_at: null,
			due: false,
			seen: [],
			notify_thread_id: null,
		};
		expect(watchesOf({ watches: [w] }, "yukarin")).toEqual([
			{ ...w, partner: "yukarin" },
		]);
	});
});

describe("goalsOf", () => {
	it("記憶の goals を取り出し、記憶が取れなければその印を引き継ぐ", () => {
		const g = {
			id: "g1",
			summary: "本を書く",
			created_at: "2026-11-06 12:00 JST",
		};
		expect(goalsOf({ facts: [], goals: [g] })).toEqual([g]);
		expect(goalsOf({ unavailable: "記憶 を取れなかった" })).toEqual({
			unavailable: "記憶 を取れなかった",
		});
	});
});

describe("ciOf", () => {
	it.each([
		[
			"全部通れば success",
			[
				{ status: "COMPLETED", conclusion: "SUCCESS" },
				{ status: "COMPLETED", conclusion: "SKIPPED" },
			],
			"success",
		],
		[
			"1 つでも落ちれば failure",
			[
				{ status: "IN_PROGRESS", conclusion: null },
				{ status: "COMPLETED", conclusion: "FAILURE" },
			],
			"failure",
		],
		[
			"走っているものがあれば pending",
			[{ status: "IN_PROGRESS", conclusion: null }, { state: "SUCCESS" }],
			"pending",
		],
		["StatusContext の失敗も見る", [{ state: "ERROR" }], "failure"],
	])("%s", (_name, rollup, want) => {
		expect(ciOf(rollup)).toBe(want);
	});
});

describe("startWatch", () => {
	const watch = (id: string, thread: string | null = null) => ({
		id,
		query: "RTX3090 の中古、24GB",
		sources: ["https://shop.example/gpu"],
		interval_minutes: 360,
		schedule: null,
		until_at: null,
		last_checked_at: "2026-11-05 08:00 JST",
		due: false,
		seen: [],
		notify_thread_id: thread,
		partner: "akarin",
	});

	it("due でなくても、その見張り 1 件だけを渡して見張りの席を立てる", async () => {
		const t = setup();
		const deps = { ...t.deps, watchThreads: new Map<string, WatchTarget>() };
		const read = vi.fn(async (_partner: string) => [
			watch("w1"),
			watch("w2", "777"),
		]);
		const start = vi.fn(async (_spec: string, _kind: string) => "watch-1");
		const id = await startWatch({
			deps,
			partner: "akarin",
			watchId: "w2",
			read,
			start,
		});
		expect(id).toBe("watch-1");
		expect(read).toHaveBeenCalledWith("akarin");
		const [spec, kind] = start.mock.calls[0] ?? [];
		expect(kind).toBe("watch");
		expect(spec).toContain('"id":"w2"');
		expect(spec).not.toContain('"id":"w1"');
		expect(spec).not.toContain("notify_thread_id");
		expect(deps.watchThreads.get("w2")).toEqual({
			threadId: "777",
			partner: "akarin",
		});
	});

	it("見張りの席は持ち主のパートナーが受け持つ", async () => {
		const start = vi.fn(
			async (_spec: string, _kind: string, _partner: string) => "watch-1",
		);
		await startWatch({
			deps: setup().deps,
			partner: "akarin",
			watchId: "w1",
			read: async () => [watch("w1")],
			start,
		});
		expect(start.mock.calls[0]?.[2]).toBe("akarin");
	});

	it("見張りの新着と決めてほしいことは、持ち主の bot で書き、投稿の担当にする", async () => {
		const t = setup();
		const akarin = fakeDiscord();
		const assigned: [string, string][] = [];
		const deps = {
			...t.deps,
			speakers: { akarin: akarin.api },
			assign: async (threadId: string, partner: string) => {
				assigned.push([threadId, partner]);
			},
			watchThreads: new Map<string, WatchTarget>(),
		};
		await startWatch({
			deps,
			partner: "akarin",
			watchId: "w2",
			read: async () => [watch("w2", "777")],
			start: async () => "watch-1",
		});
		await finishStandup(
			deps,
			'```json\n{"decisions": [{"title": "件1", "body": "本文1"}], "notices": [{"watch_id": "w2", "text": "A 店に出ていました"}, "B 店に出ていました"]}\n```',
			[],
			"watch",
			"akarin",
		);
		expect(akarin.sentTo("777")).toEqual(["A 店に出ていました"]);
		expect(akarin.sentTo(TEXT)).toEqual(["B 店に出ていました"]);
		expect(t.discord.sentTo("777")).toEqual([]);
		expect(akarin.posts).toHaveLength(1);
		expect(t.discord.posts).toEqual([]);
		expect(assigned.map(([, p]) => p)).toEqual(["akarin"]);
	});

	it("持ち主の bot が無ければ Yukarin の bot で書き、担当は決めない", async () => {
		const t = setup();
		const assign = vi.fn(async () => {});
		const deps = { ...t.deps, assign };
		await finishStandup(deps, decisionsReply(1), [], "watch", "akarin");
		expect(t.discord.posts).toHaveLength(1);
		expect(assign).not.toHaveBeenCalled();
	});

	it("記憶に無い見張りと、記憶を読めなかった回は席を立てない", async () => {
		const start = vi.fn(async (_spec: string, _kind: string) => "watch-1");
		for (const read of [
			async () => [watch("w1")],
			async () => ({ unavailable: "x" }),
		]) {
			expect(
				await startWatch({
					deps: setup().deps,
					partner: "yukarin",
					watchId: "w9",
					read,
					start,
				}),
			).toBeNull();
		}
		expect(start).not.toHaveBeenCalled();
	});

	it("見張りの報告の投稿には見張りの回と付ける", async () => {
		const t = setup();
		await finishStandup(t.deps, decisionsReply(1), [], "watch");
		expect(t.discord.posts[0]?.content).toContain("の見張りから");
	});
});
