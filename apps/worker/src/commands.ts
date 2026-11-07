/**
 * `/ai <相手> <モデル>`。相手（claude / codex）をサブコマンドグループ、モデルをサブコマンドにし、
 * 相手ごとに選べるモデルをコマンドの形で絞る。席の側の対応は Working の `seat-model.ts` と揃える。
 */
export const AI_COMMAND_NAME = "ai";

export const SEAT_MODELS = {
	claude: ["opus", "sonnet", "haiku"],
	codex: ["terra", "sol", "luna"],
} as const;

export type SeatAgent = keyof typeof SEAT_MODELS;
export type AiChoice = { agent: SeatAgent; model: string };

const AGENT_DESCRIPTION: Record<SeatAgent, string> = {
	claude: "Yukarin（Claude）に頼む",
	codex: "Akarin（Codex）に頼む",
};

const OptionType = { SUB_COMMAND: 1, SUB_COMMAND_GROUP: 2 } as const;
const InteractionContext = { GUILD: 0 } as const;
const IntegrationType = { GUILD_INSTALL: 0 } as const;

export const capitalized = (model: string) =>
	`${model.charAt(0).toUpperCase()}${model.slice(1)}`;

/** application に登録する定義。登録は bulk overwrite なので、ここに無いコマンドは消える。 */
export const COMMANDS = [
	{
		name: AI_COMMAND_NAME,
		type: 1,
		description: "仕事の依頼を立てるか、投稿の中で席のモデルを変える",
		contexts: [InteractionContext.GUILD],
		integration_types: [IntegrationType.GUILD_INSTALL],
		options: (Object.keys(SEAT_MODELS) as SeatAgent[]).map((agent) => ({
			type: OptionType.SUB_COMMAND_GROUP,
			name: agent,
			description: AGENT_DESCRIPTION[agent],
			options: SEAT_MODELS[agent].map((model) => ({
				type: OptionType.SUB_COMMAND,
				name: model,
				description: `${capitalized(model)} で動かす`,
			})),
		})),
	},
];

export type CommandOption = {
	name: string;
	type: number;
	options?: CommandOption[] | undefined;
};

const isAgent = (name: string): name is SeatAgent =>
	Object.hasOwn(SEAT_MODELS, name);

const choiceOf = (agent: string, model: string): AiChoice | null => {
	if (!isAgent(agent)) return null;
	return (SEAT_MODELS[agent] as readonly string[]).includes(model)
		? { agent, model }
		: null;
};

/** `/ai` の options から相手とモデルを読む。定義に無い組み合わせは null。 */
export const aiChoiceOf = (data: {
	name?: string | undefined;
	options?: CommandOption[] | undefined;
}): AiChoice | null => {
	if (data.name !== AI_COMMAND_NAME) return null;
	const group = data.options?.[0];
	const sub = group?.options?.[0];
	if (
		group?.type !== OptionType.SUB_COMMAND_GROUP ||
		sub?.type !== OptionType.SUB_COMMAND
	) {
		return null;
	}
	return choiceOf(group.name, sub.name);
};

/** 依頼を書く modal の custom_id。送信されたときに相手とモデルをここから読む。 */
const MODAL_PREFIX = "ai:";
export const REQUEST_FIELD = "request";

export const modalIdOf = (choice: AiChoice) =>
	`${MODAL_PREFIX}${choice.agent}:${choice.model}`;

export const choiceOfModalId = (customId: string): AiChoice | null => {
	if (!customId.startsWith(MODAL_PREFIX)) return null;
	const [agent = "", model = ""] = customId
		.slice(MODAL_PREFIX.length)
		.split(":");
	return choiceOf(agent, model);
};

const ComponentType = { ACTION_ROW: 1, TEXT_INPUT: 4 } as const;
const TextInputStyle = { PARAGRAPH: 2 } as const;
/** Discord の text input の上限。 */
const REQUEST_MAX_LENGTH = 4000;

/** スラッシュコマンドの文字列の引数には改行を入れられないので、依頼は modal の複数行の欄で受ける。 */
export const requestModal = (choice: AiChoice) => ({
	custom_id: modalIdOf(choice),
	title: `依頼（${capitalized(choice.model)}）`,
	components: [
		{
			type: ComponentType.ACTION_ROW,
			components: [
				{
					type: ComponentType.TEXT_INPUT,
					custom_id: REQUEST_FIELD,
					label: "依頼",
					style: TextInputStyle.PARAGRAPH,
					required: true,
					max_length: REQUEST_MAX_LENGTH,
				},
			],
		},
	],
});
