import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Exec } from "../exec.ts";
import { silentLogger } from "../logger.ts";
import { tempDir } from "../test-support.ts";
import { renderRepoSets, repoMapPathOf, repoNameOf } from "./render.ts";
import { parseRepoMap, REPO_MAP_SOURCE, syncRepoMap } from "./sync.ts";

const YAML = `
chimera:
  description: 画像を生成する一式
  repos:
    chagama:
      description: CLI と worker
      depends_on: [chimera]
    chimera:
yunomi:
  description: yunomi と周辺サービス
  repos:
    yunomi:
      description: 本体
      depends_on: [chatsumi, chimera]
    chatsumi:
      description: URL 取得
    chimera:
      description: 画像を読む
infra:
  repos: [chabatake, ochoko]
`;

const parsed = () => {
	const r = parseRepoMap(YAML);
	if (!r.ok) throw new Error(r.error.reason);
	return r.value;
};

describe("parseRepoMap", () => {
	it("セットとリポジトリを書かれた順に並べ、配列の repos も名前だけのリポジトリにする", () => {
		const map = parsed();
		expect(map.sets.map((s) => s.name)).toEqual(["chimera", "yunomi", "infra"]);
		expect(map.sets[0]?.repos).toEqual([
			{
				name: "chagama",
				description: "CLI と worker",
				depends_on: ["chimera"],
			},
			{ name: "chimera" },
		]);
		expect(map.sets[2]).toEqual({
			name: "infra",
			repos: [{ name: "chabatake" }, { name: "ochoko" }],
		});
	});

	it("形の違う地図と YAML として読めないものを不正とする", () => {
		expect(parseRepoMap("a:\n  description: x\n").ok).toBe(false);
		expect(parseRepoMap("a: [").ok).toBe(false);
	});
});

describe("repoNameOf", () => {
	it("origin の URL の最後の要素から .git を外す", () => {
		expect(repoNameOf("https://github.com/ochanuco/yunomi.git\n")).toBe(
			"yunomi",
		);
		expect(repoNameOf("git@github.com:ochanuco/chimera.git")).toBe("chimera");
		expect(repoNameOf("ssh://git@github.com/ochanuco/chatsumi")).toBe(
			"chatsumi",
		);
		expect(repoNameOf("")).toBeNull();
	});
});

describe("renderRepoSets", () => {
	it("手元のリポジトリを含むセットだけを、Mac の hook と同じ書式で出す", () => {
		const out = renderRepoSets(parsed(), [
			{ name: "yunomi", path: "/w/seat", here: true },
		]);
		expect(out).toBe(
			[
				"## 関連リポジトリセット: yunomi — yunomi と周辺サービス",
				"- yunomi (このリポジトリ): 本体 [depends_on: chatsumi, chimera] </w/seat>",
				"- chatsumi: URL 取得",
				"- chimera: 画像を読む",
				"",
			].join("\n"),
		);
	});

	it("複数のセットに入るリポジトリは、そのすべてのセットを出し、clone の場所を添える", () => {
		const out = renderRepoSets(parsed(), [
			{ name: "chimera", path: "/w/seat/chimera", here: false },
		]);
		expect(out).toContain(
			"## 関連リポジトリセット: chimera — 画像を生成する一式",
		);
		expect(out).toContain("- chimera </w/seat/chimera>");
		expect(out).toContain(
			"## 関連リポジトリセット: yunomi — yunomi と周辺サービス",
		);
		expect(out).toContain("- chimera: 画像を読む </w/seat/chimera>");
		expect(out).not.toContain("infra");
	});

	it("説明の無いセットは見出しに説明を付けない", () => {
		const out = renderRepoSets(parsed(), [
			{ name: "ochoko", path: "/w/o", here: true },
		]);
		expect(out).toBe(
			"## 関連リポジトリセット: infra\n- chabatake\n- ochoko (このリポジトリ) </w/o>\n",
		);
	});

	it("どのセットにも入らなければ何も出さない", () => {
		expect(renderRepoSets(parsed(), [])).toBe("");
		expect(
			renderRepoSets(parsed(), [{ name: "other", path: "/x", here: true }]),
		).toBe("");
	});
});

const ghExec =
	(result: { code: number | null; stdout: string; stderr?: string }) =>
	(calls: string[][]): Exec =>
	async (bin, args) => {
		calls.push([bin, ...args]);
		return { stderr: "", ...result };
	};

