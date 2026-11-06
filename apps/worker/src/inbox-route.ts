import { type Bindings, inboxOf } from "./env.ts";
import { sameSecret } from "./signature.ts";

/**
 * Working が受け箱につなぐ口。Access の service token を通った後、さらに共有の token を確かめる。
 * Working は外向きにつなぐだけで、docker01 に入口を開けない。
 */
export async function handleInboxConnect(
	request: Request,
	env: Bindings,
): Promise<Response> {
	const token = env.WORKING_INBOX_TOKEN;
	if (!token) return new Response("not found", { status: 404 });
	const header = request.headers.get("authorization") ?? "";
	if (
		!header.startsWith("Bearer ") ||
		!(await sameSecret(header.slice("Bearer ".length), token))
	) {
		return new Response("unauthorized", { status: 401 });
	}
	if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
		return new Response("expected websocket", { status: 426 });
	}
	return inboxOf(env).fetch(request);
}
