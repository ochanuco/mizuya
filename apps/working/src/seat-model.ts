import type { PartnerId } from "./lib/core.ts";
import type { SeatAgent } from "./seat-engine.ts";

/** `/ai` で選べるモデル。mizuya の Worker の `commands.ts` と揃える。 */
export const SEAT_MODELS: Record<SeatAgent, readonly string[]> = {
	claude: ["opus", "sonnet", "haiku"],
	codex: ["terra", "sol", "luna"],
};

/** フォーラムのモデルのタグ名と、投稿に書く名前。フォーラム側に同じ名前のタグを作っておく。 */
export const modelName = (model: string) =>
	`${model.charAt(0).toUpperCase()}${model.slice(1)}`;

export const MODEL_TAGS: readonly string[] = Object.values(SEAT_MODELS)
	.flat()
	.map(modelName);

/** モデルを選んでいない席は CLI の既定のモデルで動く。 */
export const modelLabel = (model: string | null) =>
	model === null ? "既定のモデル" : modelName(model);

/** モデルのタグだけを入れ替え、状態のタグと人が付けたタグは残す。 */
export const replaceModelTag = (
	applied: readonly string[],
	tagIdOf: ReadonlyMap<string, string>,
	model: string | null,
): string[] => {
	const modelIds = new Set(tagIdOf.values());
	const next = applied.filter((id) => !modelIds.has(id));
	const id = model === null ? undefined : tagIdOf.get(modelName(model));
	return id ? [...next, id] : next;
};

export const modelChangedText = (by: string, from: string | null, to: string) =>
	`${by} がモデルを ${modelLabel(from)} → ${modelLabel(to)} に変えました`;

const PARTNER_NAMES: Record<PartnerId, string> = {
	yukarin: "ゆかりさん",
	akarin: "あかりちゃん",
};

export const partnerName = (partner: PartnerId) => PARTNER_NAMES[partner];

/** 担当と違う相手の `/ai` を投稿の中で打たれたときの返事。 */
export const otherPartnerText = (partner: PartnerId, agent: SeatAgent) =>
	`この投稿は${partnerName(partner)}が担当しています。モデルは \`/ai ${agent} …\` で変えられます。`;