describe("syncRepoMap", () => {
	const deps = (stateDir: string, exec: Exec) => ({
		exec,
		env: { GH_TOKEN: "t" },
		cwd: stateDir,
		stateDir,
		logger: silentLogger,
	});

	it("chabatake の main の repo-map.yaml を取り、検証した写しを置く", async () => {
		const dir = tempDir();
		const calls: string[][] = [];
		const done = await syncRepoMap(
			deps(dir, ghExec({ code: 0, stdout: YAML })(calls)),
		);
		expect(done).toBe(true);
		expect(calls[0]).toEqual([
			"gh",
			"api",
			"-H",
			"Accept: application/vnd.github.raw",
			`${REPO_MAP_SOURCE}?ref=main`,
		]);
		expect(JSON.parse(readFileSync(repoMapPathOf(dir), "utf8"))).toEqual(
			parsed(),
		);
	});

	it("取れなかったときと中身が不正なときは前の写しを残す", async () => {
		const dir = tempDir();
		writeFileSync(repoMapPathOf(dir), '{"sets":[]}');
		const failed = await syncRepoMap(
			deps(dir, ghExec({ code: 1, stdout: "", stderr: "HTTP 502" })([])),
		);
		const invalid = await syncRepoMap(
			deps(dir, ghExec({ code: 0, stdout: "a: [" })([])),
		);
		expect([failed, invalid]).toEqual([false, false]);
		expect(readFileSync(repoMapPathOf(dir), "utf8")).toBe('{"sets":[]}');
	});

	it("写しが無いまま取れなければ写しを作らない", async () => {
		const dir = tempDir();
		await syncRepoMap(deps(dir, ghExec({ code: null, stdout: "" })([])));
		expect(existsSync(repoMapPathOf(dir))).toBe(false);
	});
});

const HOOK = join(import.meta.dirname, "hook.ts");

const gitRepo = (dir: string, origin?: string) => {
	mkdirSync(dir, { recursive: true });
	execFileSync("git", ["init", "-q", dir]);
	if (origin)
		execFileSync("git", ["-C", dir, "remote", "add", "origin", origin]);
};

const runHook = (stateDir: string | null, cwd: string) =>
	spawnSync(process.execPath, [HOOK], {
		input: JSON.stringify({ hook_event_name: "SessionStart", cwd }),
		env: {
			PATH: process.env.PATH ?? "",
			...(stateDir && { YUNOMI_STATE_DIR: stateDir }),
		},
		encoding: "utf8",
		timeout: 30_000,
	});

describe("SessionStart hook", () => {
	it("席の作業場所の直下の clone を含むセットを、写しから出す", async () => {
		const state = tempDir();
		await syncRepoMap({
			exec: ghExec({ code: 0, stdout: YAML })([]),
			env: {},
			cwd: state,
			stateDir: state,
			logger: silentLogger,
		});
		const seat = tempDir();
		gitRepo(seat);
		gitRepo(join(seat, "chatsumi"), "https://github.com/ochanuco/chatsumi.git");
		mkdirSync(join(seat, "out"));
		const r = runHook(state, seat);
		expect(r.status).toBe(0);
		expect(r.stdout).toBe(
			[
				"## 関連リポジトリセット: yunomi — yunomi と周辺サービス",
				"- yunomi: 本体 [depends_on: chatsumi, chimera]",
				`- chatsumi: URL 取得 <${join(seat, "chatsumi")}>`,
				"- chimera: 画像を読む",
				"",
			].join("\n"),
		);
	});

	it("作業ディレクトリがリポジトリならこのリポジトリと書く", () => {
		const state = tempDir();
		writeFileSync(
			repoMapPathOf(state),
			JSON.stringify({ sets: [{ name: "s", repos: [{ name: "ochoko" }] }] }),
		);
		const repo = tempDir();
		gitRepo(repo, "git@github.com:ochanuco/ochoko.git");
		expect(runHook(state, repo).stdout).toBe(
			`## 関連リポジトリセット: s\n- ochoko (このリポジトリ) <${repo}>\n`,
		);
	}, 30_000);

	it("写しが無い・壊れている・STATE_DIR が無いときは何も出さずに終わる", () => {
		const repo = tempDir();
		gitRepo(repo, "https://github.com/ochanuco/yunomi.git");
		const missing = tempDir();
		const broken = tempDir();
		writeFileSync(repoMapPathOf(broken), "{");
		for (const state of [missing, broken, null]) {
			const r = runHook(state, repo);
			expect(r.status).toBe(0);
			expect(r.stdout).toBe("");
		}
	}, 30_000);
});
