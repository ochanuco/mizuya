import { randomUUID } from "node:crypto";
import * as v from "valibot";
import {
	type GithubWorkEvent,
	githubWorkEventSchema,
} from "./github-events.ts";
import {
	DISCORD_BUTTON_PRESSED,
	DISCORD_SOURCE,
	type DiscordButtonPressedEnvelope,
	discordButtonPressedPayloadSchema,
} from "./lib/protocol.ts";
import type { Logger } from "./logger.ts";
import { WORKING_BUTTON_PREFIX } from "./system.ts";

/**
 * mizuya の Worker の受け箱。Worker が受けたボタンと GitHub の出来事を、外向きの WebSocket で受け取る。
 * 受け取った行は ack し、Worker はそれを消す。ack する前に切れた行は、つなぎ直したときにもう一度来る。
 */

/** 接続を保つために送る文字列。Worker の Durable Object は起きずに pong を返す。 */
const PING = "ping";
const PONG = "pong";

const itemSchema = v.object({
	type: v.literal("item"),
	id: v.pipe(v.string(), v.nonEmpty()),
	kind: v.string(),
	received_at: v.pipe(v.string(), v.isoTimestamp()),
	body: v.unknown(),
});

export type InboxHandlers = {
	/** 押されたボタン。custom_id は Working の頭を外した形で渡す。 */
	press: (envelope: DiscordButtonPressedEnvelope) => void;
	/** 席を動かす GitHub の出来事。未設定なら受け取って捨てる。 */
	github?: (event: GithubWorkEvent) => void;
};

/**
 * 受け箱の 1 行を読み、渡す先に渡す。ack してよければ行の ID を返す。
 * 読めない行や知らない種類も ack し、受け箱に残し続けない。
 */
export const dispatchInboxMessage = (
	raw: string,
	handlers: InboxHandlers,
	logger: Logger,
	now: () => Date = () => new Date(),
): string | null => {
	if (raw === PONG) return null;
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		logger.warn("inbox message unreadable");
		return null;
	}
	const item = v.safeParse(itemSchema, json);
	if (!item.success) {
		logger.warn("inbox message unreadable");
		return null;
	}
	const { id, kind, received_at, body } = item.output;
	if (kind === "github") {
		const event = v.safeParse(githubWorkEventSchema, body);
		if (!event.success) {
			logger.warn("inbox github event unreadable", { id });
		} else if (handlers.github) {
			handlers.github(event.output);
		} else {
			logger.info("inbox github event dropped", {
				id,
				reason: "standup disabled",
			});
		}
		return id;
	}
	if (kind !== "button") {
		logger.warn("inbox item of unknown kind dropped", { id, kind });
		return id;
	}
	const payload = v.safeParse(discordButtonPressedPayloadSchema, body);
	if (!payload.success) {
		logger.warn("inbox button unreadable", { id });
		return id;
	}
	const customId = payload.output.custom_id;
	handlers.press({
		event_id: randomUUID(),
		type: DISCORD_BUTTON_PRESSED,
		source: DISCORD_SOURCE,
		partner_id: "yukarin",
		occurred_at: received_at,
		received_at: now().toISOString(),
		schema_version: 1,
		payload: {
			...payload.output,
			custom_id: customId.startsWith(WORKING_BUTTON_PREFIX)
				? customId.slice(WORKING_BUTTON_PREFIX.length)
				: customId,
		},
	});
	return id;
};

export type InboxConnection = {
	url: string;
	token: string;
	clientId: string;
	clientSecret: string;
};

/** つなぎ直すまでの待ち。続けて切れるたびに倍にし、上限で止める。 */
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 60_000;
/** Cloudflare は黙った WebSocket を 100 秒ほどで切るので、それより短い間隔で ping を送る。 */
const PING_EVERY_MS = 30_000;

/** 受け箱につなぎ続ける。止める関数を返す。 */
export const startInbox = (opts: {
	connection: InboxConnection;
	handlers: InboxHandlers;
	logger: Logger;
	/** テストで差し替える。 */
	connect?: (url: string, headers: Record<string, string>) => WebSocket;
}): { stop: () => void } => {
	const log = opts.logger;
	const connect =
		opts.connect ??
		((url: string, headers: Record<string, string>) =>
			// Node の WebSocket（undici）は headers を受け取る。型は標準の WebSocket に合わせてある
			new WebSocket(url, { headers } as unknown as string[]));
	let stopped = false;
	let retryMs = RETRY_MIN_MS;
	let socket: WebSocket | null = null;
	let pinger: ReturnType<typeof setInterval> | null = null;
	let retry: ReturnType<typeof setTimeout> | null = null;

	const open = () => {
		if (stopped) return;
		const ws = connect(opts.connection.url, {
			authorization: `Bearer ${opts.connection.token}`,
			"CF-Access-Client-Id": opts.connection.clientId,
			"CF-Access-Client-Secret": opts.connection.clientSecret,
		});
		socket = ws;
		ws.addEventListener("open", () => {
			retryMs = RETRY_MIN_MS;
			log.info("inbox connected");
			pinger = setInterval(() => {
				if (ws.readyState === WebSocket.OPEN) ws.send(PING);
			}, PING_EVERY_MS);
			pinger.unref?.();
		});
		ws.addEventListener("message", (e: MessageEvent) => {
			if (typeof e.data !== "string") return;
			const ack = dispatchInboxMessage(e.data, opts.handlers, log);
			if (ack !== null) ws.send(JSON.stringify({ type: "ack", id: ack }));
		});
		ws.addEventListener("error", () => {
			log.warn("inbox connection error");
		});
		ws.addEventListener("close", (e: CloseEvent) => {
			if (pinger) clearInterval(pinger);
			pinger = null;
			socket = null;
			if (stopped) return;
			log.warn("inbox disconnected", { code: e.code, retry_ms: retryMs });
			retry = setTimeout(open, retryMs);
			retry.unref?.();
			retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
		});
	};
	open();
	return {
		stop: () => {
			stopped = true;
			if (retry) clearTimeout(retry);
			if (pinger) clearInterval(pinger);
			socket?.close();
		},
	};
};
