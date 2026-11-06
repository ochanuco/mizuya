import { DurableObject } from "cloudflare:workers";
import type { Bindings } from "./env.ts";
import {
	createInbox,
	type Inbox,
	type InboxKind,
	type InboxPush,
	RETENTION_MS,
} from "./inbox.ts";

/**
 * 受け箱を 1 つだけ持つ Durable Object。WebSocket は hibernation で受け、待っている間は起きていない。
 */
export class WorkingInbox extends DurableObject<Bindings> {
	private readonly inbox: Inbox;

	constructor(ctx: DurableObjectState, env: Bindings) {
		super(ctx, env);
		this.inbox = createInbox(ctx.storage.sql);
	}

	/** Working の接続を受け、溜まっている行を渡す。 */
	override async fetch(request: Request): Promise<Response> {
		if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
			return new Response("expected websocket", { status: 426 });
		}
		const { 0: client, 1: server } = new WebSocketPair();
		this.ctx.acceptWebSocket(server);
		for (const item of this.inbox.pending()) {
			server.send(
				JSON.stringify({ type: "item", ...item } satisfies InboxPush),
			);
		}
		return new Response(null, { status: 101, webSocket: client });
	}

	/** 置いて、つながっている Working にすぐ渡す。つながっていなければ次の接続で渡す。 */
	async put(
		kind: InboxKind,
		body: unknown,
		dedupe: string | null = null,
	): Promise<boolean> {
		const item = this.inbox.put(kind, body, dedupe);
		if (!item) return false;
		const message = JSON.stringify({
			type: "item",
			...item,
		} satisfies InboxPush);
		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.send(message);
			} catch {
				// 切れかけの接続は close の通知で片付く
			}
		}
		if ((await this.ctx.storage.getAlarm()) === null) {
			await this.ctx.storage.setAlarm(Date.now() + RETENTION_MS);
		}
		return true;
	}

	override async webSocketMessage(
		_ws: WebSocket,
		message: string | ArrayBuffer,
	): Promise<void> {
		if (typeof message === "string") this.inbox.ack(message);
	}

	override async webSocketClose(
		ws: WebSocket,
		code: number,
		reason: string,
	): Promise<void> {
		ws.close(code, reason);
	}

	override async alarm(): Promise<void> {
		this.inbox.purge();
		if (this.inbox.pending().length > 0) {
			await this.ctx.storage.setAlarm(Date.now() + RETENTION_MS);
		}
	}
}
