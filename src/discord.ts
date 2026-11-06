import * as v from "valibot";

const API = "https://discord.com/api/v10";
const USER_AGENT = "DiscordBot (https://github.com/ochanuco/mizuya, 0.0.0)";

// ボタンを残したまま書き換えるときに元の定義をそのまま送り返すので、知らないキーも捨てない
export const ComponentSchema = v.looseObject({
	type: v.number(),
	custom_id: v.optional(v.string()),
	components: v.optional(
		v.array(
			v.looseObject({ type: v.number(), custom_id: v.optional(v.string()) }),
		),
	),
});

export const EmbedSchema = v.looseObject({
	title: v.optional(v.string()),
	url: v.optional(v.string()),
	color: v.optional(v.number()),
	fields: v.optional(
		v.array(
			v.object({
				name: v.string(),
				value: v.string(),
				inline: v.optional(v.boolean()),
			}),
		),
	),
});

export const MessageSchema = v.object({
	id: v.string(),
	embeds: v.optional(v.array(EmbedSchema), []),
	components: v.optional(v.array(ComponentSchema), []),
});

export type Embed = v.InferOutput<typeof EmbedSchema>;
export type Message = v.InferOutput<typeof MessageSchema>;

export type MessageBody = {
	content?: string;
	embeds: Embed[];
	components: unknown[];
	allowed_mentions?: { parse: string[] };
};

export type DiscordError = {
	type: "discord_error";
	status: number;
	message: string;
};

type Result<T> = { ok: true; value: T } | { ok: false; error: DiscordError };

async function call(
	path: string,
	init: RequestInit,
	botToken: string | null,
): Promise<Result<unknown>> {
	const headers: Record<string, string> = { "user-agent": USER_AGENT };
	if (botToken) headers.authorization = `Bot ${botToken}`;
	if (init.body) headers["content-type"] = "application/json";
	const res = await fetch(`${API}${path}`, { ...init, headers });
	if (!res.ok) {
		return {
			ok: false,
			error: {
				type: "discord_error",
				status: res.status,
				message: await res.text(),
			},
		};
	}
	if (res.status === 204) return { ok: true, value: null };
	return { ok: true, value: await res.json() };
}

export async function createMessage(
	botToken: string,
	channelId: string,
	body: MessageBody,
): Promise<Result<unknown>> {
	return call(
		`/channels/${channelId}/messages`,
		{ method: "POST", body: JSON.stringify(body) },
		botToken,
	);
}

export async function editMessage(
	botToken: string,
	channelId: string,
	messageId: string,
	body: MessageBody,
): Promise<Result<unknown>> {
	return call(
		`/channels/${channelId}/messages/${messageId}`,
		{ method: "PATCH", body: JSON.stringify(body) },
		botToken,
	);
}

// 1 回の取得は 100 件まで。承認待ちが長く放置されても届くよう、さかのぼって探す
const SEARCH_PAGES = 5;

/** 新しい順にメッセージをさかのぼり、predicate に合うものをすべて返す */
export async function findMessages(
	botToken: string,
	channelId: string,
	predicate: (message: Message) => boolean,
): Promise<Result<Message[]>> {
	const found: Message[] = [];
	let before: string | null = null;
	for (let page = 0; page < SEARCH_PAGES; page++) {
		const query = before ? `limit=100&before=${before}` : "limit=100";
		const res = await call(
			`/channels/${channelId}/messages?${query}`,
			{ method: "GET" },
			botToken,
		);
		if (!res.ok) return res;
		const parsed = v.safeParse(v.array(MessageSchema), res.value);
		if (!parsed.success) {
			return {
				ok: false,
				error: {
					type: "discord_error",
					status: 200,
					message: "メッセージ一覧の応答が想定と違う",
				},
			};
		}
		found.push(...parsed.output.filter(predicate));
		const last = parsed.output.at(-1);
		if (parsed.output.length < 100 || !last) break;
		before = last.id;
	}
	return { ok: true, value: found };
}

/** 押した人にだけ見える返事を、deferred の後から送る */
export async function sendEphemeralFollowup(
	applicationId: string,
	interactionToken: string,
	content: string,
): Promise<Result<unknown>> {
	return call(
		`/webhooks/${applicationId}/${interactionToken}`,
		{
			method: "POST",
			body: JSON.stringify({
				content,
				flags: 1 << 6,
				allowed_mentions: { parse: [] },
			}),
		},
		null,
	);
}

/** deferred update のあとに、ボタンが付いていた元のメッセージを書き換える。interaction token で認証するので bot token は要らない */
export async function editInteractionOriginal(
	applicationId: string,
	interactionToken: string,
	body: MessageBody,
): Promise<Result<unknown>> {
	return call(
		`/webhooks/${applicationId}/${interactionToken}/messages/@original`,
		{ method: "PATCH", body: JSON.stringify(body) },
		null,
	);
}
