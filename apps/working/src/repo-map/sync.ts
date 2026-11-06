import { rename, writeFile } from "node:fs/promises";
import * as v from "valibot";
import { parse } from "yaml";
import type { Exec } from "../exec.ts";
import { err, ok, type Result } from "../lib/core.ts";
import type { Logger } from "../logger.ts";
import { type RepoMap, repoMapPathOf } from "./render.ts";

/** 席の Claude が作業中のリポジトリの関係を知るための地図。task branch ではなくマージ済みのものを読む。 */
export const REPO_MAP_SOURCE =
	"repos/ochanuco/chabatake/contents/repo-map.yaml";
const REPO_MAP_REF = "main";

const RepoSchema = v.nullish(
	v.looseObject({
		description: v.optional(v.string()),
		depends_on: v.optional(v.array(v.string())),
	}),
);
const RepoMapSchema = v.record(
	v.string(),
	v.looseObject({
		description: v.optional(v.string()),
		repos: v.union([v.array(v.string()), v.record(v.string(), RepoSchema)]),
	}),
);

export type RepoMapError =
	| { type: "FetchFailed"; reason: string }
	| { type: "InvalidMap"; reason: string };

export const parseRepoMap = (text: string): Result<RepoMap, RepoMapError> => {
	let raw: unknown;
	try {
		raw = parse(text);
	} catch (e) {
		return err({ type: "InvalidMap", reason: String(e) });
	}
	const r = v.safeParse(RepoMapSchema, raw);
	if (!r.success) {
		return err({
			type: "InvalidMap",
			reason: r.issues.map((i) => i.message).join("; "),
		});
	}
	return ok({
		sets: Object.entries(r.output).map(([name, set]) => ({
			name,
			...(set.description !== undefined && { description: set.description }),
			repos: Array.isArray(set.repos)
				? set.repos.map((repo) => ({ name: repo }))
				: Object.entries(set.repos).map(([repo, meta]) => ({
						name: repo,
						...(meta?.description !== undefined && {
							description: meta.description,
						}),
						...(meta?.depends_on !== undefined && {
							depends_on: meta.depends_on,
						}),
					})),
		})),
	});
};

export const fetchRepoMap = async (deps: {
	exec: Exec;
	env: Record<string, string>;
	cwd: string;
}): Promise<Result<RepoMap, RepoMapError>> => {
	const out = await deps.exec(
		"gh",
		[
			"api",
			"-H",
			"Accept: application/vnd.github.raw",
			`${REPO_MAP_SOURCE}?ref=${REPO_MAP_REF}`,
		],
		{ stdin: "", cwd: deps.cwd, timeoutMs: 30_000, env: deps.env },
	);
	if (out.code !== 0) {
		return err({ type: "FetchFailed", reason: out.stderr.slice(0, 300) });
	}
	return parseRepoMap(out.stdout);
};

/**
 * 地図を取り直して STATE_DIR の写しを置き換える。取れなかったときは前の写しをそのまま残す。
 * hook が書きかけを読まないよう、別名で書いてから置き換える。
 */
export const syncRepoMap = async (deps: {
	exec: Exec;
	env: Record<string, string>;
	cwd: string;
	stateDir: string;
	logger: Logger;
}): Promise<boolean> => {
	const r = await fetchRepoMap(deps);
	if (!r.ok) {
		deps.logger.warn("repo map sync failed", {
			error: r.error.type,
			reason: r.error.reason,
		});
		return false;
	}
	const path = repoMapPathOf(deps.stateDir);
	const tmp = `${path}.tmp`;
	await writeFile(tmp, JSON.stringify(r.value));
	await rename(tmp, path);
	return true;
};

export const startRepoMapSync = (
	deps: Parameters<typeof syncRepoMap>[0] & { intervalMs: number },
) => {
	const run = () =>
		void syncRepoMap(deps).catch((e: unknown) => {
			deps.logger.error("repo map sync crashed", { error: String(e) });
		});
	run();
	const timer = setInterval(run, deps.intervalMs);
	return { stop: () => clearInterval(timer) };
};
