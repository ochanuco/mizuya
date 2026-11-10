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
 * PostFailed は投稿を立てる前の失敗で跡が残らないので、次の見回りで拾い直せる。
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
	logger: Logger;
};

const isPartner = (id: string | null): id is PartnerId =>
	PARTNER_IDS.some((p) => p === id);

const ANCESTOR_LIMIT = 20;
const WAITING_ON_LIMIT = 500;

const repoReason = (repos: readonly string[]) =>
	repos.length === 0
		? "プロジェクトに repo が紐付いていないので、席を立てられない。repo を紐付けてから todo に戻す"
		: `プロジェクトに repo が複数あり（${repos.join("、")}）、席の作業場所を決められない`;

/**
 * 担当が yukarin か akarin の todo のタスクを親として拾い、席を立てる。
 * 台帳を読む操作をすべて済ませてから書くので、chakai が席の連携の入口をまだ持たない間は何も動かさない。
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

	for (const actor of PARTNER_IDS) {
		// あかりんの席が無い間は、あかりん宛てのタスクを todo のまま残す
		if (actor === "akarin" && !deps.akarinEnabled) continue;
		const found = await chakai.assignedTodos(actor);
		if (!found.ok) {
			log.warn("chakai task search failed", {
				actor,
				reason: found.error.reason,
			});
			continue;
		}
		for (const parent of found.value) {
			const under = await underSeat(actor, parent);
			if (under !== false) {
				if (under === null) {
					log.warn("chakai ancestors unreadable", { task: parent.id });
				}
				continue;
			}
			const [repos, next] = await Promise.all([
				chakai.reposOf(actor, parent.projectId),
				chakai.nextTask(actor, parent.id),
			]);
			if (!repos.ok || !next.ok) {
				log.warn("chakai task skipped; ledger unreadable", {
					task: parent.id,
					reason: (!repos.ok ? repos.error : !next.ok ? next.error : null)
						?.reason,
				});
				continue;
			}
			const [repo] = repos.value;
			if (repo === undefined || repos.value.length !== 1) {
				await toReview(actor, parent, repoReason(repos.value));
				log.info("chakai task needs a repo", { task: parent.id });
				continue;
			}
			// 先に doing にし、席を立てた後で印が付かずに次の回でもう一度拾うことを避ける
			const marked = await chakai.updateTask(actor, parent.id, {
				state: "doing",
			});
			if (!marked.ok) {
				log.warn("chakai task mark failed", {
					task: parent.id,
					reason: marked.error.reason,
				});
				continue;
			}
			const first = next.value.task ?? parent;
			const started = await deps.start({
				parent,
				first,
				remaining: Math.max(
					next.value.states.todo - (next.value.task ? 1 : 0),
					0,
				),
				partner: actor,
				repo,
			});
			if (started.ok) {
				log.info("chakai task picked", {
					task: parent.id,
					partner: actor,
					thread_id: started.value.threadId,
				});
				continue;
			}
			log.error("chakai task pickup failed", {
				task: parent.id,
				error: started.error.type,
				reason: started.error.reason,
			});
			if (started.error.type === "PostFailed") {
				const back = await chakai.updateTask(actor, parent.id, {
					state: "todo",
				});
				if (!back.ok) {
					log.warn("chakai task not moved back to todo", {
						task: parent.id,
						reason: back.error.reason,
					});
				}
				continue;
			}
			await toReview(
				actor,
				parent,
				`席を立てられなかった: ${started.error.reason}`,
			);
		}
	}
};
