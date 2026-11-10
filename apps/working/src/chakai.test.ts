import { describe, expect, it, vi } from "vitest";
import { createChakai } from "./chakai.ts";

const TASK = {
	id: "t1",
	project_id: "pj1",
	parent_id: null,
	title: "親",
	body: "本文",
	state: "todo",
	assignee_id: "yukarin",
	order_key: "a0",
	labels: [],
};

const make = (respond: (url: string, init: RequestInit) => Response) => {
	const calls: { url: string; init: RequestInit }[] = [];
	const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(url), init: init ?? {} });
		return respond(String(url), init ?? {});
	});
	const chakai = createChakai({
		mcpUrl: "https://chakai.example.com/mcp",
		clientId: "cid",
		clientSecret: "csecret",
		fetch: f as typeof fetch,
	});
	return { chakai, calls };
};

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status });

describe("chakai の REST の口", () => {
	it("MCP の URL の origin の /v1 を、service token と X-Actor を付けて呼ぶ", async () => {
		const { chakai, calls } = make(() => json({ tasks: [TASK] }));
		const r = await chakai.assignedTodos("akarin");
		expect(r).toEqual({
			ok: true,
			value: [
				{
					id: "t1",
					projectId: "pj1",
					parentId: null,
					title: "親",
					body: "本文",
					state: "todo",
					assigneeId: "yukarin",
				},
			],
		});
		expect(calls[0]?.url).toBe(
			"https://chakai.example.com/v1/tasks?state=todo&assignee_id=akarin",
		);
		expect(calls[0]?.init.headers).toMatchObject({
			"CF-Access-Client-Id": "cid",
			"CF-Access-Client-Secret": "csecret",
			"X-Actor": "akarin",
		});
	});

	it("run は席の名前で始め、model と hishaku の番号は分かるときだけ渡す", async () => {
		const { chakai, calls } = make(() => json({ id: "r1" }, 201));
		await chakai.startRun("yukarin", {
			taskId: "t1",
			seat: "seat-thread1",
			model: null,
			hishakuNo: 1234,
		});
		expect(calls[0]?.url).toBe("https://chakai.example.com/v1/runs");
		expect(calls[0]?.init.method).toBe("POST");
		expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
			task_id: "t1",
			seat: "seat-thread1",
			hishaku_no: 1234,
		});
	});

	it("状態を動かす、次を取る、run を閉じる入口を呼ぶ", async () => {
		const { chakai, calls } = make((url) =>
			url.endsWith("/next")
				? json({ task: TASK, descendant_states: { todo: 2, done: 1 } })
				: url.endsWith("/end")
					? json({ id: "r1" })
					: json(TASK),
		);
		await chakai.updateTask("yukarin", "t1", {
			state: "review",
			waiting_on: "repo が無い",
		});
		const next = await chakai.nextTask("yukarin", "t1");
		await chakai.endRun("yukarin", "r1");
		expect(calls.map((c) => `${c.init.method} ${c.url.slice(26)}`)).toEqual([
			"PATCH /v1/tasks/t1",
			"GET /v1/tasks/t1/next",
			"POST /v1/runs/r1/end",
		]);
		expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
			state: "review",
			waiting_on: "repo が無い",
		});
		// 本文の無い書き込みにも Content-Type を付け、読み出しには付けない
		expect(calls[2]?.init.body).toBeUndefined();
		expect(calls[2]?.init.headers).toMatchObject({
			"Content-Type": "application/json",
		});
		expect(calls[1]?.init.headers).not.toHaveProperty("Content-Type");
		expect(next.ok && next.value.states).toMatchObject({
			todo: 2,
			done: 1,
			doing: 0,
		});
	});

	it("プロジェクトの repo と、子の有無を読む", async () => {
		const { chakai, calls } = make((url) =>
			url.endsWith("/projects")
				? json({ projects: [{ id: "pj1", repos: ["example/repo"] }] })
				: json({ tasks: [] }),
		);
		expect(await chakai.reposOf("yukarin", "pj1")).toEqual({
			ok: true,
			value: ["example/repo"],
		});
		expect(await chakai.reposOf("yukarin", "pj9")).toEqual({
			ok: true,
			value: [],
		});
		expect(await chakai.hasChildren("yukarin", "t1")).toEqual({
			ok: true,
			value: false,
		});
		expect(calls.at(-1)?.url).toContain("/v1/tasks?parent_id=t1&limit=1");
	});

	it("chakai が拒んだら、その error を code にして返す", async () => {
		const { chakai } = make(() =>
			json({ error: "repo_required", message: "先に repo を紐付ける" }, 400),
		);
		const r = await chakai.startRun("yukarin", {
			taskId: "t1",
			seat: "s",
			model: null,
			hishakuNo: null,
		});
		expect(r).toMatchObject({ ok: false, error: { code: "repo_required" } });
	});

	it("届かない、JSON でない、形が違う応答は失敗として返す", async () => {
		const thrown = make(() => {
			throw new Error("network");
		});
		expect((await thrown.chakai.assignedTodos("yukarin")).ok).toBe(false);
		const html = make(() => new Response("<html>", { status: 302 }));
		expect(await html.chakai.assignedTodos("yukarin")).toMatchObject({
			ok: false,
			error: { code: null },
		});
		const odd = make(() => json({ tasks: [{ id: 1 }] }));
		expect((await odd.chakai.assignedTodos("yukarin")).ok).toBe(false);
	});
});
