import { describe, expect, it, vi } from "vitest";
import type { Exec, ExecResult } from "./exec.ts";
import {
	choosePartner,
	type IssuePickupDeps,
	pickupIssues,
} from "./issue-pickup.ts";
import { err, ok } from "./lib/result.ts";
import { silentLogger } from "./logger.ts";

const issue = (number: number, labels: string[], body = "本文") => ({
	repository: { nameWithOwner: "example/repo" },
	number,
	title: `issue ${number}`,
	url: `https://github.com/example/repo/issues/${number}`,
	body,
	labels: labels.map((name) => ({ name })),
});

const done = (stdout = "", code = 0): ExecResult => ({
	code,
	stdout,
	stderr: "",
});

/** search には found を返し、edit と comment は failOn に入れた操作だけ失敗させる。 */
const fakeGh = (found: unknown[], failOn: string[] = []) => {
	const calls: string[][] = [];
	const exec: Exec = vi.fn(async (_bin, args) => {
		calls.push([...args]);
		if (args[0] === "search") return done(JSON.stringify(found));
		const op = args.includes("--add-label")
			? "add"
			: args.includes("--remove-label")
				? "remove"
				: (args[1] ?? "");
		return failOn.includes(op) ? done("", 1) : done();
	});
	return { exec, calls };
};

const startOk = () =>
	vi.fn<IssuePickupDeps["start"]>(async () => ok({ threadId: "thread1" }));

const depsWith = (
	exec: Exec,
	overrides: Partial<IssuePickupDeps> = {},
): IssuePickupDeps => ({
	exec,
	env: {},
	cwd: "/tmp",
	owner: "example",
	akarinEnabled: true,
	working: () => ({ yukarin: 0, akarin: 0 }),
	start: startOk(),
	logger: silentLogger,
	...overrides,
});

describe("choosePartner", () => {
	it("席の label があればその席に渡す", () => {
		const idle = { yukarin: 3, akarin: 0 };
		expect(choosePartner(["working-yukarin"], idle, true)).toBe("yukarin");
		expect(choosePartner(["working-akarin"], idle, true)).toBe("akarin");
	});

	it("working だけなら作業中の席が少ないほうに渡し、同じなら Yukarin に渡す", () => {
		expect(choosePartner(["working"], { yukarin: 2, akarin: 1 }, true)).toBe(
			"akarin",
		);
		expect(choosePartner(["working"], { yukarin: 1, akarin: 1 }, true)).toBe(
			"yukarin",
		);
	});

	it("Akarin の席が無ければ、working は Yukarin が受け、Akarin 宛ては拾わない", () => {
		const idle = { yukarin: 5, akarin: 0 };
		expect(choosePartner(["working"], idle, false)).toBe("yukarin");
		expect(choosePartner(["working-akarin"], idle, false)).toBeNull();
	});
});

describe("pickupIssues", () => {
	it("拾った印を付けてから席を立て、issue にコメントする", async () => {
		const gh = fakeGh([issue(7, ["working-akarin"])]);
		const start = startOk();
		await pickupIssues(depsWith(gh.exec, { start }));

		expect(gh.calls.map((c) => c.slice(0, 2).join(" "))).toEqual([
			"search issues",
			"issue edit",
			"issue comment",
		]);
		expect(gh.calls[1]).toEqual([
			"issue",
			"edit",
			"7",
			"--repo",
			"example/repo",
			"--add-label",
			"working-picked",
		]);
		expect(start).toHaveBeenCalledWith(
			{
				repo: "example/repo",
				number: 7,
				title: "issue 7",
				url: "https://github.com/example/repo/issues/7",
				body: "本文",
			},
			"akarin",
		);
	});

	it("拾った印がもう付いている issue は拾わない", async () => {
		const gh = fakeGh([issue(7, ["working", "working-picked"])]);
		const start = startOk();
		await pickupIssues(depsWith(gh.exec, { start }));
		expect(start).not.toHaveBeenCalled();
		expect(gh.calls).toHaveLength(1);
	});

	it("印を付けられなければ席を立てない", async () => {
		const gh = fakeGh([issue(7, ["working"])], ["add"]);
		const start = startOk();
		await pickupIssues(depsWith(gh.exec, { start }));
		expect(start).not.toHaveBeenCalled();
	});

	it("席を立てられなければ印を外し、次の回に拾い直せるようにする", async () => {
		const gh = fakeGh([issue(7, ["working"])]);
		await pickupIssues(
			depsWith(gh.exec, {
				start: vi.fn<IssuePickupDeps["start"]>(async () =>
					err({ type: "http" }),
				),
			}),
		);
		expect(gh.calls.at(-1)).toEqual([
			"issue",
			"edit",
			"7",
			"--repo",
			"example/repo",
			"--remove-label",
			"working-picked",
		]);
	});

	it("一度に何件も拾うとき、拾った分を数えて席を振り分ける", async () => {
		const gh = fakeGh([issue(1, ["working"]), issue(2, ["working"])]);
		const start = startOk();
		await pickupIssues(depsWith(gh.exec, { start }));
		expect(start.mock.calls.map((c) => c[1])).toEqual(["yukarin", "akarin"]);
	});

	it("検索が失敗したら何もしない", async () => {
		const exec: Exec = vi.fn(async () => done("", 1));
		const start = startOk();
		await pickupIssues(depsWith(exec, { start }));
		expect(start).not.toHaveBeenCalled();
		expect(exec).toHaveBeenCalledTimes(1);
	});
});
