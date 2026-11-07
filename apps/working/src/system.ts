import { APPROVAL_ASK, APPROVAL_BUTTONS } from "./approval.ts";
import type { Button, DiscordApi } from "./discord-rest.ts";
import { DISMISS_ASK, DISMISS_BUTTON } from "./dismiss.ts";

/**
 * Working のボタンの custom_id の頭。mizuya の Worker はこれで始まるボタンを Working の受け箱に置く。
 * 受け箱から受け取るときに外すので、席の側の custom_id は頭を持たない。
 */
export const WORKING_BUTTON_PREFIX = "working:";

const prefixed = (buttons: readonly Button[] = []) =>
	buttons.map((b) => ({
		...b,
		customId: `${WORKING_BUTTON_PREFIX}${b.customId}`,
	}));

/**
 * mizuya の bot で書く口。許可や不要のボタン、状態の欄のようなシステムの介入はここから出す。
 * ボタンを押した操作は mizuya の application（Worker）に届くので、ボタンは mizuya の bot のメッセージに付ける。
 */
export const createSystemPoster = (rest: DiscordApi): DiscordApi => ({
	...rest,
	createForumPost: (forumId, post) =>
		rest.createForumPost(forumId, {
			...post,
			buttons: prefixed(post.buttons),
		}),
	send: (channelId, content, replyTo, files, buttons, notify) =>
		rest.send(channelId, content, replyTo, files, prefixed(buttons), notify),
});

/**
 * 席の発言のすぐ後に mizuya の bot で出す、ボタン付きのメッセージ。
 * approval なら許可と却下、dismiss なら不要のボタンを付け、押し方を書き添える。
 */
export const buttonMessage = (want: {
	approval: boolean;
	dismiss: boolean;
}) => ({
	content: [
		...(want.approval ? [APPROVAL_ASK] : []),
		...(want.dismiss ? [DISMISS_ASK] : []),
	].join("\n"),
	buttons: [
		...(want.approval ? APPROVAL_BUTTONS : []),
		...(want.dismiss ? [DISMISS_BUTTON] : []),
	],
});
