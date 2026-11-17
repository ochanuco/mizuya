import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import type { Exec } from "./exec.ts";
import type { PartnerId } from "./lib/core.ts";
import type { Logger } from "./logger.ts";
import { repoOfUrl } from "./work-branch.ts";

/**
 * 席が出した PR に付ける label。chakai が AI の PR を見分けるのと同じ名前で、
 * 定義は chabatake（github/labels.tf）が持つ
 */
export const actorLabel = (partner: PartnerId) => `actor:${partner}`;

/** 席の worktree の直下の clone が出した PR に、席の人格の label を付ける。失敗は warn を残すだけで投げない。 */
export type LabelSeatPulls = (input: {
	threadId: string;
	dir: string;
	partner: PartnerId;
}) => Promise<void>;

const pullsSchema = v.array(
	v.object({
		number: v.number(),
		createdAt: v.string(),
		labels: v.array(v.object({ name: v.string() })),
	}),
);

const FALLBACK_DEFAULTS = ["main", "master"];
const MOVED = /^checkout: moving from (\S+) to (\S+)$/;
const REFLOG_AT = /@\{(\d+)\}$/;

/** clone の作業ブランチと、clone ができた時刻（秒）。 */
type CloneWork = { repo: string; branches: string[]; since: number };

export const createLabelSeatPulls = (opts: {
	exec: Exec;
	env: Record<string, string>;
	log: Logger;
	timeoutMs?: number;
}): LabelSeatPulls => {
	const run = async (bin: string, cwd: string, args: readonly string[]) => {
		const out = await opts.exec(bin, args, {
			stdin: "",
			cwd,
			timeoutMs: opts.timeoutMs ?? 30_000,
			env: opts.env,
		});
		return out;
	};
	const git = async (cwd: string, args: readonly string[]) => {
		// 席の clone は席の agent が作るので、受付と持ち主が違っても読むだけなら通す
		const out = await run("git", cwd, ["-c", "safe.directory=*", ...args]);
		return out.code === 0 ? out.stdout.trim() : null;
	};

	const inspect = async (clone: string): Promise<CloneWork | null> => {
		const url = await git(clone, ["remote", "get-url", "origin"]);
		const repo = url === null ? null : repoOfUrl(url);
		// 席がマージしてブランチを消し、既定のブランチに戻っていても拾えるよう、reflog の行き来も見る
		const reflog = await git(clone, [
			"log",
			"-g",
			"--date=unix",
			"--format=%gd%x09%gs",
			"HEAD",
		]);
		if (repo === null || !reflog) return null;
		const lines = reflog.split("\n");
		const oldest = lines.at(-1)?.split("\t")[0]?.match(REFLOG_AT)?.[1];
		if (oldest === undefined) return null;
		const head = await git(clone, [
			"symbolic-ref",
			"--quiet",
			"--short",
			"refs/remotes/origin/HEAD",
		]);
		const defaults = head?.startsWith("origin/")
			? [head.slice("origin/".length)]
			: FALLBACK_DEFAULTS;
		const heads =
			(await git(clone, [
				"for-each-ref",
				"--format=%(refname:short)",
				"refs/heads",
			])) ?? "";
		const names = new Set(heads.split("\n").filter(Boolean));
		for (const line of lines) {
			const moved = line.split("\t")[1]?.match(MOVED);
			if (moved?.[1]) names.add(moved[1]);
			if (moved?.[2]) names.add(moved[2]);
		}
		// detached HEAD の移動は commit の ID で残るので、ブランチとして扱わない
		const branches = [...names]
			.filter((n) => !defaults.includes(n) && !/^[0-9a-f]{7,40}$/.test(n))
			.sort();
		return { repo, branches, since: Number(oldest) };
	};

	const labelBranch = async (
		input: { threadId: string; dir: string; partner: PartnerId },
		work: CloneWork,
		branch: string,
	) => {
		const label = actorLabel(input.partner);
		// 席は持ち主の GH_TOKEN で PR を出す。持ち主が自分で出した PR や Renovate の PR を席が直しただけのときに
		// 付けないよう、持ち主が author で、clone ができた後に作られた PR だけにする
		const listed = await run("gh", input.dir, [
			"pr",
			"list",
			"--repo",
			work.repo,
			"--head",
			branch,
			"--author",
			"@me",
			"--state",
			"all",
			"--json",
			"number,createdAt,labels",
		]);
		if (listed.code !== 0) {
			opts.log.warn("seat pulls not listed", {
				thread_id: input.threadId,
				repo: work.repo,
				branch,
				stderr: listed.stderr.slice(0, 300),
			});
			return;
		}
		let json: unknown;
		try {
			json = JSON.parse(listed.stdout);
		} catch {
			json = null;
		}
		const pulls = v.safeParse(pullsSchema, json);
		if (!pulls.success) {
			opts.log.warn("seat pulls not listed", {
				thread_id: input.threadId,
				repo: work.repo,
				branch,
				stderr: "unexpected gh output",
			});
			return;
		}
		for (const pull of pulls.output) {
			if (Date.parse(pull.createdAt) < work.since * 1000) continue;
			if (pull.labels.some((l) => l.name === label)) continue;
			// label が repo に無ければ gh が失敗する。定義は chabatake が持つので、ここでは作らない
			const edited = await run("gh", input.dir, [
				"pr",
				"edit",
				String(pull.number),
				"--repo",
				work.repo,
				"--add-label",
				label,
			]);
			if (edited.code === 0) {
				opts.log.info("seat pull labeled", {
					thread_id: input.threadId,
					repo: work.repo,
					pr: pull.number,
					label,
				});
			} else {
				opts.log.warn("seat pull not labeled", {
					thread_id: input.threadId,
					repo: work.repo,
					pr: pull.number,
					label,
					stderr: edited.stderr.slice(0, 300),
				});
			}
		}
	};

	return async (input) => {
		try {
			let names: string[];
			try {
				names = readdirSync(input.dir, { withFileTypes: true })
					.filter(
						(e) =>
							e.isDirectory() && existsSync(join(input.dir, e.name, ".git")),
					)
					.map((e) => e.name)
					.sort();
			} catch {
				return;
			}
			for (const name of names) {
				const work = await inspect(join(input.dir, name));
				if (!work) continue;
				for (const branch of work.branches) {
					await labelBranch(input, work, branch);
				}
			}
		} catch (e) {
			opts.log.warn("seat pulls not labeled", {
				thread_id: input.threadId,
				reason: String(e).slice(0, 300),
			});
		}
	};
};
