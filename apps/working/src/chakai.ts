import * as v from "valibot";
import { err, ok, type PartnerId, type Result } from "./lib/core.ts";

/**
 * chakai（タスク台帳）の REST の口。席の agent は MCP で使い、受付はここから呼ぶ。
 * actor は席の人格で、chakai は X-Actor で誰の操作かを記録する。
 */
export type Chakai = {
	projects: (actor: PartnerId) => Promise<Result<ChakaiProject[], ChakaiError>>;
	/**
	 * プロジェクトの中で、担当が actor の state のタスク。
	 * カーソルで終端まで読む。旧 API が上限で切った場合だけ full で知らせる。
	 */
	assigned: (
		actor: PartnerId,
		projectId: string,
		state: ChakaiState,
	) => Promise<Result<{ tasks: ChakaiTask[]; full: boolean }, ChakaiError>>;
	/** 直下の子を終端まで読む。 */
	children: (
		actor: PartnerId,
		id: string,
	) => Promise<Result<ChakaiTask[], ChakaiError>>;
	getTask: (
		actor: PartnerId,
		id: string,
	) => Promise<Result<ChakaiTask, ChakaiError>>;
	hasChildren: (
		actor: PartnerId,
		id: string,
	) => Promise<Result<boolean, ChakaiError>>;
	updateTask: (
		actor: PartnerId,
		id: string,
		patch: { state: ChakaiState; waiting_on?: string },
	) => Promise<Result<ChakaiTask, ChakaiError>>;
	/** 親の子孫のうち次の todo。無ければ task は null。 */
	nextTask: (
		actor: PartnerId,
		parentId: string,
	) => Promise<Result<ChakaiNext, ChakaiError>>;
	startRun: (
		actor: PartnerId,
		input: {
			taskId: string;
			seat: string;
			model: string | null;
			hishakuNo: number | null;
		},
	) => Promise<Result<{ id: string }, ChakaiError>>;
	endRun: (
		actor: PartnerId,
		runId: string,
	) => Promise<Result<void, ChakaiError>>;
};

export const CHAKAI_STATES = [
	"backlog",
	"todo",
	"doing",
	"review",
	"done",
	"dropped",
] as const;
export type ChakaiState = (typeof CHAKAI_STATES)[number];

export type ChakaiTask = {
	id: string;
	projectId: string;
	parentId: string | null;
	title: string;
	body: string;
	state: ChakaiState;
	assigneeId: string | null;
};

/** repos はプロジェクトに紐付いた repo（`owner/repo`）。 */
export type ChakaiProject = { id: string; repos: string[] };

export type ChakaiNext = {
	task: ChakaiTask | null;
	/** 子孫の状態ごとの数。 */
	states: Record<ChakaiState, number>;
};

/** code は chakai の返した error（`repo_required` など）。届かなかった・読めなかったときは null。 */
export type ChakaiError = {
	type: "ChakaiFailed";
	code: string | null;
	reason: string;
};

const taskSchema = v.pipe(
	v.object({
		id: v.string(),
		project_id: v.string(),
		parent_id: v.nullable(v.string()),
		title: v.string(),
		body: v.string(),
		state: v.picklist(CHAKAI_STATES),
		assignee_id: v.nullable(v.string()),
	}),
	v.transform(
		(t): ChakaiTask => ({
			id: t.id,
			projectId: t.project_id,
			parentId: t.parent_id,
			title: t.title,
			body: t.body,
			state: t.state,
			assigneeId: t.assignee_id,
		}),
	),
);

const tasksSchema = v.object({
	tasks: v.array(taskSchema),
	// chakai の配備より先に Working が更新されても、旧 API の上限警告は残す
	next_cursor: v.optional(
		v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(4096))),
	),
});

const projectsSchema = v.object({
	projects: v.array(v.object({ id: v.string(), repos: v.array(v.string()) })),
});

const nextSchema = v.object({
	task: v.nullable(taskSchema),
	descendant_states: v.object(
		v.entriesFromList(CHAKAI_STATES, v.optional(v.number(), 0)),
	),
});

const runSchema = v.object({ id: v.string() });

const failureSchema = v.object({
	error: v.string(),
	message: v.optional(v.string(), ""),
});

const TIMEOUT_MS = 30_000;
/** chakai の検索が 1 回に返す上限。 */
const SEARCH_LIMIT = 90;

