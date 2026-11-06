/** フォーラム投稿のタグ名。フォーラム側に同じ名前のタグを作っておく。 */
export const WORK_STATUSES = [
	"決めてほしい",
	"作業中",
	"引き継ぎ",
	"完了",
	"見張り中",
] as const;
export type WorkStatus = (typeof WORK_STATUSES)[number];

const MARKER = new RegExp(
	`^\\s*状態\\s*[:：]\\s*(${WORK_STATUSES.join("|")})\\s*$`,
);

/**
 * 返事の最後の行の「状態: …」を読み、投稿に出す本文から外す。
 * 書き忘れたときは人の返事を待っているとみなす。
 */
export const takeStatus = (
	text: string,
): { body: string; status: WorkStatus } => {
	const lines = text.trimEnd().split("\n");
	const last = lines.at(-1) ?? "";
	const m = MARKER.exec(last);
	if (!m) return { body: text.trim(), status: "決めてほしい" };
	return {
		body: lines.slice(0, -1).join("\n").trim(),
		status: m[1] as WorkStatus,
	};
};

/** 状態のタグだけを入れ替え、人が付けた他のタグは残す。 */
export const replaceStatusTag = (
	applied: readonly string[],
	tagIdOf: ReadonlyMap<WorkStatus, string>,
	status: WorkStatus,
): string[] => {
	const statusIds = new Set(tagIdOf.values());
	const next = applied.filter((id) => !statusIds.has(id));
	const id = tagIdOf.get(status);
	return id ? [...next, id] : next;
};
