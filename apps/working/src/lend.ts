import type { Button } from "./discord-rest.ts";
import { formatJst, formatJstForPrompt } from "./lib/core.ts";

const PREFIX = "lend:";

export type LendPress = "takeback" | "confirm" | "cancel";

/** 貸し出し中の投稿に mizuya の bot が付けるボタン。押すと取り戻すかを確かめる。 */
export const TAKEBACK_BUTTON: Button = {
	customId: `${PREFIX}takeback`,
	label: "取り戻す",
	style: "danger",
};

/** 取り戻す確認のボタン。 */
export const CONFIRM_BUTTONS: readonly Button[] = [
	{ customId: `${PREFIX}confirm`, label: "取り戻す", style: "danger" },
	{ customId: `${PREFIX}cancel`, label: "やめる", style: "secondary" },
];

/** 押されたボタンの custom_id を読む。貸し出しのボタンでなければ null。 */
export const lendPressOf = (customId: string): LendPress | null => {
	if (customId === `${PREFIX}takeback`) return "takeback";
	if (customId === `${PREFIX}confirm`) return "confirm";
	if (customId === `${PREFIX}cancel`) return "cancel";
	return null;
};

/** 日本時間の HH:MM。 */
export const hhmm = (at: Date) => formatJst(at).slice(11, 16);

export const lentText = (number: number) =>
	`Mac に貸し出しました（${number}）。席は止めています。`;

export const macResumedText = (at: Date) =>
	`Mac で再開しました（${hhmm(at)}）。`;

export const MAC_RETURNED_TEXT =
	"Mac から戻りました。この投稿に書けば、席が前の会話のまま続けます。";

/** Mac が返したとき、貸し出し中に溜めた書き込みがあった。 */
export const MAC_RETURNED_WITH_HELD_TEXT =
	"Mac から戻りました。貸し出し中の書き込みを席に渡して、前の会話のまま続けます。";

export const heldText = (number: number) =>
	`いまは Mac で作業中です（${number}）。この書き込みは Mac が返したあとに席へ渡します。すぐこちらで続けるなら「取り戻す」を押してください。`;

export const takebackConfirmText = (number: number, savedAt: Date | null) =>
	`Mac はまだ ${number} を持っています${savedAt ? `（最後に預けたのは ${hhmm(savedAt)}）` : ""}。取り戻すと、Mac でそのあとに進んだ分は正本に入らず、枝として残ります。`;

export const TAKEBACK_CANCELLED_TEXT = "取り戻すのをやめました。";

export const takenBackText = (generation: number | null) =>
	generation === null
		? "取り戻しました。席を前の会話のまま起こします。"
		: `取り戻しました（世代 ${generation}）。席を前の会話のまま起こします。`;

/** 取り戻したあとに担当の人格が書く。 */
export const backFromMacText = (pushedAt: Date | null) =>
	pushedAt
		? `戻りました。Mac で ${hhmm(pushedAt)} までに進めたところから続けますね。`
		: "戻りました。Mac で進めたところから続けますね。";

/** 取り戻した席に渡す。Mac で最後に預けたあとの分は正本に無い。 */
export const takebackNote = (pushedAt: Date | null) =>
	`持ち主が Mac からこの投稿の会話を取り戻した。${pushedAt ? `Mac が最後に預けた ${formatJstForPrompt(pushedAt)} より後に` : "Mac で最後に預けたより後に"}進めた分は、この会話に入っていない。投稿のやりとりを見て続ける。`;

/** Mac が返したあとに席に渡す。 */
export const RETURNED_NOTE =
	"Mac で進めていたこの投稿の会話が戻ってきた。以下は Mac に貸している間に持ち主が投稿に書いたこと。";