export const createChakai = (opts: {
	/** MCP の URL。REST は同じ origin の /v1 にある。 */
	mcpUrl: string;
	clientId: string;
	clientSecret: string;
	fetch?: typeof fetch;
}): Chakai => {
	const f = opts.fetch ?? fetch;
	const base = `${new URL(opts.mcpUrl).origin}/v1`;

	const call = async <S extends v.GenericSchema>(
		actor: PartnerId,
		method: string,
		path: string,
		schema: S,
		body?: unknown,
	): Promise<Result<v.InferOutput<S>, ChakaiError>> => {
		const failed = (code: string | null, reason: string) =>
			err({ type: "ChakaiFailed" as const, code, reason });
		let res: Response;
		let json: unknown;
		try {
			res = await f(`${base}${path}`, {
				method,
				headers: {
					"CF-Access-Client-Id": opts.clientId,
					"CF-Access-Client-Secret": opts.clientSecret,
					"X-Actor": actor,
					// chakai は本文の無い書き込みにも Content-Type を求める
					...(method === "GET" ? {} : { "Content-Type": "application/json" }),
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				// Access が service token を通さないとログイン画面に飛ばす。追わずに失敗として扱う
				redirect: "manual",
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
			json = await res.json().catch(() => null);
		} catch (e) {
			return failed(null, String(e));
		}
		if (!res.ok) {
			const failure = v.safeParse(failureSchema, json);
			return failure.success
				? failed(
						failure.output.error,
						`${res.status} ${failure.output.error} ${failure.output.message}`.trim(),
					)
				: failed(null, `${method} ${path} returned ${res.status}`);
		}
		const parsed = v.safeParse(schema, json);
		return parsed.success
			? ok(parsed.output)
			: failed(null, `${method} ${path} returned an unexpected body`);
	};

	const id = encodeURIComponent;

	const searchAll = async (
		actor: PartnerId,
		query: string,
	): Promise<Result<{ tasks: ChakaiTask[]; full: boolean }, ChakaiError>> => {
		const tasks = new Map<string, ChakaiTask>();
		const cursors = new Set<string>();
		let cursor: string | undefined;
		while (true) {
			const r = await call(
				actor,
				"GET",
				`/tasks?${query}&limit=${SEARCH_LIMIT}${cursor ? `&cursor=${id(cursor)}` : ""}`,
				tasksSchema,
			);
			if (!r.ok) return r;
			for (const task of r.value.tasks) tasks.set(task.id, task);
			const next = r.value.next_cursor;
			if (next === null || next === undefined) {
				return ok({
					tasks: [...tasks.values()],
					full: next === undefined && r.value.tasks.length >= SEARCH_LIMIT,
				});
			}
			if (cursors.has(next)) {
				return err({
					type: "ChakaiFailed",
					code: null,
					reason: "chakai の検索が同じカーソルを繰り返した",
				});
			}
			cursors.add(next);
			cursor = next;
		}
	};

	return {
		projects: async (actor) => {
			const r = await call(actor, "GET", "/projects", projectsSchema);
			return r.ok ? ok(r.value.projects) : r;
		},
		assigned: (actor, projectId, state) =>
			searchAll(
				actor,
				`project_id=${id(projectId)}&state=${state}&assignee_id=${id(actor)}`,
			),
		children: async (actor, taskId) => {
			const r = await searchAll(actor, `parent_id=${id(taskId)}`);
			return r.ok ? ok(r.value.tasks) : r;
		},
		getTask: (actor, taskId) =>
			call(actor, "GET", `/tasks/${id(taskId)}`, taskSchema),
		hasChildren: async (actor, taskId) => {
			const r = await call(
				actor,
				"GET",
				`/tasks?parent_id=${id(taskId)}&limit=1`,
				tasksSchema,
			);
			return r.ok ? ok(r.value.tasks.length > 0) : r;
		},
		updateTask: (actor, taskId, patch) =>
			call(actor, "PATCH", `/tasks/${id(taskId)}`, taskSchema, patch),
		nextTask: async (actor, parentId) => {
			const r = await call(
				actor,
				"GET",
				`/tasks/${id(parentId)}/next`,
				nextSchema,
			);
			return r.ok
				? ok({ task: r.value.task, states: r.value.descendant_states })
				: r;
		},
		startRun: (actor, input) =>
			call(actor, "POST", "/runs", runSchema, {
				task_id: input.taskId,
				seat: input.seat,
				...(input.model === null ? {} : { model: input.model }),
				...(input.hishakuNo === null ? {} : { hishaku_no: input.hishakuNo }),
			}),
		endRun: async (actor, runId) => {
			const r = await call(actor, "POST", `/runs/${id(runId)}/end`, runSchema);
			return r.ok ? ok(undefined) : r;
		},
	};
};
