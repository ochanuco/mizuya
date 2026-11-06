import type { Bindings } from "./env.ts";
import { handleDiscordInteraction } from "./interactions.ts";
import { handleGithubWebhook } from "./webhook.ts";

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const { pathname } = new URL(request.url);
		const route = `${request.method} ${pathname}`;
		switch (route) {
			case "GET /health":
				return Response.json({ ok: true });
			case "POST /github/webhook":
				return handleGithubWebhook(request, env);
			case "POST /discord/interactions":
				return handleDiscordInteraction(request, env, (p) => ctx.waitUntil(p));
			default:
				return new Response("not found", { status: 404 });
		}
	},
} satisfies ExportedHandler<Bindings>;
