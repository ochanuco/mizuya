import * as v from "valibot";
import { COMMANDS } from "./commands.ts";

const API = "https://discord.com/api/v10";
const USER_AGENT = "DiscordBot (https://github.com/ochanuco/mizuya, 0.0.0)";

const ApplicationSchema = v.object({ id: v.string() });

export type RegisterError = {
	step: "application" | "commands";
	status: number;
	message: string;
};

/**
 * `/ai` などの定義を mizuya の application にグローバル登録する。bulk overwrite なので、定義から消したコマンドは Discord からも消える。
 * application の ID は bot token から引き、deploy に secret を増やさない。
 */
export async function registerCommands(
	botToken: string,
	doFetch: typeof fetch = fetch,
): Promise<{ ok: true; count: number } | { ok: false; error: RegisterError }> {
	const headers = {
		authorization: `Bot ${botToken}`,
		"user-agent": USER_AGENT,
		"content-type": "application/json",
	};
	const app = await doFetch(`${API}/applications/@me`, { headers });
	if (!app.ok) {
		return {
			ok: false,
			error: {
				step: "application",
				status: app.status,
				message: await app.text(),
			},
		};
	}
	const parsed = v.safeParse(ApplicationSchema, await app.json());
	if (!parsed.success) {
		return {
			ok: false,
			error: {
				step: "application",
				status: app.status,
				message: "application の応答が想定と違う",
			},
		};
	}
	const res = await doFetch(
		`${API}/applications/${parsed.output.id}/commands`,
		{
			method: "PUT",
			headers,
			body: JSON.stringify(COMMANDS),
		},
	);
	if (!res.ok) {
		return {
			ok: false,
			error: {
				step: "commands",
				status: res.status,
				message: await res.text(),
			},
		};
	}
	return { ok: true, count: COMMANDS.length };
}
