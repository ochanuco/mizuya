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
		const r = await chakai.assigned("akarin", "pj1", "todo");
		expect(r).toEqual({
			ok: true,
			value: {
				tasks: [
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
				full: false,
			},
		});
		expect(calls[0]?.url).toBe(
			"https://chakai.example.com/v1/tasks?project_id=pj1&state=todo&assignee_id=akarin&limit=90",
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
		expect(await chakai.projects("yukarin")).toEqual({
			ok: true,
			value: [{ id: "pj1", repos: ["example/repo"] }],
		});
		expect(await chakai.children("yukarin", "t1")).toEqual({
			ok: true,
			value: [],
		});
		expect(calls.at(-1)?.url).toContain("/v1/tasks?parent_id=t1&limit=90");
		expect(await chakai.hasChildren("yukarin", "t1")).toEqual({
			ok: true,
			value: false,
		});
		expect(calls.at(-1)?.url).toContain("/v1/tasks?parent_id=t1&limit=1");
	});

	it("検索が 1 回の上限に届いたら、続きがあるかもしれないと知らせる", async () => {
		const { chakai } = make(() =>
			json({
				tasks: Array.from({ length: 90 }, (_, i) => ({ ...TASK, id: `t${i}` })),
			}),
		);
		const r = await chakai.assigned("yukarin", "pj1", "doing");
		expect(r.ok && r.value.full).toBe(true);
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
		expect((await thrown.chakai.assigned("yukarin", "pj1", "todo")).ok).toBe(
			false,
		);
		const html = make(() => new Response("<html>", { status: 302 }));
		expect(await html.chakai.assigned("yukarin", "pj1", "todo")).toMatchObject({
			ok: false,
			error: { code: null },
		});
		const odd = make(() => json({ tasks: [{ id: 1 }] }));
		expect((await odd.chakai.assigned("yukarin", "pj1", "todo")).ok).toBe(
			false,
		);
	});
});

it("担当タスクは 90 件の後ろまで、同じ条件とカーソルで読む", async () => {
	const cursor = "next+/=cursor";
	const { chakai, calls } = make((url) => {
		const params = new URL(url).searchParams;
		return params.has("cursor")
			? json({ tasks: [{ ...TASK, id: "last" }], next_cursor: null })
			: json({
					tasks: Array.from({ length: 90 }, (_, i) => ({
						...TASK,
						id: `t${i}`,
					})),
					next_cursor: cursor,
				});
	});
	const result = await chakai.assigned("akarin", "pj/1", "todo");
	expect(result.ok && result.value.tasks).toHaveLength(91);
	expect(result.ok && result.value.tasks.at(-1)?.id).toBe("last");
	expect(result.ok && result.value.full).toBe(false);
	expect(calls).toHaveLength(2);
	const params = new URL(calls[1]?.url ?? "").searchParams;
	expect(Object.fromEntries(params)).toEqual({
		project_id: "pj/1",
		state: "todo",
		assignee_id: "akarin",
		limit: "90",
		cursor,
	});
});

it("直下の子も全ページを読み、ページ間の重複を除く", async () => {
	const { chakai, calls } = make((url) =>
		new URL(url).searchParams.has("cursor")
			? json({ tasks: [TASK, { ...TASK, id: "child2" }], next_cursor: null })
			: json({ tasks: [TASK], next_cursor: "next" }),
	);
	const result = await chakai.children("yukarin", "parent");
	expect(result.ok && result.value.map((t) => t.id)).toEqual(["t1", "child2"]);
	expect(new URL(calls[1]?.url ?? "").searchParams.get("parent_id")).toBe(
		"parent",
	);
});

it("終端が明示されれば 90 件ちょうどでも上限警告を出さない", async () => {
	const { chakai, calls } = make(() =>
		json({ tasks: Array.from({ length: 90 }, () => TASK), next_cursor: null }),
	);
	const result = await chakai.assigned("yukarin", "pj1", "todo");
	expect(result.ok && result.value.full).toBe(false);
	expect(calls).toHaveLength(1);
});

it("途中のページの失敗や壊れたカーソルは部分結果にせず失敗を返す", async () => {
	for (const response of [
		json({ error: "unavailable", message: "失敗" }, 503),
		json({ tasks: [], next_cursor: 1 }),
	]) {
		const { chakai } = make((url) =>
			new URL(url).searchParams.has("cursor")
				? response
				: json({ tasks: [TASK], next_cursor: "next" }),
		);
		expect((await chakai.assigned("akarin", "pj1", "todo")).ok).toBe(false);
	}
});

it("繰り返すカーソルで検索が終わらなくならない", async () => {
	const { chakai, calls } = make(() =>
		json({ tasks: [TASK], next_cursor: "same" }),
	);
	expect(await chakai.assigned("akarin", "pj1", "todo")).toMatchObject({
		ok: false,
		error: { type: "ChakaiFailed" },
	});
	expect(calls).toHaveLength(2);
});
