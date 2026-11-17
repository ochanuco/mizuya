import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLabelSeatPulls } from "./actor-label.ts";
import { type Exec, spawnExec } from "./exec.ts";
import type { Logger } from "./logger.ts";
import { tempDir } from "./test-support.ts";

const gitEnv: Record<string, string> = {
	PATH: process.env.PATH ?? "",
	HOME: tempDir("actor-label-home-"),
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "test",
	GIT_AUTHOR_EMAIL: "test@example.com",
	GIT_COMMITTER_NAME: "test",
	GIT_COMMITTER_EMAIL: "test@example.com",
};

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, env: gitEnv, stdio: "pipe" }).toString();

/** file:// の origin を持つ本物の clone を席の worktree の直下に作る。 */
const seat = (repo = "example/app") => {
	const root = tempDir("actor-label-");
	const dir = join(root, "seat");
	mkdirSync(dir);
	const src = join(root, "src");
	mkdirSync(src);
	git(src, "init", "--quiet", "--initial-branch", "main");
	git(src, "commit", "--quiet", "--allow-empty", "-m", "init");
	const remote = join(root, "remotes", `${repo}.git`);
	mkdirSync(join(root, "remotes", repo.split("/")[0] ?? ""), {
		recursive: true,
	});
	git(root, "clone", "--quiet", "--bare", src, remote);
	git(dir, "clone", "--quiet", `file://${remote}`, "app");
	return { dir, clone: join(dir, "app") };
};

type Pull = { number: number; createdAt: string; labels: { name: string }[] };

/** gh だけを偽にする。git は本物を動かす。 */
const fakeGh = (pulls: Record<string, Pull[]>, editCode = 0) => {
	const calls: string[][] = [];
	const exec: Exec = async (bin, args, opts) => {
		if (bin !== "gh") return spawnExec(bin, args, opts);
		calls.push([...args]);
		if (args[0] === "pr" && args[1] === "list") {
			const head = args[args.indexOf("--head") + 1] ?? "";
			return { code: 0, stdout: JSON.stringify(pulls[head] ?? []), stderr: "" };
		}
		return editCode === 0
			? { code: 0, stdout: "", stderr: "" }
			: { code: 1, stdout: "", stderr: "'actor:akarin' not found" };
	};
	return { exec, calls };
};

const recordingLogger = () => {
	const lines: { level: string; msg: string }[] = [];
	const at =
		(level: string) =>
		(msg: string): void => {
			lines.push({ level, msg });
		};
	const log: Logger = {
		debug: at("debug"),
		info: at("info"),
		warn: at("warn"),
		error: at("error"),
	};
	return { log, lines };
};

const later = () => new Date(Date.now() + 60_000).toISOString();
const edits = (calls: string[][]) =>
	calls.filter((c) => c[1] === "edit").map((c) => [c[2], c.at(-1)]);

describe("createLabelSeatPulls", () => {
	it("clone ができた後に持ち主が出した、label の無い PR にだけ席の人格の label を付ける", async () => {
		const { dir, clone } = seat();
		git(clone, "switch", "--quiet", "-c", "dev/fix");
		const { exec, calls } = fakeGh({
			"dev/fix": [
				{ number: 1, createdAt: later(), labels: [] },
				{ number: 2, createdAt: later(), labels: [{ name: "actor:akarin" }] },
				// 持ち主が先に出していた PR を、席が直しただけのもの
				{ number: 3, createdAt: "2020-01-01T00:00:00Z", labels: [] },
			],
		});
		const label = createLabelSeatPulls({
			exec,
			env: gitEnv,
			log: recordingLogger().log,
		});
		await label({ threadId: "t1", dir, partner: "akarin" });

		const list = calls.find((c) => c[1] === "list") ?? [];
		expect(list).toEqual(
			expect.arrayContaining(["--repo", "example/app", "--author", "@me"]),
		);
		expect(
			list.slice(list.indexOf("--state"), list.indexOf("--state") + 2),
		).toEqual(["--state", "all"]);
		expect(edits(calls)).toEqual([["1", "actor:akarin"]]);
	});

	it("マージしてブランチを消し、既定のブランチに戻った clone でも、出した PR に付ける", async () => {
		const { dir, clone } = seat();
		git(clone, "switch", "--quiet", "-c", "dev/merged");
		git(clone, "switch", "--quiet", "main");
		git(clone, "branch", "--quiet", "-D", "dev/merged");
		const { exec, calls } = fakeGh({
			"dev/merged": [{ number: 7, createdAt: later(), labels: [] }],
		});
		await createLabelSeatPulls({
			exec,
			env: gitEnv,
			log: recordingLogger().log,
		})({
			threadId: "t1",
			dir,
			partner: "yukarin",
		});
		expect(edits(calls)).toEqual([["7", "actor:yukarin"]]);
		// 既定のブランチは PR の head として探さない
		expect(calls.some((c) => c.includes("main"))).toBe(false);
	});

	it("label が repo に無くて付けられなくても投げず、warn を残す", async () => {
		const { dir, clone } = seat();
		git(clone, "switch", "--quiet", "-c", "dev/fix");
		const { exec } = fakeGh(
			{ "dev/fix": [{ number: 1, createdAt: later(), labels: [] }] },
			1,
		);
		const { log, lines } = recordingLogger();
		await createLabelSeatPulls({ exec, env: gitEnv, log })({
			threadId: "t1",
			dir,
			partner: "akarin",
		});
		expect(lines).toContainEqual({
			level: "warn",
			msg: "seat pull not labeled",
		});
	});

	it("clone の無い席と、無い worktree では何もしない", async () => {
		const { exec, calls } = fakeGh({});
		const label = createLabelSeatPulls({
			exec,
			env: gitEnv,
			log: recordingLogger().log,
		});
		await label({
			threadId: "t1",
			dir: tempDir("actor-label-empty-"),
			partner: "yukarin",
		});
		await label({
			threadId: "t1",
			dir: "/nonexistent/seat",
			partner: "yukarin",
		});
		expect(calls).toEqual([]);
	});
});
