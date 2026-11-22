import type { PartnerId } from "./lib/core.ts";
import type { Logger } from "./logger.ts";

/** 出来事の種類。完了のときだけ、投稿に付けた状態を添える。 */
export type SeatEventKind =
	| { event: "started" | "asking" | "failed"; status?: never }
	| { event: "done"; status: "完了" | "見張り中" | "引き継ぎ" };

/** Talking に知らせる席の出来事。 */
export type SeatEvent = {
	threadId: string;
	title: string | null;
	summary: string | null;
	at: Date;
} & SeatEventKind;

/** 受付が席の出来事を知らせる口。待たずに返り、失敗しても席の流れを止めない。 */
export type TellTalking = (
	partner: PartnerId,
	event: SeatEvent,
) => void | Promise<void>;

/** yunomi の Worker の /working/events の検証と揃える。 */
export const EVENT_TITLE_MAX_LENGTH = 100;
export const EVENT_SUMMARY_MAX_LENGTH = 200;
const FALLBACK_TITLE = "仕事フォーラムの投稿";

/**
 * 改行と連なる空白を 1 つの空白にし、max 字で切る。
 * Worker の検証は UTF-16 の長さで数えるのでそれに合わせ、サロゲートペアの途中では切らない。
 */
export const oneLine = (text: string, max: number): string => {
	const flat = text.replace(/\s+/g, " ").trim();
	if (flat.length <= max) return flat;
	let out = "";
	for (const ch of flat) {
		if (out.length + ch.length > max) break;
		out += ch;
	}
	return out.trimEnd();
};

export const seatEventBody = (e: SeatEvent) => {
	const summary =
		e.summary === null ? "" : oneLine(e.summary, EVENT_SUMMARY_MAX_LENGTH);
	return {
		thread_id: e.threadId,
		title: oneLine(e.title ?? "", EVENT_TITLE_MAX_LENGTH) || FALLBACK_TITLE,
		event: e.event,
		status: e.event === "done" ? e.status : null,
		summary: summary === "" ? null : summary,
		at: e.at.toISOString(),
	};
};

export type SeatEventSenderOptions = {
	/** Working の記憶の口と同じ接続先と service token。無ければ知らせない。 */
	memory: { url: string; clientId: string; clientSecret: string } | null;
	logger: Logger;
	fetch?: typeof fetch;
	timeoutMs?: number;
	retryDelayMs?: number;
};

/**
 * 席の出来事を yunomi の Worker の /v1/partners/:id/working/events に送る。
 * Worker は投稿ごとに最新の状態だけを残し古い at を捨てるので、届かなかったときは 1 回だけ送り直す。
 * 4xx は送り直しても同じ答えなので送り直さない。
 */
export const createSeatEventSender = (
	opts: SeatEventSenderOptions,
): TellTalking => {
	const log = opts.logger;
	const memory = opts.memory;
	const doFetch = opts.fetch ?? fetch;
	const timeoutMs = opts.timeoutMs ?? 5_000;
	const retryDelayMs = opts.retryDelayMs ?? 3_000;

	const post = async (
		url: string,
		body: string,
	): Promise<{ retry: boolean; fields: Record<string, unknown> } | null> => {
		if (!memory) return null;
		try {
			const res = await doFetch(url, {
				method: "POST",
				headers: {
					"CF-Access-Client-Id": memory.clientId,
					"CF-Access-Client-Secret": memory.clientSecret,
					"content-type": "application/json",
				},
				body,
				signal: AbortSignal.timeout(timeoutMs),
			});
			if (res.ok) return null;
			const text = await res.text().catch(() => "");
			let code: string | null = null;
			try {
				const e = JSON.parse(text) as { error?: unknown };
				if (typeof e.error === "string") code = e.error;
			} catch {}
			return {
				retry: res.status >= 500,
				fields: { status: res.status, error: code },
			};
		} catch (e) {
			return {
				retry: true,
				fields: { error: e instanceof Error ? e.name : "unknown" },
			};
		}
	};

	const send = async (partner: PartnerId, e: SeatEvent) => {
		if (!memory) return;
		const url = `${memory.url.replace(/\/$/, "")}/v1/partners/${encodeURIComponent(partner)}/working/events`;
		const body = JSON.stringify(seatEventBody(e));
		let failed = await post(url, body);
		if (failed?.retry) {
			await new Promise<void>((resolve) => {
				setTimeout(resolve, retryDelayMs).unref();
			});
			failed = await post(url, body);
		}
		if (failed) {
			log.warn("seat event not delivered", {
				thread_id: e.threadId,
				event: e.event,
				partner,
				...failed.fields,
			});
		}
	};

	return (partner, e) => {
		if (!memory) {
			log.debug("seat event skipped; working memory disabled", {
				thread_id: e.threadId,
				event: e.event,
			});
			return;
		}
		send(partner, e).catch(() => {});
	};
};
