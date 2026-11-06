// hook として node で直接動かすため、node の組み込み以外を import しない。
import { join } from "node:path";

/** chabatake の repo-map.yaml を、受付が検証して STATE_DIR に置く写しの形。 */
export type RepoMapRepo = {
	name: string;
	description?: string;
	depends_on?: string[];
};
export type RepoMapSet = {
	name: string;
	description?: string;
	repos: RepoMapRepo[];
};
export type RepoMap = { sets: RepoMapSet[] };

export const repoMapPathOf = (stateDir: string) =>
	join(stateDir, "repo-map.json");

/** origin の URL の最後の要素。clone の場所によらず同じ名前になる。 */
export const repoNameOf = (originUrl: string): string | null => {
	const last = originUrl.trim().replace(/\/+$/, "").split(/[/:]/).pop() ?? "";
	const name = last.replace(/\.git$/, "");
	return name === "" ? null : name;
};

/** 手元にあるリポジトリ。here は作業ディレクトリそのものがそのリポジトリのとき。 */
export type LocalRepo = { name: string; path: string; here: boolean };

/** 手元のリポジトリのどれかを含むセットを、Mac の SessionStart hook と同じ書式で並べる。 */
export const renderRepoSets = (map: RepoMap, local: LocalRepo[]): string => {
	const byName = new Map<string, LocalRepo>();
	for (const r of local) if (!byName.has(r.name)) byName.set(r.name, r);
	const lines: string[] = [];
	for (const set of map.sets) {
		if (!set.repos.some((r) => byName.has(r.name))) continue;
		lines.push(
			`## 関連リポジトリセット: ${set.name}${set.description ? ` — ${set.description}` : ""}`,
		);
		for (const repo of set.repos) {
			const mine = byName.get(repo.name);
			lines.push(
				`- ${repo.name}${mine?.here ? " (このリポジトリ)" : ""}${repo.description ? `: ${repo.description}` : ""}${repo.depends_on?.length ? ` [depends_on: ${repo.depends_on.join(", ")}]` : ""}${mine ? ` <${mine.path}>` : ""}`,
			);
		}
	}
	return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
};
