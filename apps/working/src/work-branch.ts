import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Exec } from "./exec.ts";
import type { Hishaku } from "./hishaku.ts";
import { err, ok, type Result } from "./lib/core.ts";
import type { Logger } from "./logger.ts";

/** 席の worktree の直下の clone と、その今のブランチ。 */
export type WorkBranch = { repo: string; branch: string };

/** 席の worktree の直下から、既定のブランチ以外にいる clone を集める。 */
export type FindWorkBranches = (dir: string) => Promise<readonly WorkBranch[]>;

const FALLBACK_DEFAULTS = ["main", "master"];

/** origin の URL（https・ssh・file）の末尾 2 つを `owner/repo` にする。 */
export const repoOfUrl = (url: string): string | null => {
	const m = url.trim().match(/([^/:]+)\/([^/]+?)(?:\.git)?\/?$/);
	return m ? `${m[1]}/${m[2]}` : null;
};

export const createFindWorkBranches = (opts: {
	exec: Exec;
	env: Record<string, string>;
	timeoutMs?: number;
}): FindWorkBranches => {
	const git = async (cwd: string, args: readonly string[]) => {
		// 席の clone は席の agent が作るので、受付と持ち主が違っても読むだけなら通す
		const out = await opts.exec("git", ["-c", "safe.directory=*", ...args], {
			stdin: "",
			cwd,
			timeoutMs: opts.timeoutMs ?? 10_000,
			env: opts.env,
		});
		return out.code === 0 ? out.stdout.trim() : null;
	};

	const inspect = async (clone: string): Promise<WorkBranch | null> => {
		const url = await git(clone, ["remote", "get-url", "origin"]);
		const repo = url === null ? null : repoOfUrl(url);
		// detached HEAD は作業ブランチとみなさない
		const branch = await git(clone, [
			"symbolic-ref",
			"--quiet",
			"--short",
			"HEAD",
		]);
		if (repo === null || !branch) return null;
		const head = await git(clone, [
			"symbolic-ref",
			"--quiet",
			"--short",
			"refs/remotes/origin/HEAD",
		]);
		const defaults = head?.startsWith("origin/")
			? [head.slice("origin/".length)]
			: FALLBACK_DEFAULTS;
		return defaults.includes(branch) ? null : { repo, branch };
	};

	return async (dir) => {
		let names: string[];
		try {
			names = readdirSync(dir, { withFileTypes: true })
				.filter((e) => e.isDirectory() && existsSync(join(dir, e.name, ".git")))
				.map((e) => e.name)
				.sort();
		} catch {
			return [];
		}
		const found = await Promise.all(names.map((n) => inspect(join(dir, n))));
		return found.filter((b): b is WorkBranch => b !== null);
	};
};

export type RecordOutcome = "written" | "unchanged" | "skipped";

/**
 * 席が作業した repo とブランチを hishaku の meta に書く。
 * 作業ブランチの clone がちょうど 1 つのときだけ書き、0 か 2 つ以上なら申し送り issue の経路に任せる。
 */
export const recordWorkBranch = async (opts: {
	hishaku: Hishaku;
	number: number;
	dir: string;
	find: FindWorkBranches;
}): Promise<Result<RecordOutcome, { reason: string }>> => {
	const found = await opts.find(opts.dir);
	const [only] = found;
	if (found.length !== 1 || only === undefined) return ok("skipped");
	const meta = await opts.hishaku.meta(opts.number);
	// meta を読めなくても書いてみる。同じ値を書き直しても害は無い
	if (
		meta.ok &&
		meta.value.repo === only.repo &&
		meta.value.branch === only.branch
	) {
		return ok("unchanged");
	}
	const r = await opts.hishaku.update(opts.number, only);
	return r.ok ? ok("written") : err({ reason: r.error.reason });
};

/** 席を止める流れから呼ぶ。失敗は warn を残すだけで、止める流れは止めない。 */
export const recordWorkBranchQuietly = async (
	opts: Parameters<typeof recordWorkBranch>[0] & {
		log: Logger;
		threadId: string;
	},
) => {
	try {
		const r = await recordWorkBranch(opts);
		if (!r.ok) {
			opts.log.warn("hishaku work branch not recorded", {
				thread_id: opts.threadId,
				number: opts.number,
				reason: r.error.reason,
			});
		} else if (r.value === "written") {
			opts.log.info("hishaku work branch recorded", {
				thread_id: opts.threadId,
				number: opts.number,
			});
		}
	} catch (e) {
		opts.log.warn("hishaku work branch not recorded", {
			thread_id: opts.threadId,
			number: opts.number,
			reason: String(e).slice(0, 300),
		});
	}
};
