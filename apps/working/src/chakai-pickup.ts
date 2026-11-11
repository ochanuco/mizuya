import type { Chakai, ChakaiTask } from "./chakai.ts";
import { PARTNER_IDS, type PartnerId } from "./lib/core.ts";
import type { Result } from "./lib/result.ts";
import type { Logger } from "./logger.ts";

/** 席を立てる chakai の親タスクと、最初に渡すタスク。todo の子孫が無ければ first は親そのもの。 */
export type TaskStart = {
	parent: ChakaiTask;
	first: ChakaiTask;
	/** first を除いた todo の子孫の数。 */
	remaining: number;
	partner: PartnerId;
	repo: string;
};

/**
 * 席を立てられなかった理由。
 * PostFailed は台帳を動かす前の失敗で、親は todo のまま残り、次の見回りで拾い直す。
 */
export type TaskStartError = {
	type: "PostFailed" | "RunFailed" | "SeatFailed";
	reason: string;
};

export type TaskPickupDeps = {
	chakai: Chakai;
	akarinEnabled: boolean;
	start: (
		input: TaskStart,
	) => Promise<Result<{ threadId: string }, TaskStartError>>;
	/** 閉じそこねた run を閉じ直す。 */
	sweep: () => Promise<void>;
	/** そのタスクを親として回している席があるか。 */
	holds: (taskId: string) => Promise<boolean>;
	logger: Logger;
};

const isPartner = (id: string | null): id is PartnerId =>
	PARTNER_IDS.some((p) => p === id);

const ANCESTOR_LIMIT = 20;
const WAITING_ON_LIMIT = 500;
/** 親を拾うときに、残った doing を探して読む子孫の数の上限。 */
const STALE_SCAN_LIMIT = 200;

const repoReason = (repos: readonly string[]) =>
	repos.length === 0
		? "プロジェクトに repo が紐付いていないので、席を立てられない。repo を紐付けてから todo に戻す"
		: `プロジェクトに repo が複数あり（${repos.join("、")}）、席の作業場所を決められない`;

/**
 * 担当が yukarin か akarin の todo のタスクを親として拾い、席を立てる。
 * 台帳を読む操作をすべて済ませてから書くので、chakai が席の連携の入口をまだ持たない間は何も動かさない。
 * 親を doing にするのは、席を立てる側が run を始めた後。途中で落ちても親は todo のまま残り、次の回に拾い直す。
 */
