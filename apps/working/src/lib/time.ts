const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** UTC の Date を JST の `YYYY-MM-DD HH:mm:ss` に整形する。表示専用で、保存には使わない。 */
export const formatJst = (date: Date): string => {
	const shifted = new Date(date.getTime() + JST_OFFSET_MS);
	return shifted.toISOString().slice(0, 19).replace("T", " ");
};

/** JST の壁時計を UTC のフィールドとして読めるようにずらした Date。`getUTC*` で月・日・曜日を読む用で、時刻としては使わない。 */
export const toJstDate = (date: Date): Date =>
	new Date(date.getTime() + JST_OFFSET_MS);

/**
 * モデルに見せる絶対時刻の唯一の書式 `YYYY-MM-DD HH:mm JST`。UTC の ISO をそのまま渡すと、モデルが JST と取り違える。
 * 受け取るのを Date だけにして、ISO 文字列のまま prompt に入る経路を型で塞ぐ。
 */
export const formatJstForPrompt = (date: Date): string =>
	`${formatJst(date).slice(0, 16)} JST`;

/**
 * モデルに渡す JSON の唯一の直列化。Date だけを `formatJstForPrompt` にし、文字列には触れない。
 * `JSON.stringify` は replacer の前に `toJSON` を呼ぶので、元の値は `this[key]` から読む。
 * 読めない Date は `JSON.stringify` の既定どおり null にする。
 */
export const toModelJson = (value: unknown): string =>
	JSON.stringify(value, function (this: Record<string, unknown>, key, current) {
		const original = this[key];
		if (!(original instanceof Date)) return current;
		return Number.isNaN(original.getTime())
			? null
			: formatJstForPrompt(original);
	});
