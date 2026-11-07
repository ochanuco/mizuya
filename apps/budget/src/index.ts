import { handleDashboard } from "./dashboard.ts";
import type { Bindings } from "./env.ts";
import { runDaily } from "./report.ts";

export default {
	async fetch(request, env): Promise<Response> {
		const { pathname } = new URL(request.url);
		switch (`${request.method} ${pathname}`) {
			case "GET /health":
				return new Response("ok");
			case "GET /":
				return handleDashboard(env);
			default:
				return new Response("not found", { status: 404 });
		}
	},
	async scheduled(controller, env, ctx): Promise<void> {
		ctx.waitUntil(runDaily(env, new Date(controller.scheduledTime)));
	},
} satisfies ExportedHandler<Bindings>;
