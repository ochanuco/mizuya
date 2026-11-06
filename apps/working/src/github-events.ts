import * as v from "valibot";
import { err, ok, type Result, toModelJson } from "./lib/core.ts";
import {
	GITHUB_EVENTS_PATH,
	type GithubWorkEvent,
	githubEventsResponseSchema,
} from "./lib/protocol.ts";
import type { Logger } from "./logger.ts";
import type { PatrolSnapshot, PatrolStore } from "./patrol.ts";
import { eventPrompt, seatSpec } from "./prompts.ts";

export type GithubEventsClient = {
	/** Worker に溜まった出来事を取り出す。取り出した分は Worker から消える。 */
	claim: () => Promise<Result<GithubWorkEvent[], { reason: string }>>;
};

export const createGithubEventsClient = (opts: {
	baseUrl: string;
	clientId: string;
	clientSecret: string;
	fetch?: typeof fetch;
}): GithubEventsClient => {
	const doFetch = opts.fetch ?? fetch;
	const url = new URL(GITHUB_EVENTS_PATH, opts.baseUrl).toString();
	return {
		claim: async () => {
			let res: Response;
			try {
				res = await doFetch(url, {
					method: "POST",
					headers: {
						"CF-Access-Client-Id": opts.clientId,
						"CF-Access-Client-Secret": opts.clientSecret,
					},
					signal: AbortSignal.timeout(30_000),
				});
			} catch (e) {
				return err({ reason: `fetch: ${String(e)}` });
			}
			if (!res.ok) return err({ reason: `status ${res.status}` });
			const parsed = v.safeParse(
				githubEventsResponseSchema,
				await res.json().catch(() => null),
			);
			if (!parsed.success) return err({ reason: "unreadable" });
			return ok(parsed.output.events.map((e) => e.event));
		},
	};
};

/** 見回りの failing_prs と同じ key。席が拾った CI の失敗を、見回りがもう一度拾わないようにする。 */
const FAILING = "failing_prs";
const prKey = (repo: string, number: number) => `${repo}#${number}`;

/** 同じ PR や issue の出来事は一つの席にまとめる。 */
export const subjectOf = (e: GithubWorkEvent): string => {
	switch (e.kind) {
		case "ci_failed":
			return e.prs[0] !== undefined
				? prKey(e.repo, e.prs[0])
				: `${e.repo}@${e.branch ?? ""}`;
		case "review":
			return prKey(e.repo, e.pr);
		case "comment":
			return prKey(e.repo, e.number);
	}
};

/**
 * 席を立てる出来事を選び、見回りの snapshot に席が見た CI の失敗を足す。
 * - 自分（Working の GitHub アカウント）の書いたコメントやレビューで席を立てると、席が書くたびに次の席が立つ。
 * - bot のコメントやレビュー（Renovate など）は数が多く、見回りが PR の状態として見る。
 * - CI の失敗は、見回りが同じ PR の失敗をもう見ていれば、その件はもう扱われている。
 */
export const selectEvents = (
	events: readonly GithubWorkEvent[],
	input: { selfLogin: string | null; snapshot: PatrolSnapshot },
): { events: GithubWorkEvent[]; snapshot: PatrolSnapshot } => {
	const failing = { ...(input.snapshot[FAILING] ?? {}) };
	const picked = events.filter((e) => {
		if (e.kind === "ci_failed") {
			const keys = e.prs.map((n) => prKey(e.repo, n));
			if (keys.length > 0 && keys.every((k) => k in failing)) return false;
			for (const k of keys) failing[k] = "";
			return true;
		}
		// 自分が分からなければ、席の書いたものを見分けられないので拾わない
		if (e.actor_is_bot || input.selfLogin === null) return false;
		return e.actor !== input.selfLogin;
	});
	return {
		events: picked,
		snapshot: { ...input.snapshot, [FAILING]: failing },
	};
};

export type EventRunDeps = {
	store: PatrolStore;
	preamble: string;
	selfLogin: string | null;
	start: (spec: string, kind: "event") => Promise<string>;
	now?: () => Date;
	logger: Logger;
};

/**
 * 受けた出来事を、件ごとに小さな席で回す。席は見回りと同じく、判断が要るものだけを決めてほしいことで返す。
 * 見回りと snapshot を取り合わないよう、呼び出し側が見回りと同じ列に並べる。
 */
export const runGithubEvents = async (
	deps: EventRunDeps,
	events: readonly GithubWorkEvent[],
): Promise<string[]> => {
	const log = deps.logger;
	if (events.length === 0) return [];
	const prev = await deps.store.load();
	const selected = selectEvents(events, {
		selfLogin: deps.selfLogin,
		snapshot: prev ?? {},
	});
	// 見回りがまだ一度も回っていなければ、snapshot を作ると見回りの初回が全部を新着と見る。作るのは見回りに任せる
	if (prev !== null) await deps.store.save(selected.snapshot);
	log.info("github events", {
		received: events.length,
		selected: selected.events.length,
	});

	const bySubject = new Map<string, GithubWorkEvent[]>();
	for (const e of selected.events) {
		const key = subjectOf(e);
		bySubject.set(key, [...(bySubject.get(key) ?? []), e]);
	}
	const now = (deps.now ?? (() => new Date()))();
	const seats: string[] = [];
	for (const [subject, group] of bySubject) {
		const id = await deps.start(
			seatSpec(
				deps.preamble,
				eventPrompt({
					now,
					materials: toModelJson({ subject, events: group }),
				}),
			),
			"event",
		);
		log.info("github event seat started", { seat: id, subject });
		seats.push(id);
	}
	return seats;
};

/** Worker に溜まった出来事を間隔ごとに取りに行く。1 回が終わってから次を予約するので重ならない。 */
export const startGithubEventPoller = (deps: {
	client: GithubEventsClient;
	run: (events: GithubWorkEvent[]) => Promise<void>;
	intervalMs: number;
	logger: Logger;
}): { stop: () => void } => {
	let timer: ReturnType<typeof setTimeout> | null = null;
	let stopped = false;
	const tick = async () => {
		const claimed = await deps.client.claim();
		if (!claimed.ok) {
			deps.logger.warn("github events claim failed", {
				reason: claimed.error.reason,
			});
			return;
		}
		if (claimed.value.length > 0) await deps.run(claimed.value);
	};
	const schedule = () => {
		if (stopped) return;
		timer = setTimeout(() => {
			void tick()
				.catch((e: unknown) =>
					deps.logger.error("github events crashed", { error: String(e) }),
				)
				.finally(schedule);
		}, deps.intervalMs);
	};
	schedule();
	return {
		stop: () => {
			stopped = true;
			if (timer) clearTimeout(timer);
		},
	};
};
