import { describe, expect, it, vi } from "vitest";
import {
	pickupTasks,
	type TaskPickupDeps,
	type TaskStart,
} from "./chakai-pickup.ts";
import { err, ok } from "./lib/result.ts";
import { silentLogger } from "./logger.ts";
import { fakeChakai } from "./test-support.ts";

const setup = (opts: { akarinEnabled?: boolean } = {}) => {
	const c = fakeChakai();
	c.repos.set("pj1", ["example/repo"]);
	const started: TaskStart[] = [];
	/** 席が回している親。 */
	const held = new Set<string>();
	// 本物と同じく、席を立てる側が親を doing にする
	const start = vi.fn<TaskPickupDeps["start"]>(async (input) => {
		started.push(input);
		c.move(input.parent.id, "doing");
		held.add(input.parent.id);
		return ok({ threadId: `thread${started.length}` });
	});
	const sweep = vi.fn(async () => {});
	const run = () =>
		pickupTasks({
			chakai: c.chakai,
			akarinEnabled: opts.akarinEnabled ?? true,
			start,
			sweep,
			holds: async (id) => held.has(id),
			logger: silentLogger,
		});
	const writes = () => c.calls.filter((x) => x.startsWith("updateTask"));
	return { c, start, started, held, sweep, run, writes };
};

