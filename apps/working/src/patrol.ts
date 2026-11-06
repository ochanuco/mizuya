import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as v from "valibot";
import { failed, type StandupMaterials } from "./standup-materials.ts";

/**
 * 見回りが見張る件。fingerprint が変われば「変わった」と見る。
 * 席が PR にコメントするだけで updated_at は動くので、時刻ではなく判断が変わる状態だけを fingerprint にする。
 */
export type PatrolItem = { key: string; fingerprint: string; item: unknown };

export type PatrolSource = {
	name: string;
	/** null なら今回は取れなかった。前の回の分を残し、次に取れたときに全部を新着と見ない。 */
	items: PatrolItem[] | null;
	/** 一部だけ取れなかったとき、この接頭辞の key は前の回の分を残す。 */
	keepPrefixes?: string[];
};

/** source ごとに key → fingerprint。 */
export type PatrolSnapshot = Record<string, Record<string, string>>;

const prKey = (p: { repo: string; number: number }) => `${p.repo}#${p.number}`;

/**
 * 朝会と見回りが見る件。GitHub の件と持ち主の目標。
 * 記憶のほかの部分や Mac の席は変わり続けるので、見張りには入れず材料として渡す。
 */
export const patrolSources = (m: StandupMaterials): PatrolSource[] => {
	const g = m.github;
	const renovate = failed(g.renovate_prs) ? null : g.renovate_prs;
	return [
		{
			// 足された目標だけを拾う。閉じた目標は消えるだけで、見回りを立てる理由にならない
			name: "goals",
			items: failed(m.goals)
				? null
				: m.goals.map((goal) => ({
						key: goal.id,
						fingerprint: "",
						item: goal,
					})),
		},
		{
			name: "open_prs",
			items: failed(g.open_prs)
				? null
				: g.open_prs.map((p) => ({
						key: prKey(p),
						fingerprint: p.draft ? "draft" : "ready",
						item: p,
					})),
		},
		{
			name: "failing_prs",
			items: failed(g.failing_prs)
				? null
				: g.failing_prs.map((p) => ({
						key: prKey(p),
						fingerprint: "",
						item: p,
					})),
		},
		{
			name: "handoffs",
			items: failed(g.handoffs)
				? null
				: g.handoffs.map((h) => ({
						key: prKey(h),
						fingerprint: h.picked ? "picked" : "open",
						item: h,
					})),
		},
		{
			name: "working_prs",
			items: failed(g.working_prs)
				? null
				: g.working_prs.map((p) => ({
						key: prKey(p),
						fingerprint: p.draft ? "draft" : "ready",
						item: p,
					})),
		},
		{
			name: "renovate_prs",
			items:
				renovate === null
					? null
					: renovate.flatMap((p) =>
							"unavailable" in p
								? []
								: [
										{
											key: prKey(p),
											fingerprint: `${p.ci}/${p.mergeable}/${p.merge_state}`,
											item: p,
										},
									],
						),
			keepPrefixes:
				renovate === null
					? []
					: renovate.flatMap((p) => ("unavailable" in p ? [`${p.repo}#`] : [])),
		},
	];
};

/** 前の回から新しく出た件と状態が変わった件を拾い、今回の snapshot を作る。消えた件は忘れるので、また出れば新着になる。 */
export const diffPatrol = (
	prev: PatrolSnapshot,
	sources: readonly PatrolSource[],
): { changes: Record<string, unknown[]>; next: PatrolSnapshot } => {
	const changes: Record<string, unknown[]> = {};
	const next: PatrolSnapshot = {};
	for (const s of sources) {
		const before = prev[s.name] ?? {};
		if (s.items === null) {
			next[s.name] = before;
			continue;
		}
		const now: Record<string, string> = {};
		for (const [key, fp] of Object.entries(before)) {
			if (s.keepPrefixes?.some((p) => key.startsWith(p))) now[key] = fp;
		}
		const changed: unknown[] = [];
		for (const i of s.items) {
			now[i.key] = i.fingerprint;
			if (before[i.key] !== i.fingerprint) changed.push(i.item);
		}
		next[s.name] = now;
		if (changed.length > 0) changes[s.name] = changed;
	}
	return { changes, next };
};

const snapshotSchema = v.record(v.string(), v.record(v.string(), v.string()));

export type PatrolStore = {
	/** 前の回の snapshot。まだ回したことがなければ null。 */
	load: () => Promise<PatrolSnapshot | null>;
	save: (snapshot: PatrolSnapshot) => Promise<void>;
};

/** 再起動しても同じ件を二度投稿しないよう、volume に置く。 */
export const openPatrolStore = (dir: string): PatrolStore => {
	const path = join(dir, "patrol-state.json");
	return {
		load: async () => {
			const raw = await readFile(path, "utf8").catch(() => null);
			if (raw === null) return null;
			let json: unknown;
			try {
				json = JSON.parse(raw);
			} catch {
				return null;
			}
			const parsed = v.safeParse(snapshotSchema, json);
			return parsed.success ? parsed.output : null;
		},
		save: async (snapshot) => {
			await mkdir(dir, { recursive: true });
			const tmp = `${path}.tmp`;
			await writeFile(tmp, JSON.stringify(snapshot));
			await rename(tmp, path);
		},
	};
};
