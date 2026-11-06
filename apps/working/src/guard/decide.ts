// hook として node で直接動かすため、node の組み込み以外を import しない。
import {
	classifyBash,
	type GuardContext,
	isProtected,
	PROTECTED_TOUCH,
} from "./bash.ts";
import type { Ledger } from "./ledger.ts";
import {
	absPath,
	isUnder,
	type Operation,
	operationOf,
	sameOperation,
} from "./operation.ts";

/** パスを受け取る道具。秘密情報や許可の記録の場所に触るものだけを止める。 */
const PATH_TOOLS = new Set([
	"Read",
	"Glob",
	"Grep",
	"Edit",
	"Write",
	"MultiEdit",
	"NotebookEdit",
]);

/** Codex の apply_patch の本文から、書き換えるファイルのパスを取り出す。 */
const patchPaths = (patch: string): string[] =>
	[
		...patch.matchAll(
			/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm,
		),
	].map((m) => (m[1] ?? "").trim());

/**
 * hook で止める操作かを調べる。止めるのは秘密情報の読み出しと、秘密情報や許可の記録の場所に触る操作だけ。
 * 許可の記録を席の Claude が書き換えると自分で許可を出せてしまうので、書き込みも止める。
 * ほかの取り消せない操作は Claude CLI の auto モードが決める。
 */
export const classify = (op: Operation, ctx: GuardContext): string | null => {
	if (op.tool === "Bash") return classifyBash(op.target, ctx);
	if (op.tool === "apply_patch") {
		const touched = patchPaths(op.target).map((p) =>
			absPath(p, ctx.workDir, ctx.home),
		);
		return touched.some((path) => isProtected(path, ctx, "write"))
			? PROTECTED_TOUCH
			: null;
	}
	if (PATH_TOOLS.has(op.tool)) {
		const path =
			op.tool === "Glob" || op.tool === "Grep"
				? (op.target.split(" ")[0] ?? "")
				: op.target;
		const access =
			op.tool === "Read" || op.tool === "Glob" || op.tool === "Grep"
				? "read"
				: "write";
		return isProtected(path, ctx, access) ||
			ctx.protectedDirs.some((d) => isUnder(d, path))
			? PROTECTED_TOUCH
			: null;
	}
	return null;
};

export type HookInput = {
	hook_event_name?: string;
	tool_name: string;
	tool_input: Record<string, unknown>;
	cwd?: string;
	/** PermissionDenied のとき、auto モードが止めた理由。 */
	reason?: string;
};

export type GuardRun = {
	ctx: GuardContext;
	/** 受付がこの作業に付けた投稿の ID。止めた操作をこの投稿に紐づける。 */
	threadId: string;
	/** 持ち主が許可した操作。1 つにつき 1 回だけ通す。 */
	grants: readonly Operation[];
	grantId: string | null;
};

export type Decision =
	| { decision: "allow"; reason: string }
	| { decision: "deny"; reason: string };

const denyText = (reason: string) =>
	`この操作は持ち主の許可が要るので止めた（${reason}）。別の書き方や別の道具で同じことをしない。` +
	"orca orchestration ask で、この操作が何のために要るかを短く書いて許可を求める。受付がこの操作をそのまま「決めてほしいこと」として質問に書き添える。朝会では聞かずに、決めてほしいことに入れる。";

const opOf = (input: HookInput, run: GuardRun) =>
	operationOf(
		input.tool_name,
		input.tool_input,
		input.cwd ?? run.ctx.workDir,
		run.ctx.home,
	);

/**
 * PreToolUse。持ち主が 1 回だけ許可した操作は auto モードによらず通し、秘密に触る操作は止める。
 * どちらでもなければ null を返し、auto モードに任せる。
 */
export const decide = (
	input: HookInput,
	run: GuardRun,
	ledger: Ledger,
): Decision | null => {
	const op = opOf(input, run);
	if (run.grantId !== null) {
		const granted = run.grants.filter((g) => sameOperation(g, op)).length;
		const used = ledger
			.used(run.grantId)
			.filter((g) => sameOperation(g, op)).length;
		if (used < granted) {
			ledger.markUsed(run.grantId, op);
			ledger.log({
				event: "used",
				thread_id: run.threadId,
				grant_id: run.grantId,
				operation: op,
			});
			return { decision: "allow", reason: "持ち主が 1 回だけ許可した操作" };
		}
	}
	const reason = classify(op, run.ctx);
	if (reason === null) return null;
	ledger.addPending(run.threadId, { operation: op, reason });
	ledger.log({
		event: "blocked",
		thread_id: run.threadId,
		operation: op,
		reason,
	});
	return { decision: "deny", reason: denyText(reason) };
};

/** PermissionDenied。auto モードが止めた操作を投稿に紐づけて残し、受付が質問に書き添えられるようにする。 */
export const recordDenied = (
	input: HookInput,
	run: GuardRun,
	ledger: Ledger,
) => {
	const op = opOf(input, run);
	const reason = `auto モードが止めた${input.reason ? `（${input.reason.slice(0, 200)}）` : ""}`;
	ledger.addPending(run.threadId, { operation: op, reason });
	ledger.log({
		event: "blocked",
		thread_id: run.threadId,
		operation: op,
		reason,
	});
};
