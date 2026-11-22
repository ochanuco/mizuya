import type { Bindings } from "./env.ts";
import { handleInboxConnect } from "./inbox-route.ts";
import { handleDiscordInteraction } from "./interactions.ts";
import { handleGithubWebhook } from "./webhook.ts";
import { handleWorkRequest } from "./work-request.ts";

export { ApprovalLedger } from "./approval-ledger-object.ts";
export { WorkingInbox } from "./inbox-object.ts";

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const { pathname } = new URL(request.url);
		// POST 以外を 405 で返すため、method を見る前に path で分ける
		if (pathname === "/working/requests") {
			return handleWorkRequest(request, env);
		}
		const route = `${request.method} ${pathname}`;
		switch (route) {
			case "GET /health":
				return Response.json({ ok: true });
			case "POST /github/webhook":
				return handleGithubWebhook(request, env);
			case "POST /discord/interactions":
				return handleDiscordInteraction(request, env, (p) => ctx.waitUntil(p));
			case "GET /working/inbox":
				return handleInboxConnect(request, env);
			default:
				return new Response("not found", { status: 404 });
		}
	},
} satisfies ExportedHandler<Bindings>;