export const pickupTasks = async (deps: TaskPickupDeps): Promise<void> => {
	const { chakai, logger: log } = deps;

	/**
	 * 席が回している親の子孫か、これから拾われる親の子孫なら true。そのタスクは親の席が順に受け取る。
	 * 祖先を読めなければ null。
	 */
	const underSeat = async (
		actor: PartnerId,
		task: ChakaiTask,
	): Promise<boolean | null> => {
		let parentId = task.parentId;
		for (let i = 0; parentId !== null && i < ANCESTOR_LIMIT; i++) {
			const parent = await chakai.getTask(actor, parentId);
			if (!parent.ok) return null;
			const p = parent.value;
			if (p.state === "doing") return true;
			if (p.state === "todo" && isPartner(p.assigneeId)) return true;
			parentId = p.parentId;
		}
		return false;
	};

	/** 席が回している親か、その子孫なら true。祖先を読めなければ null。 */
	const held = async (
		actor: PartnerId,
		task: ChakaiTask,
	): Promise<boolean | null> => {
		if (await deps.holds(task.id)) return true;
		let parentId = task.parentId;
		for (let i = 0; parentId !== null && i < ANCESTOR_LIMIT; i++) {
			if (await deps.holds(parentId)) return true;
			const parent = await chakai.getTask(actor, parentId);
			if (!parent.ok) return null;
			parentId = parent.value.parentId;
		}
		return false;
	};

	/**
	 * 担当の付いた doing なのに回している席が無いタスクを todo に戻す。
	 * 親を doing にした後で受付が落ちた、席を立てそこねた後の巻き戻しが失敗した、などで残る。
	 * 戻せば、この後の検索が拾い直す。
	 */
	const recover = async (actor: PartnerId, projectId: string) => {
		const doing = await chakai.assigned(actor, projectId, "doing");
		if (!doing.ok) {
			log.warn("chakai doing search failed", {
				actor,
				reason: doing.error.reason,
			});
			return;
		}
		for (const task of doing.value.tasks) {
			if ((await held(actor, task)) !== false) continue;
			// 席を確かめている間に、席が片付け終えて親が review になっていることがある
			const now = await chakai.getTask(actor, task.id);
			if (!now.ok || now.value.state !== "doing") continue;
			log.warn("chakai task has no seat; moving back to todo", {
				task: task.id,
			});
			await toTodo(actor, task.id);
		}
	};

	/** chakai は AI が自分で作った深い todo を拒むので、戻せないことがある。 */
	const toTodo = async (actor: PartnerId, id: string) => {
		const back = await chakai.updateTask(actor, id, { state: "todo" });
		if (!back.ok) {
			log.warn("chakai task not moved back to todo", {
				task: id,
				reason: back.error.reason,
			});
		}
	};

	/**
	 * 親の子孫のうち、子の無い doing。前の席が渡されたまま残したタスクで、next は todo しか返さないので、
	 * todo に戻さないと新しい席に渡らない。読めなければ null。
	 */
	const staleDoing = async (
		actor: PartnerId,
		parent: ChakaiTask,
	): Promise<ChakaiTask[] | null> => {
		const stale: ChakaiTask[] = [];
		const queue = [parent.id];
		let read = 0;
		for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
			if (++read > STALE_SCAN_LIMIT) break;
			const kids = await chakai.children(actor, id);
			if (!kids.ok) return null;
			for (const kid of kids.value) {
				// 別の席が親として回しているタスクと、その子孫には触らない
				if (await deps.holds(kid.id)) continue;
				if (kid.state !== "doing") {
					queue.push(kid.id);
					continue;
				}
				const split = await chakai.hasChildren(actor, kid.id);
				if (!split.ok) return null;
				if (split.value) queue.push(kid.id);
				else stale.push(kid);
			}
		}
		return stale;
	};

	const toReview = async (
		actor: PartnerId,
		task: ChakaiTask,
		reason: string,
	) => {
		const r = await chakai.updateTask(actor, task.id, {
			state: "review",
			waiting_on: reason.slice(0, WAITING_ON_LIMIT),
		});
		if (!r.ok) {
			log.warn("chakai task not moved to review", {
				task: task.id,
				reason: r.error.reason,
			});
		}
	};

	const pickup = async (
		actor: PartnerId,
		parent: ChakaiTask,
		repos: readonly string[],
	) => {
		const under = await underSeat(actor, parent);
		if (under !== false) {
			if (under === null) {
				log.warn("chakai ancestors unreadable", { task: parent.id });
			}
			return;
		}
		const [stale, next] = await Promise.all([
			staleDoing(actor, parent),
			chakai.nextTask(actor, parent.id),
		]);
		if (stale === null || !next.ok) {
			log.warn("chakai task skipped; ledger unreadable", {
				task: parent.id,
				reason: next.ok ? "children" : next.error.reason,
			});
			return;
		}
		const [repo] = repos;
		if (repo === undefined || repos.length !== 1) {
			await toReview(actor, parent, repoReason(repos));
			log.info("chakai task needs a repo", { task: parent.id });
			return;
		}
		let first = next.value.task;
		let todo = next.value.states.todo;
		if (stale.length > 0) {
			for (const task of stale) await toTodo(actor, task.id);
			const again = await chakai.nextTask(actor, parent.id);
			if (!again.ok) {
				log.warn("chakai task skipped; ledger unreadable", {
					task: parent.id,
					reason: again.error.reason,
				});
				return;
			}
			first = again.value.task;
			todo = again.value.states.todo;
		}
		const started = await deps.start({
			parent,
			first: first ?? parent,
			remaining: Math.max(todo - (first ? 1 : 0), 0),
			partner: actor,
			repo,
		});
		if (started.ok) {
			log.info("chakai task picked", {
				task: parent.id,
				partner: actor,
				thread_id: started.value.threadId,
			});
			return;
		}
		log.error("chakai task pickup failed", {
			task: parent.id,
			error: started.error.type,
			reason: started.error.reason,
		});
		if (started.error.type === "PostFailed") return;
		await toReview(
			actor,
			parent,
			`席を立てられなかった: ${started.error.reason}`,
		);
	};

	await deps.sweep();
	for (const actor of PARTNER_IDS) {
		// あかりんの席が無い間は、あかりん宛てのタスクを todo のまま残す
		if (actor === "akarin" && !deps.akarinEnabled) continue;
		const projects = await chakai.projects(actor);
		if (!projects.ok) {
			log.warn("chakai project list failed", {
				actor,
				reason: projects.error.reason,
			});
			continue;
		}
		// 検索の失敗がほかのプロジェクトに波及しないよう、プロジェクトごとに読む
		for (const project of projects.value) {
			await recover(actor, project.id);
			const found = await chakai.assigned(actor, project.id, "todo");
			if (!found.ok) {
				log.warn("chakai task search failed", {
					actor,
					project: project.id,
					reason: found.error.reason,
				});
				continue;
			}
			if (found.value.full) {
				log.warn("chakai task search hit its limit; later tasks wait", {
					actor,
					project: project.id,
				});
			}
			for (const parent of found.value.tasks) {
				await pickup(actor, parent, project.repos);
			}
		}
	}
};
