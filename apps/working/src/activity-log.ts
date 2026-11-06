import {
	appendFile,
	mkdir,
	readFile,
	rename,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import * as v from "valibot";
import type { DiscordApi } from "./discord-rest.ts";
import type { Exec } from "./exec.ts";
import { formatJst, PARTNER_IDS, type PartnerId } from "./lib/core.ts";
import type { Logger } from "./logger.ts";
import { nextStandupAt, type TimeOfDay } from "./standup-timer.ts";

/**
 * 席がしたことの 1 行。
 * - done / handoff: 席が完了・引き継ぎで閉じた
 * - blocked: 席の操作を hook が止め、持ち主に許可を求めた
 */
export type ActivityKind = "done" | "handoff" | "blocked";

export type ActivityEntry = {
	at: Date;
	kind: ActivityKind;
	threadId: string;
	title: string;
	partner: PartnerId;
	/** blocked のときの止めた道具の名前。対象（コマンドの本文など）は秘密を含みうるので残さない。 */
	tools: string[];
};

export type ActivityPr = {
	repo: string;
	number: number;
	title: string;
	url: string;
};

export type ActivityPrs = { merged: ActivityPr[]; opened: ActivityPr[] };

const entrySchema = v.object({
	at: v.number(),
	kind: v.picklist(["done", "handoff", "blocked"]),
	thread_id: v.string(),
	title: v.string(),
	partner: v.picklist(PARTNER_IDS),
	tools: v.optional(v.array(v.string()), []),
});

const stateSchema = v.object({ posted_until: v.number() });

const parseJson = (raw: string): unknown => {
	try {
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
};

export type ActivityLog = {
	record: (e: ActivityEntry) => Promise<void>;
	/** [from, to) の記録。 */
	between: (from: Date, to: Date) => Promise<ActivityEntry[]>;
	/** 前の回にまとめた範囲の終わり。まだまとめていなければ null。 */
	postedUntil: () => Promise<Date | null>;
	/** ここまでをまとめ終えたと残し、それより前の記録を捨てる。 */
	markPosted: (until: Date) => Promise<void>;
};

/**
 * 席が終わるたびに volume に 1 行ずつ足す。あとから記憶や Orca を集め直すより確かで、
 * 受付が落ちていた日も、次にまとめるときに前の回からの分をまとめて拾える。
 */
export const openActivityLog = (dir: string): ActivityLog => {
	const path = join(dir, "activity-log.jsonl");
	const statePath = join(dir, "activity-log-state.json");
	// 追記と、まとめたあとの書き直しが重ならないよう 1 本の列に並べる
	let queue: Promise<unknown> = Promise.resolve();
	const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
		const next = queue.then(fn, fn);
		queue = next.catch(() => undefined);
		return next;
	};

	const readAll = async (): Promise<ActivityEntry[]> => {
		const raw = await readFile(path, "utf8").catch(() => "");
		const out: ActivityEntry[] = [];
		for (const line of raw.split("\n")) {
			if (line.trim() === "") continue;
			const parsed = v.safeParse(entrySchema, parseJson(line));
			// 書きかけの行や読めない行は飛ばす
			if (!parsed.success) continue;
			const e = parsed.output;
			out.push({
				at: new Date(e.at),
				kind: e.kind,
				threadId: e.thread_id,
				title: e.title,
				partner: e.partner,
				tools: e.tools,
			});
		}
		return out;
	};

	const lineOf = (e: ActivityEntry) =>
		`${JSON.stringify({
			at: e.at.getTime(),
			kind: e.kind,
			thread_id: e.threadId,
			title: e.title,
			partner: e.partner,
			tools: e.tools,
		})}\n`;

	return {
		record: (e) =>
			enqueue(async () => {
				await mkdir(dir, { recursive: true });
				await appendFile(path, lineOf(e));
			}),
		between: (from, to) =>
			enqueue(async () =>
				(await readAll()).filter(
					(e) =>
						e.at.getTime() >= from.getTime() && e.at.getTime() < to.getTime(),
				),
			),
		postedUntil: async () => {
			const raw = await readFile(statePath, "utf8").catch(() => null);
			if (raw === null) return null;
			const parsed = v.safeParse(stateSchema, parseJson(raw));
			return parsed.success ? new Date(parsed.output.posted_until) : null;
		},
		markPosted: (until) =>
			enqueue(async () => {
				await mkdir(dir, { recursive: true });
				const keep = (await readAll()).filter(
					(e) => e.at.getTime() >= until.getTime(),
				);
				await writeFile(`${path}.tmp`, keep.map(lineOf).join(""));
				await rename(`${path}.tmp`, path);
				await writeFile(
					`${statePath}.tmp`,
					JSON.stringify({ posted_until: until.getTime() }),
				);
				await rename(`${statePath}.tmp`, statePath);
			}),
	};
};

const PARTNER_NAME: Record<PartnerId, string> = {
	yukarin: "Yukarin",
	akarin: "Akarin",
};

const toolCounts = (tools: readonly string[]) => {
	const counts = new Map<string, number>();
	for (const t of tools) counts.set(t, (counts.get(t) ?? 0) + 1);
	return [...counts].map(([t, n]) => `${t} ${n} 件`).join("、");
};

// Discord が URL ごとにプレビューを広げて投稿が長くなるので、<> で包んで止める
const prLine = (p: ActivityPr) =>
	`- ${p.repo}#${p.number} ${p.title} <${p.url}>`;

/** 1 日分の活動ログの本文。何もなければ null。prs が null なら PR を取れなかった。 */
export const formatActivityLog = (input: {
	until: Date;
	entries: readonly ActivityEntry[];
	prs: ActivityPrs | null;
}): string | null => {
	const { entries, prs } = input;
	const noPrs = prs === null || prs.merged.length + prs.opened.length === 0;
	if (entries.length === 0 && noPrs) return null;

	const sections: string[] = [];
	const threadLine = (e: ActivityEntry) =>
		`- 「${e.title}」（${PARTNER_NAME[e.partner]}）`;
	const section = (heading: string, lines: string[]) => {
		if (lines.length > 0) sections.push(`${heading}\n${lines.join("\n")}`);
	};
	section(
		"終えた仕事",
		entries.filter((e) => e.kind === "done").map(threadLine),
	);
	section(
		"Mac に引き継いだ仕事",
		entries.filter((e) => e.kind === "handoff").map(threadLine),
	);
	// 同じ投稿で何度止めても 1 行にまとめる
	const blocked = new Map<string, ActivityEntry & { all: string[] }>();
	for (const e of entries.filter((x) => x.kind === "blocked")) {
		const prev = blocked.get(e.threadId);
		blocked.set(e.threadId, {
			...e,
			all: [...(prev?.all ?? []), ...e.tools],
		});
	}
	section(
		"止められた操作",
		[...blocked.values()].map((e) =>
			`${threadLine(e)} ${toolCounts(e.all)}`.trimEnd(),
		),
	);
	if (prs === null) {
		sections.push("PR は取れなかった");
	} else {
		section("マージされた PR", prs.merged.map(prLine));
		section("出した PR", prs.opened.map(prLine));
	}
	return `${formatJst(input.until).slice(0, 10)} の活動ログ\n\n${sections.join("\n\n")}`;
};

const searchSchema = v.array(
	v.object({ repository: v.object({ nameWithOwner: v.string() }) }),
);
const repoPrSchema = v.array(
	v.object({
		number: v.number(),
		title: v.string(),
		url: v.string(),
		headRefName: v.string(),
		createdAt: v.string(),
		mergedAt: v.nullish(v.string()),
	}),
);

const REPO_LIMIT = 20;

/**
 * [since, until) にマージされた PR と出した PR。Working が出す PR は GH_TOKEN の人が dev/ ブランチから出したもの。
 * search は head を返さないので、更新のあった repo を search で拾い、repo ごとに引き直す。
 */
export const gatherActivityPrs = async (deps: {
	exec: Exec;
	env: Record<string, string>;
	cwd: string;
	owner: string;
	since: Date;
	until: Date;
	logger: Logger;
}): Promise<ActivityPrs | null> => {
	const run = async <T>(
		args: readonly string[],
		schema: v.GenericSchema<unknown, T>,
	): Promise<T | null> => {
		const out = await deps.exec("gh", args, {
			stdin: "",
			cwd: deps.cwd,
			timeoutMs: 60_000,
			env: deps.env,
		});
		if (out.code !== 0) {
			deps.logger.warn("activity log gh failed", {
				code: out.code,
				stderr: out.stderr.slice(0, 300),
			});
			return null;
		}
		const parsed = v.safeParse(schema, parseJson(out.stdout));
		if (!parsed.success) {
			deps.logger.warn("activity log gh unreadable");
			return null;
		}
		return parsed.output;
	};
	const since = deps.since.toISOString();
	const found = await run(
		[
			"search",
			"prs",
			"--owner",
			deps.owner,
			"--author",
			"@me",
			"--updated",
			`>=${since}`,
			"--json",
			"repository",
			"--limit",
			"100",
		],
		searchSchema,
	);
	if (found === null) return null;
	const repos = [
		...new Set(found.map((p) => p.repository.nameWithOwner)),
	].slice(0, REPO_LIMIT);
	const within = (iso: string | null | undefined) => {
		if (!iso) return false;
		const t = new Date(iso).getTime();
		return t >= deps.since.getTime() && t < deps.until.getTime();
	};
	const merged: ActivityPr[] = [];
	const opened: ActivityPr[] = [];
	for (const repo of repos) {
		const prs = await run(
			[
				"pr",
				"list",
				"--repo",
				repo,
				"--author",
				"@me",
				"--state",
				"all",
				"--search",
				`updated:>=${since}`,
				"--json",
				"number,title,url,headRefName,createdAt,mergedAt",
				"--limit",
				"50",
			],
			repoPrSchema,
		);
		if (prs === null) return null;
		for (const p of prs) {
			if (!p.headRefName.startsWith("dev/")) continue;
			const pr = { repo, number: p.number, title: p.title, url: p.url };
			if (within(p.mergedAt)) merged.push(pr);
			else if (within(p.createdAt)) opened.push(pr);
		}
	}
	return { merged, opened };
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** 前の回からいままでの分を 1 投稿にまとめる。何もなければ投稿しない。 */
export const postActivityLog = async (deps: {
	log: ActivityLog;
	gatherPrs: (since: Date, until: Date) => Promise<ActivityPrs | null>;
	discord: DiscordApi;
	threadId: string;
	now: () => Date;
	logger: Logger;
}): Promise<void> => {
	const until = deps.now();
	const since =
		(await deps.log.postedUntil()) ?? new Date(until.getTime() - DAY_MS);
	const entries = await deps.log.between(since, until);
	const prs = await deps.gatherPrs(since, until);
	const text = formatActivityLog({ until, entries, prs });
	if (text === null) {
		// PR を取れなかっただけなら、次の回に同じ範囲をもう一度見る
		if (prs !== null) await deps.log.markPosted(until);
		deps.logger.info("activity log skipped", {
			entries: entries.length,
			prs_unavailable: prs === null,
		});
		return;
	}
	const sent = await deps.discord.send(deps.threadId, text);
	if (!sent.ok) {
		deps.logger.error("activity log post failed", { error: sent.error.type });
		return;
	}
	await deps.log.markPosted(until);
	deps.logger.info("activity log posted", {
		entries: entries.length,
		merged: prs?.merged.length ?? null,
		opened: prs?.opened.length ?? null,
	});
};

/** 毎日 `at`（JST）に 1 回 run を呼ぶ。1 回が終わってから次を予約する。 */
export const startDailyTimer = (deps: {
	at: TimeOfDay;
	run: () => Promise<void>;
	now?: () => Date;
	setTimer?: (fn: () => void, ms: number) => { cancel: () => void };
	logger: Logger;
}): { stop: () => void } => {
	const now = deps.now ?? (() => new Date());
	const setTimer =
		deps.setTimer ??
		((fn, ms) => {
			const t = setTimeout(fn, ms);
			return { cancel: () => clearTimeout(t) };
		});
	let current: { cancel: () => void } | null = null;
	let stopped = false;
	const schedule = () => {
		if (stopped) return;
		const at = nextStandupAt(now(), deps.at);
		deps.logger.info("activity log scheduled", { at: at.getTime() });
		current = setTimer(
			() => {
				void deps
					.run()
					.catch((e: unknown) =>
						deps.logger.error("activity log crashed", { error: String(e) }),
					)
					.finally(schedule);
			},
			Math.max(0, at.getTime() - now().getTime()),
		);
	};
	schedule();
	return {
		stop: () => {
			stopped = true;
			current?.cancel();
		},
	};
};
