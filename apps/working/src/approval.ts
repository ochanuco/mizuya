import type { ApprovalRequest } from "./approval-store.ts";
import type { Button } from "./discord-rest.ts";
import type { Pending } from "./guard/ledger.ts";
import { type Operation, sameOperation } from "./guard/operation.ts";
import { formatJstForPrompt } from "./lib/core.ts";

/** 許可の返事として受け付ける言い方。あいまいな返事で取り消せない操作を通さないよう、これだけにする。 */
const APPROVAL_WORDS = new Set(["ok", "許可", "許可します"]);

const MENTION = /<@[!&]?\d+>/g;

/**
 * 持ち主の発言が、待っている操作への許可かどうか。決まった言い方だけを許可とみなす。
 * 返信の形で送られたときは、許可を求めたメッセージへの返信でなければ許可としない。
 */
export const isApproval = (
	message: { content: string; replyToMessageId: string | null },
	request: ApprovalRequest,
): boolean => {
	const word = message.content
		.replace(MENTION, "")
		.normalize("NFKC")
		.trim()
		.replace(/[。.!！]+$/, "")
		.toLowerCase();
	if (!APPROVAL_WORDS.has(word)) return false;
	return (
		message.replyToMessageId === null ||
		request.messageIds.includes(message.replyToMessageId)
	);
};

/** 同じ操作が何度止められても 1 つにまとめる。 */
export const uniquePending = (items: readonly Pending[]): Pending[] => {
	const out: Pending[] = [];
	for (const p of items) {
		if (!out.some((q) => sameOperation(q.operation, p.operation))) out.push(p);
	}
	return out;
};

const fence = (text: string) => {
	const ticks = text.includes("```") ? "````" : "```";
	return `${ticks}\n${text}\n${ticks}`;
};

const describe = (op: Operation) =>
	op.tool === "Bash" ? fence(op.target) : fence(`${op.tool}: ${op.target}`);

const APPROVAL_ASK =
	"実行してよければ「許可」を押すか、この投稿に「OK」か「許可」とだけ返事してください。書いてある操作を 1 回だけ実行します。「却下」を押すか、ほかの返事をすると取りやめます。";

/** 止めた操作を持ち主に見せ、許可を求めるメッセージ。 */
export const approvalRequestText = (items: readonly Pending[]) => {
	const list = items
		.map((p, i) => `${i + 1}. ${p.reason}\n${describe(p.operation)}`)
		.join("\n");
	return `決めてほしいこと: 次の操作は取り消せないか外に出るので、止めています。

${list}

${APPROVAL_ASK}`;
};

export type ApprovalAnswer = "grant" | "deny";

const BUTTON_PREFIX = "approval:";

/** 許可を求めるメッセージに付けるボタン。どの操作かはボタンが付いたメッセージの ID で引く。 */
export const APPROVAL_BUTTONS: readonly Button[] = [
	{ customId: `${BUTTON_PREFIX}grant`, label: "許可", style: "success" },
	{ customId: `${BUTTON_PREFIX}deny`, label: "却下", style: "danger" },
];

/** 押されたボタンの custom_id を読む。許可のボタンでなければ null。 */
export const approvalAnswerOf = (customId: string): ApprovalAnswer | null => {
	if (customId === `${BUTTON_PREFIX}grant`) return "grant";
	if (customId === `${BUTTON_PREFIX}deny`) return "deny";
	return null;
};

/** 片付いた許可の依頼の本文。ボタンを外し、頼みの文を結果に置き換える。 */
export const settledApprovalText = (
	content: string,
	answer: ApprovalAnswer,
) => {
	const result =
		answer === "grant"
			? "許可済み: 書いてある操作を 1 回だけ実行します。"
			: "却下済み: 書いてある操作は実行しません。";
	return content.includes(APPROVAL_ASK)
		? content.replace(APPROVAL_ASK, result)
		: `${content}\n\n${result}`;
};

/** 許可したあと、Claude CLI に続きをさせる指示。 */
export const approvedNote = (operations: readonly Operation[]) =>
	`持ち主が、止められていた次の操作を 1 回だけ許可した。書いてあるとおり一字一句同じ内容で実行し、作業を続ける。同じ操作をもう一度するときは、また許可が要る。

${operations.map((op, i) => `${i + 1}.\n${describe(op)}`).join("\n")}`;

export const approvedPrompt = (input: {
	now: Date;
	authorName: string;
	content: string;
	operations: readonly Operation[];
}) => `いま: ${formatJstForPrompt(input.now)}
${input.authorName}: ${input.content}

${approvedNote(input.operations)}`;
