import * as v from "valibot";

const API = "https://discord.com/api/v10";
const USER_AGENT = "DiscordBot (https://github.com/ochanuco/mizuya, 0.0.0)";

export const ComponentSchema = v.object({
	type: v.number(),
	custom_id: v.optional(v.string()),
	components: v.optional(
		v.array(v.object({ type: v.number(), custom_id: v.optional(v.string()) })),
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

export async function listRecentMessages(
	botToken: string,
	channelId: string,
): Promise<Result<Message[]>> {
	const res = await call(
		`/channels/${channelId}/messages?limit=100`,
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
	return { ok: true, value: parsed.output };
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
