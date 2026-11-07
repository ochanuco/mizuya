import * as v from "valibot";
import { toModelJson } from "./lib/core.ts";
import type { Logger } from "./logger.ts";
import type { PatrolSnapshot, PatrolStore } from "./patrol.ts";
import { eventPrompt } from "./prompts.ts";

const text = v.string();
const repo = v.pipe(v.string(), v.nonEmpty());
const number = v.pipe(v.number(), v.integer(), v.minValue(1));

/**
 * mizuya の Worker が webhook の payload から抜き出した、席の材料になる分だけの形。受け箱の行の body として届く。
 * 形は Worker の `work-events.ts` と揃える。
 */
export const githubWorkEventSchema = v.variant("kind", [
	v.object({
		kind: v.literal("ci_failed"),
		repo,
		/** 落ちた run が属する PR。main など PR の無い branch なら空。 */
		prs: v.array(number),
		name: text,
		branch: v.nullable(text),
		conclusion: text,
		url: text,
		actor: v.nullable(text),
	}),
	v.object({
		kind: v.literal("review"),
		repo,
		pr: number,
		title: text,
		state: text,
		body: text,
		url: text,
		actor: text,
		actor_is_bot: v.boolean(),
	}),
	v.object({
		kind: v.literal("comment"),
		repo,
		number,
		is_pr: v.boolean(),
		title: text,
		body: text,
		url: text,
		actor: text,
		actor_is_bot: v.boolean(),
	}),
]);

export type GithubWorkEvent = v.InferOutput<typeof githubWorkEventSchema>;

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
			eventPrompt({
				now,
				materials: toModelJson({ subject, events: group }),
			}),
			"event",
		);
		log.info("github event seat started", { seat: id, subject });
		seats.push(id);
	}
	return seats;
};

/**
 * 受け箱から届いた出来事を、少し待ってからまとめて回す。同じ PR の CI の失敗とレビューが続けて届いても、一つの席にまとめる。
 * 前のまとまりを回している間に届いたものは、次のまとまりに入る。
 */
export const createGithubEventBatcher = (deps: {
	run: (events: GithubWorkEvent[]) => Promise<void>;
	waitMs: number;
	logger: Logger;
}): { push: (event: GithubWorkEvent) => void; stop: () => void } => {
	let pending: GithubWorkEvent[] = [];
	let timer: ReturnType<typeof setTimeout> | null = null;
	const flush = () => {
		timer = null;
		const events = pending;
		pending = [];
		void deps
			.run(events)
			.catch((e: unknown) =>
				deps.logger.error("github events crashed", { error: String(e) }),
			);
	};
	return {
		push: (event) => {
			pending.push(event);
			if (timer === null) {
				timer = setTimeout(flush, deps.waitMs);
				timer.unref?.();
			}
		},
		stop: () => {
			if (timer) clearTimeout(timer);
		},
	};
};
