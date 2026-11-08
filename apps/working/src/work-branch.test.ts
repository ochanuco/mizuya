import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { spawnExec } from "./exec.ts";
import { err, ok } from "./lib/core.ts";
import { silentLogger } from "./logger.ts";
import { fakeHishaku, tempDir } from "./test-support.ts";
import {
	createFindWorkBranches,
	recordWorkBranch,
	recordWorkBranchQuietly,
	repoOfUrl,
} from "./work-branch.ts";

const gitEnv: Record<string, string> = {
	PATH: process.env.PATH ?? "",
	HOME: tempDir("work-branch-home-"),
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "test",
	GIT_AUTHOR_EMAIL: "test@example.com",
	GIT_COMMITTER_NAME: "test",
	GIT_COMMITTER_EMAIL: "test@example.com",
};

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, env: gitEnv, stdio: "pipe" }).toString();

/** file:// の origin を持つ本物の clone を席の worktree の直下に作る。 */
const seat = () => {
	const root = tempDir("work-branch-");
	const dir = join(root, "seat");
	mkdirSync(dir);
	const clone = (
		repo: string,
		opts: { branch?: string; base?: string } = {},
	) => {
		const base = opts.base ?? "main";
		const src = join(root, "src", repo);
		mkdirSync(src, { recursive: true });
		git(src, "init", "--quiet", "--initial-branch", base);
		git(src, "commit", "--quiet", "--allow-empty", "-m", "init");
		const remote = join(root, "remotes", `${repo}.git`);
		git(root, "clone", "--quiet", "--bare", src, remote);
		const name = repo.split("/").at(-1) ?? repo;
		git(dir, "clone", "--quiet", `file://${remote}`, name);
		if (opts.branch)
			git(join(dir, name), "switch", "--quiet", "-c", opts.branch);
		return join(dir, name);
	};
	return { dir, clone };
};

const find = createFindWorkBranches({ exec: spawnExec, env: gitEnv });

describe("repoOfUrl", () => {
	it("https・ssh・file の URL から owner/repo を取る", () => {
		expect(repoOfUrl("https://github.com/example/app.git")).toBe("example/app");
		expect(repoOfUrl("git@github.com:example/app.git")).toBe("example/app");
		expect(repoOfUrl("file:///tmp/remotes/example/app.git")).toBe(
			"example/app",
		);
		expect(repoOfUrl("app")).toBeNull();
	});
});

describe("createFindWorkBranches", () => {
	it("既定のブランチのままの clone と .git の無いディレクトリは除く", async () => {
		const s = seat();
		s.clone("example/app", { branch: "dev/fix" });
		s.clone("example/lib");
		mkdirSync(join(s.dir, "notes"));
		expect(await find(s.dir)).toEqual([
			{ repo: "example/app", branch: "dev/fix" },
		]);
	});

	it("既定のブランチは origin/HEAD が指すもので見る", async () => {
		const s = seat();
		s.clone("example/app", { base: "trunk" });
		const main = s.clone("example/other", { base: "trunk", branch: "main" });
		expect(await find(s.dir)).toEqual([
			{ repo: "example/other", branch: "main" },
		]);
		// origin/HEAD が無ければ main と master を既定とみなす
		git(main, "remote", "set-head", "origin", "--delete");
		expect(await find(s.dir)).toEqual([]);
	});

	it("worktree が無ければ空", async () => {
		expect(await find(join(tempDir(), "missing"))).toEqual([]);
	});
});

describe("recordWorkBranch", () => {
	it("作業ブランチの clone が 1 つなら PATCH で書く", async () => {
		const s = seat();
		s.clone("example/app", { branch: "dev/fix" });
		const h = fakeHishaku();
		const r = await recordWorkBranch({
			hishaku: h.hishaku,
			number: 1234,
			dir: s.dir,
			find,
		});
		expect(r).toEqual(ok("written"));
		expect(h.opsOf("update")).toEqual([
			{ number: 1234, repo: "example/app", branch: "dev/fix" },
		]);
	});

	it("既定のブランチの clone だけなら書かない", async () => {
		const s = seat();
		s.clone("example/app");
		const h = fakeHishaku();
		const r = await recordWorkBranch({
			hishaku: h.hishaku,
			number: 1234,
			dir: s.dir,
			find,
		});
		expect(r).toEqual(ok("skipped"));
		expect(h.calls).toEqual([]);
	});

	it("作業ブランチの clone が 2 つなら書かない", async () => {
		const s = seat();
		s.clone("example/app", { branch: "dev/a" });
		s.clone("example/lib", { branch: "dev/b" });
		const h = fakeHishaku();
		const r = await recordWorkBranch({
			hishaku: h.hishaku,
			number: 1234,
			dir: s.dir,
			find,
		});
		expect(r).toEqual(ok("skipped"));
		expect(h.calls).toEqual([]);
	});

	it("meta に同じ値があれば PATCH を呼ばない", async () => {
		const s = seat();
		s.clone("example/app", { branch: "dev/fix" });
		const h = fakeHishaku();
		h.behavior.meta = () =>
			ok({
				holder: "box01",
				generation: 1,
				leaseExpiresAt: null,
				pushedAt: null,
				repo: "example/app",
				branch: "dev/fix",
			});
		const r = await recordWorkBranch({
			hishaku: h.hishaku,
			number: 1234,
			dir: s.dir,
			find,
		});
		expect(r).toEqual(ok("unchanged"));
		expect(h.opsOf("update")).toEqual([]);
	});

	it("PATCH の失敗は失敗として返し、quietly は投げない", async () => {
		const s = seat();
		s.clone("example/app", { branch: "dev/fix" });
		const h = fakeHishaku();
		h.behavior.update = () =>
			err({ type: "HishakuFailed", reason: "PATCH /v1/sessions/1234 503" });
		const input = { hishaku: h.hishaku, number: 1234, dir: s.dir, find };
		expect(await recordWorkBranch(input)).toEqual(
			err({ reason: "PATCH /v1/sessions/1234 503" }),
		);
		await expect(
			recordWorkBranchQuietly({
				...input,
				find: async () => {
					throw new Error("boom");
				},
				log: silentLogger,
				threadId: "p1",
			}),
		).resolves.toBeUndefined();
	});
});
