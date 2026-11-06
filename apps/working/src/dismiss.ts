import type { Button } from "./discord-rest.ts";

const DISMISS_ID = "thread:dismiss";

/** 持ち主の判断を待つ投稿に付けるボタン。押すと席の Claude を通さずに投稿を閉じる。 */
export const DISMISS_BUTTON: Button = {
	customId: DISMISS_ID,
	label: "不要",
	style: "secondary",
};

export const isDismissButton = (customId: string) => customId === DISMISS_ID;

const DISMISSED_TEXT = "不要として閉じました。";

/** 閉じた投稿のボタンを外したあとの本文。 */
export const dismissedText = (content: string) =>
	content.trim() === "" ? DISMISSED_TEXT : `${content}\n\n${DISMISSED_TEXT}`;
