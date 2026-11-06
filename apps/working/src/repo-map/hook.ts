// 席の Claude の SessionStart hook。受付が置いた repo-map の写しから、手元のリポジトリを含むセットを出す。
// 席の Claude は作業場所の中に clone するので、作業ディレクトリと、その直下の clone を手元のリポジトリとみなす。
// 地図が無い・読めないときは何も出さずに終わり、席の起動を止めない。
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type LocalRepo,
	type RepoMap,
	renderRepoSets,
	repoMapPathOf,
	repoNameOf,
} from "./render.ts";

const originName = (dir: string): string | null => {
	try {
		const url = execFileSync(
			"git",
			["-C", dir, "remote", "get-url", "origin"],
			{
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 5_000,
			},
		);
		return repoNameOf(url);
	} catch {
		return null;
	}
};

const localRepos = (cwd: string): LocalRepo[] => {
	const out: LocalRepo[] = [];
	const here = originName(cwd);
	if (here) out.push({ name: here, path: cwd, here: true });
	let entries: string[] = [];
	try {
		entries = readdirSync(cwd, { withFileTypes: true })
			.filter((e) => e.isDirectory() && !e.name.startsWith("."))
			.map((e) => e.name);
	} catch {
		return out;
	}
	for (const entry of entries) {
		const dir = join(cwd, entry);
		// .git の無いディレクトリで git を呼ぶと、親の作業ディレクトリの origin を拾う
		if (!existsSync(join(dir, ".git"))) continue;
		const name = originName(dir);
		if (name) out.push({ name, path: dir, here: false });
	}
	return out;
};

const readCwd = (): string => {
	try {
		const input: unknown = JSON.parse(readFileSync(0, "utf8"));
		const cwd = (input as { cwd?: unknown } | null)?.cwd;
		if (typeof cwd === "string" && cwd !== "") return cwd;
	} catch {}
	return process.cwd();
};

try {
	const stateDir = process.env.YUNOMI_STATE_DIR;
	if (stateDir) {
		const map = JSON.parse(
			readFileSync(repoMapPathOf(stateDir), "utf8"),
		) as RepoMap;
		if (Array.isArray(map.sets)) {
			process.stdout.write(renderRepoSets(map, localRepos(readCwd())));
		}
	}
} catch {}
process.exit(0);