describe("chakai のタスクの見回り", () => {
	it("担当が付いた todo の親に、最初の todo の子と repo を渡して席を立てる", async () => {
		const s = setup();
		s.c.add({ id: "p", assigneeId: "yukarin" });
		s.c.add({ id: "c1", parentId: "p", state: "done" });
		s.c.add({ id: "c2", parentId: "p" });
		s.c.add({ id: "c3", parentId: "p" });
		await s.run();
		expect(s.started).toHaveLength(1);
		expect(s.started[0]).toMatchObject({
			parent: { id: "p" },
			first: { id: "c2" },
			remaining: 1,
			partner: "yukarin",
			repo: "example/repo",
		});
		// 親を doing にするのは席を立てる側。見回りは台帳を動かさない
		expect(s.writes()).toEqual([]);
		expect(s.sweep).toHaveBeenCalledTimes(1);
	});

	it("todo の子孫が無ければ、親そのものを最初の作業にする", async () => {
		const s = setup();
		s.c.add({ id: "p", assigneeId: "akarin" });
		await s.run();
		expect(s.started[0]).toMatchObject({
			first: { id: "p" },
			remaining: 0,
			partner: "akarin",
		});
	});

	it("席が回している親は、次の見回りでは拾わず、todo にも戻さない", async () => {
		const s = setup();
		s.c.add({ id: "p", assigneeId: "yukarin" });
		await s.run();
		await s.run();
		expect(s.start).toHaveBeenCalledTimes(1);
		expect(s.c.tasks.get("p")?.state).toBe("doing");
	});

	it("担当の無い todo と、backlog のタスクは拾わない", async () => {
		const s = setup();
		s.c.add({ id: "a" });
		s.c.add({ id: "b", assigneeId: "yukarin", state: "backlog" });
		await s.run();
		expect(s.start).not.toHaveBeenCalled();
	});

	it("席が回している親の子孫と、これから拾われる親の子孫は、担当が付いていても拾わない", async () => {
		const s = setup();
		s.c.add({ id: "run", state: "doing" });
		s.c.add({ id: "mid", parentId: "run", state: "review", waitingOn: "x" });
		s.c.add({ id: "deep", parentId: "mid", assigneeId: "yukarin" });
		s.c.add({ id: "p", assigneeId: "yukarin" });
		s.c.add({ id: "kid", parentId: "p", assigneeId: "akarin" });
		await s.run();
		expect(s.started.map((t) => t.parent.id)).toEqual(["p"]);
		expect(s.c.tasks.get("deep")?.state).toBe("todo");
	});

	it("repo の無いプロジェクトの親は、席を立てずに review にして理由を書く", async () => {
		const s = setup();
		s.c.add({ id: "p", assigneeId: "yukarin", projectId: "pj2" });
		await s.run();
		expect(s.start).not.toHaveBeenCalled();
		expect(s.c.tasks.get("p")).toMatchObject({ state: "review" });
		expect(s.c.tasks.get("p")?.waitingOn).toContain("repo が紐付いていない");
	});

	it("repo が複数あって決められない親も、review にして repo を並べる", async () => {
		const s = setup();
		s.c.repos.set("pj1", ["example/a", "example/b"]);
		s.c.add({ id: "p", assigneeId: "yukarin" });
		await s.run();
		expect(s.start).not.toHaveBeenCalled();
		expect(s.c.tasks.get("p")?.waitingOn).toContain("example/a、example/b");
	});

	it("あかりんの席が無い間は、あかりん宛てのタスクを todo のまま残す", async () => {
		const s = setup({ akarinEnabled: false });
		s.c.add({ id: "p", assigneeId: "akarin" });
		await s.run();
		expect(s.start).not.toHaveBeenCalled();
		expect(s.c.tasks.get("p")?.state).toBe("todo");
	});

	it("投稿を立てられなかったら台帳を動かさず、次の見回りで拾い直す", async () => {
		const s = setup();
		s.c.add({ id: "p", assigneeId: "yukarin" });
		s.start.mockResolvedValueOnce(
			err({ type: "PostFailed", reason: "ExternalServiceUnavailable" }),
		);
		await s.run();
		expect(s.writes()).toEqual([]);
		expect(s.c.tasks.get("p")?.state).toBe("todo");
		await s.run();
		expect(s.c.tasks.get("p")?.state).toBe("doing");
	});

	it("run を始められない・席を起こせないときは、review にして理由を書く", async () => {
		const s = setup();
		s.c.add({ id: "p", assigneeId: "yukarin" });
		s.start.mockImplementationOnce(async (input) => {
			s.c.move(input.parent.id, "doing");
			return err({ type: "SeatFailed", reason: "席の agent を起こせなかった" });
		});
		await s.run();
		expect(s.c.tasks.get("p")).toMatchObject({
			state: "review",
			waitingOn: "席を立てられなかった: 席の agent を起こせなかった",
		});
	});

	it("席の連携の入口が chakai にまだ無ければ、台帳を動かさない", async () => {
		const s = setup();
		s.c.add({ id: "p", assigneeId: "yukarin" });
		s.c.failOn.add("nextTask");
		await s.run();
		expect(s.start).not.toHaveBeenCalled();
		expect(s.writes()).toEqual([]);
	});

	it("プロジェクトの一覧を読めない担当は飛ばし、もう一方の担当は見る", async () => {
		const s = setup();
		s.c.add({ id: "p", assigneeId: "akarin" });
		const projects = s.c.chakai.projects;
		s.c.chakai.projects = async (actor) =>
			actor === "yukarin"
				? err({ type: "ChakaiFailed", code: null, reason: "down" })
				: projects(actor);
		await s.run();
		expect(s.started.map((t) => t.partner)).toEqual(["akarin"]);
	});

	it("担当の付いた doing なのに回している席が無い親は todo に戻し、同じ回で席を立て直す", async () => {
		const s = setup();
		s.c.add({ id: "p", assigneeId: "yukarin", state: "doing" });
		s.c.add({ id: "c1", parentId: "p", state: "doing" });
		s.c.add({ id: "c2", parentId: "p" });
		await s.run();
		expect(s.writes().slice(0, 2)).toEqual([
			"updateTask p todo",
			"updateTask c1 todo",
		]);
		// 前の席が渡されたまま残した子も、もう一度渡す
		expect(s.started[0]).toMatchObject({
			parent: { id: "p" },
			first: { id: "c1" },
			remaining: 1,
		});
	});

	it("席が回している親の子孫は、担当の付いた doing でも todo に戻さない", async () => {
		const s = setup();
		s.c.add({ id: "p", assigneeId: "yukarin", state: "doing" });
		s.c.add({ id: "c1", parentId: "p", assigneeId: "yukarin", state: "doing" });
		s.held.add("p");
		await s.run();
		expect(s.writes()).toEqual([]);
		expect(s.start).not.toHaveBeenCalled();
	});

	it("席が分けた doing の子（子を持つ）は、親を拾い直すときも todo に戻さない", async () => {
		const s = setup();
		s.c.add({ id: "p", assigneeId: "yukarin" });
		s.c.add({ id: "mid", parentId: "p", state: "doing" });
		s.c.add({ id: "g1", parentId: "mid", state: "doing" });
		s.c.add({ id: "g2", parentId: "mid" });
		await s.run();
		expect(s.writes()).toEqual(["updateTask g1 todo"]);
		expect(s.started[0]).toMatchObject({ first: { id: "g1" }, remaining: 1 });
	});

	it("検索はプロジェクトごとに分け、上限に届いたプロジェクトがあっても次のプロジェクトを見る", async () => {
		const s = setup();
		s.c.repos.set("pj2", ["example/other"]);
		s.c.searchLimit.value = 2;
		s.c.add({ id: "run", state: "doing" });
		// 席が回している親の子孫が、プロジェクト 1 の検索の先頭を埋めている
		s.c.add({ id: "k1", parentId: "run", assigneeId: "yukarin" });
		s.c.add({ id: "k2", parentId: "run", assigneeId: "yukarin" });
		s.c.add({ id: "late", assigneeId: "yukarin" });
		s.c.add({ id: "q", assigneeId: "yukarin", projectId: "pj2" });
		await s.run();
		expect(s.started.map((t) => [t.parent.id, t.repo])).toEqual([
			["q", "example/other"],
		]);
	});
});
