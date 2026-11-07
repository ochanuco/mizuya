import type { Result } from "./env.ts";

const API = "https://discord.com/api/v10";
const USER_AGENT = "DiscordBot (https://github.com/ochanuco/mizuya, 0.0.0)";

export type Embed = {
	title?: string;
	url?: string;
	description?: string;
	color?: number;
	fields?: { name: string; value: string; inline?: boolean }[];
	footer?: { text: string };
};

export type MessageBody = {
	content?: string;
	embeds: Embed[];
	allowed_mentions: { parse: string[]; users?: string[] };
};

export type DiscordError = {
	type: "discord_error";
	status: number;
	message: string;
};

export async function createMessage(
	botToken: string,
	channelId: string,
	body: MessageBody,
): Promise<Result<null, DiscordError>> {
	const res = await fetch(`${API}/channels/${channelId}/messages`, {
		method: "POST",
		headers: {
			"user-agent": USER_AGENT,
			authorization: `Bot ${botToken}`,
			"content-type": "application/json",
		},
		body: JSON.stringify(body),
	});
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
	return { ok: true, value: null };
}
