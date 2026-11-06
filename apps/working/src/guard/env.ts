// hook として node で直接動かすため、node の組み込み以外を import しない。
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { GuardRun } from "./decide.ts";
import type { Operation } from "./operation.ts";

/**
 * start.sh が orca serve に渡し、席の Claude と hook が受け継ぐ環境変数。
 * 席は orca serve が起動するので、席ごとの値（投稿や許可）は環境変数ではなく席の場所とファイルで渡す。
 */
export const GUARD_ENV = {
	stateDir: "YUNOMI_STATE_DIR",
	seatsDir: "YUNOMI_SEATS_DIR",
} as const;

/** 席の worktree の名前。投稿の ID をそのまま入れ、hook は名前から投稿を引く。 */
export const SEAT_PREFIX = "seat-";
export const seatNameOf = (threadId: string) => `${SEAT_PREFIX}${threadId}`;

export const guardDirOf = (stateDir: string) => join(stateDir, "guard");

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/** 受付が書く、持ち主が 1 回だけ許可した操作。 */
export type GrantFile = { grant_id: string; operations: Operation[] };
export const grantPathOf = (guardDir: string, threadId: string) =>
	join(guardDir, "grants", `${SAFE_ID.test(threadId) ? threadId : "_"}.json`);

const readGrant = (path: string): GrantFile | null => {
	try {
		const v: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof v !== "object" || v === null) return null;
		const g = v as Partial<GrantFile>;
		if (typeof g.grant_id !== "string" || !Array.isArray(g.operations))
			return null;
		return {
			grant_id: g.grant_id,
			operations: g.operations.filter(
				(x): x is Operation =>
					typeof x === "object" &&
					x !== null &&
					typeof (x as Operation).tool === "string" &&
					typeof (x as Operation).target === "string",
			),
		};
	} catch {
		return null;
	}
};

/** 席の中なら、席の worktree の根と投稿の ID。席の外なら null。 */
export const seatOf = (
	seatsDir: string,
	dir: string,
): { root: string; threadId: string } | null => {
	const rel = relative(seatsDir, dir);
	if (rel === "" || rel.startsWith("..") || rel.startsWith("/")) return null;
	const name = rel.split("/")[0] ?? "";
	if (!name.startsWith(SEAT_PREFIX)) return null;
	const threadId = name.slice(SEAT_PREFIX.length);
	if (!SAFE_ID.test(threadId)) return null;
	return { root: join(seatsDir, name), threadId };
};

/**
 * hook の判断の材料。席の中で動いているなら、作業場所はその席の worktree、止めた操作はその投稿に紐づける。
 * 席の外（コンテナで人が claude を開いたときなど）は ~/work を作業場所にし、投稿には紐づけない。
 */
export const guardRunFromEnv = (
	env: Record<string, string | undefined>,
	projectDir?: string,
): GuardRun & { guardDir: string } => {
	const home = env.HOME ?? "/home/worker";
	const stateDir = env[GUARD_ENV.stateDir] ?? `${home}/state`;
	const claudeDir = env.CLAUDE_CONFIG_DIR ?? `${home}/.claude`;
	const codexDir = env.CODEX_HOME ?? `${home}/.codex`;
	const seatsDir = env[GUARD_ENV.seatsDir];
	const guardDir = guardDirOf(stateDir);
	// Codex は CLAUDE_PROJECT_DIR を持たず、hook の入力の cwd が席の中を指す
	const dir = env.CLAUDE_PROJECT_DIR ?? projectDir;
	const seat = seatsDir && dir ? seatOf(seatsDir, dir) : null;
	const grant = seat ? readGrant(grantPathOf(guardDir, seat.threadId)) : null;
	return {
		ctx: {
			workDir: seat?.root ?? `${home}/work`,
			home,
			protectedDirs: [
				claudeDir,
				`${home}/.claude.json`,
				codexDir,
				`${home}/.config`,
				`${home}/.ssh`,
				`${home}/.gitconfig`,
				`${home}/.git-credentials`,
				stateDir,
				"/etc/claude-code",
				"/etc/codex",
				"/opt/yunomi-guard",
				"/proc",
			],
			claudeProjectsDir: `${claudeDir}/projects`,
		},
		threadId: seat?.threadId ?? "_",
		grants: grant?.operations ?? [],
		grantId: grant?.grant_id ?? null,
		guardDir,
	};
};
