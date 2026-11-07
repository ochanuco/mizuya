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

/**
 * `/ai` コマンド。request は投稿の外の modal で書かれた依頼、model は投稿の中でのモデルの切り替え。
 * 本人にだけ見える返事は application_id と token で書き換える。
 */
export type CommandEvent = {
	event_id: string;
	payload: {
		type: "request" | "model";
		application_id: string;
		token: string;
		guild_id: string;
		channel_id: string;
		user: { id: string; display_name: string; is_bot: boolean };
		agent: "claude" | "codex";
		model: string;
		/** request のときだけ持つ。 */
		content: string | null;
	};
};
