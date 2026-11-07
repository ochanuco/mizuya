/**
 * 受付が扱う Discord の出来事。メッセージは受付が Gateway から、ボタンは mizuya の Worker の受け箱から受け取って作る。
 * event_id はログで一つの出来事を追うためのもの。
 */

/** 仕事テキストチャンネルか、仕事フォーラムの投稿に書かれたメッセージ。 */
export type WorkMessageEvent = {
	event_id: string;
	payload: {
		guild_id: string;
		channel_id: string;
		message_id: string;
		author: { id: string; display_name: string; is_bot: boolean };
		content: string;
		/** メンションされたユーザー。 */
		mentions: string[];
		/** メンションされた role。 */
		mention_roles: string[];
		reply_to_message_id: string | null;
		attachments: { name: string; content_type: string | null; size: number }[];
	};
};

/** 席のメッセージに付けたボタンが押された。custom_id は Working の頭を外した形。 */
export type ButtonPressEvent = {
	event_id: string;
	payload: {
		guild_id: string;
		channel_id: string;
		message_id: string;
		custom_id: string;
		user: { id: string; display_name: string; is_bot: boolean };
	};
};
