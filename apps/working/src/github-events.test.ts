import { describe, expect, it, vi } from "vitest";
import {
	createGithubEventBatcher,
	type GithubWorkEvent,
	runGithubEvents,
	selectEvents,
} from "./github-events.ts";
import { silentLogger } from "./logger.ts";
import { diffPatrol, type PatrolSnapshot, type PatrolStore } from "./patrol.ts";

const ciFailed = (prs: number[], repo = "o/r"): GithubWorkEvent => ({
	kind: "ci_failed",
	repo,
	prs,
	name: "ci",
	branch: "dev/x",
	conclusion: "failure",
	url: "https://github.com/o/r/actions/runs/1",
	actor: "someone",
});

const comment = (
	actor: string,
	over: Partial<Extract<GithubWorkEvent, { kind: "comment" }>> = {},
): GithubWorkEvent => ({
	kind: "comment",
	repo: "o/r",
	number: 5,
	is_pr: true,
	title: "t",
	body: "b",
	url: "u",
	actor,
	actor_is_bot: false,
	...over,
});

const review = (pr: number): GithubWorkEvent => ({
	kind: "review",
	repo: "o/r",
	pr,
	title: "t",
	state: "changes_requested",
	body: "直して",
	url: "u",
	actor: "reviewer",
	actor_is_bot: false,
});

const memoryStore = (initial: PatrolSnapshot | null) => {
	const store: PatrolStore & { saved: PatrolSnapshot | null } = {
		saved: initial,
		load: async () => store.saved,
		save: async (s) => {
			store.saved = s;
		},
	};
	return store;
};

describe("selectEvents", () => {
	it("自分と bot のコメントでは席を立てない", () => {
		const { events } = selectEvents(
			[
				comment("working-me"),
				comment("renovate[bot]", { actor_is_bot: true }),
				comment("owner"),
			],
			{ selfLogin: "working-me", snapshot: {} },
		);
		expect(events.map((e) => "actor" in e && e.actor)).toEqual(["owner"]);
	});

	it("自分が分からなければコメントとレビューは拾わず、CI の失敗だけを拾う", () => {
		const { events } = selectEvents([comment("owner"), ciFailed([3])], {
			selfLogin: null,
			snapshot: {},
		});
		expect(events.map((e) => e.kind)).toEqual(["ci_failed"]);
	});

	it("見回りがもう見ている PR の CI の失敗は拾わず、新しい失敗は snapshot に足す", () => {
		const { events, snapshot } = selectEvents([ciFailed([1]), ciFailed([2])], {
			selfLogin: null,
			snapshot: {
				failing_prs: { "o/r#1": "" },
				open_prs: { "o/r#1": "ready" },
			},
		});
		expect(events).toEqual([ciFailed([2])]);
		expect(snapshot).toEqual({
			failing_prs: { "o/r#1": "", "o/r#2": "" },
			open_prs: { "o/r#1": "ready" },
		});
	});

	it("PR の無い CI の失敗（main など）は毎回拾う", () => {
		const { events } = selectEvents([ciFailed([])], {
			selfLogin: null,
			snapshot: { failing_prs: {} },
		});
		expect(events).toHaveLength(1);
	});
});

describe("runGithubEvents", () => {
	const run = async (
		store: ReturnType<typeof memoryStore>,
		events: GithubWorkEvent[],
	) => {
		const specs: string[] = [];
		const seats = await runGithubEvents(
			{
				store,
				selfLogin: "working-me",
				start: async (spec, kind) => {
					specs.push(spec);
					return `${kind}-${specs.length}`;
				},
				now: () => new Date("2026-11-06T06:00:00Z"),
				logger: silentLogger,
			},
			events,
		);
		return { seats, specs };
	};

	it("件ごとに 1 つの席を立て、席にはその件の出来事だけを渡す", async () => {
		const store = memoryStore({});
		const { seats, specs } = await run(store, [
			review(3),
			comment("owner", { number: 3 }),
			ciFailed([9]),
			comment("working-me"),
		]);
		expect(seats).toEqual(["event-1", "event-2"]);
		expect(specs[0]).toContain("o/r#3");
		expect(specs[0]).not.toContain("o/r#9");
		expect(specs[1]).toContain("o/r#9");
		expect(specs[0]).toContain("15:00");
	});

	it("席が拾った CI の失敗は、次の見回りで新着にならない", async () => {
		const store = memoryStore({ failing_prs: {} });
		await run(store, [ciFailed([7])]);
		const { changes } = diffPatrol(store.saved ?? {}, [
			{
				name: "failing_prs",
				items: [{ key: "o/r#7", fingerprint: "", item: { number: 7 } }],
			},
		]);
		expect(changes).toEqual({});
	});

	it("見回りがまだ回っていなければ snapshot を作らない（見回りの初回が全部を新着と見ないため）", async () => {
		const store = memoryStore(null);
		const { seats } = await run(store, [ciFailed([7])]);
		expect(seats).toHaveLength(1);
		expect(store.saved).toBeNull();
	});

	it("全部が見送りなら席を立てない", async () => {
		const { seats } = await run(memoryStore({}), [comment("working-me")]);
		expect(seats).toEqual([]);
	});
});

describe("createGithubEventBatcher", () => {
	it("待つ間に届いた出来事をまとめて 1 回で回す", async () => {
		vi.useFakeTimers();
		const runs: GithubWorkEvent[][] = [];
		const batcher = createGithubEventBatcher({
			run: async (events) => {
				runs.push(events);
			},
			waitMs: 30_000,
			logger: silentLogger,
		});
		batcher.push(ciFailed([3]));
		await vi.advanceTimersByTimeAsync(10_000);
		batcher.push(review(3));
		await vi.advanceTimersByTimeAsync(20_000);
		expect(runs).toEqual([[ciFailed([3]), review(3)]]);
		batcher.push(comment("someone"));
		await vi.advanceTimersByTimeAsync(30_000);
		expect(runs).toHaveLength(2);
		vi.useRealTimers();
	});
});
