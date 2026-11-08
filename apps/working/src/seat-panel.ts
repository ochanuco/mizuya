import type { SeatLabel } from "./seat-store.ts";

/** 依頼メッセージに付けるリアクション。 */
export const REACTION_OF: Readonly<Record<SeatLabel, string>> = {
	受付: "👀",
	作業中: "⏳",
	完了: "✅",
	決めてほしい: "❓",
	引き継ぎ: "❓",
	見張り中: "🔭",
};

/** 経過時間だけが変わったときに状態の欄を書き換える間隔。Discord の rate limit を食わないよう長めにとる。 */
export const PANEL_REFRESH_MS = 5 * 60_000;

const DOING_LIMIT = 300;

/** 分単位に丸める。分まで出すと、書き換える間隔より細かい変化を見せずに済む。 */
export const elapsedText = (ms: number) => {
	const minutes = Math.max(0, Math.floor(ms / 60_000));
	if (minutes < 1) return "1分未満";
	if (minutes < 60) return `${minutes}分`;
	const h = Math.floor(minutes / 60);
	const m = minutes % 60;
	return m === 0 ? `${h}時間` : `${h}時間${m}分`;
};

/**
 * 状態の欄の本文。経過時間といまやっていることは作業中の間だけ出す。
 * 作業中でない間は書き換えないので、経過時間を出すと古いまま残る。
 */
export const panelText = (p: {
	label: SeatLabel;
	elapsedMs: number | null;
	doing: string | null;
	/** 引き継ぎで記録を預けた hishaku の番号。Mac が開くのを待っている。 */
	lent?: number | null;
}) => {
	if (p.label === "引き継ぎ" && p.lent != null) {
		return `状態: Mac に貸し出し待ち（${p.lent}）`;
	}
	if (p.label !== "作業中") return `状態: ${p.label}`;
	const lines = [
		p.elapsedMs === null
			? "状態: 作業中"
			: `状態: 作業中（${elapsedText(p.elapsedMs)}）`,
	];
	const doing = (p.doing ?? "").replace(/\s+/g, " ").trim();
	if (doing !== "") {
		lines.push(
			`いまやっていること: ${doing.length > DOING_LIMIT ? `${doing.slice(0, DOING_LIMIT)}…` : doing}`,
		);
	}
	return lines.join("\n");
};
