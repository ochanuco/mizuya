import { createServer, type Server } from "node:http";
import { PARTNER_IDS, type PartnerId } from "./lib/core.ts";
import { authorized, reply } from "./server.ts";
import type { Usage, UsageWindow } from "./usage.ts";

export const SEAT_STATUS_PATH = "/seat-status/";

export type SeatStatus = {
	/** その席で作業中の数。 */
	working: number;
	/** 席で動く CLI の使用率。読めていなければ null。 */
	usage: Usage | null;
};

const windowJson = (w: UsageWindow) => ({
	used_percent: w.usedPercent,
	resets_at_ms: w.resetsAt,
});

export const seatStatusJson = (s: SeatStatus) => ({
	working: s.working,
	usage: s.usage
		? {
				five_hour: windowJson(s.usage.fiveHour),
				weekly: windowJson(s.usage.weekly),
			}
		: null,
});

const isPartner = (s: string): s is PartnerId =>
	(PARTNER_IDS as readonly string[]).includes(s);

/**
 * 席の作業中の数と使用率を、その席の bot を動かす yunomi の gateway に渡す。
 * 使用率を読む CLI のログインはこのコンテナにしかないので、表示は gateway が持ち、値だけをここで出す。
 */
export const createSeatStatusServer = (deps: {
	token: string;
	status: (partner: PartnerId) => SeatStatus;
}): Server =>
	createServer((req, res) => {
		const url = req.url ?? "";
		if (!url.startsWith(SEAT_STATUS_PATH)) return reply(res, 404);
		const partner = url.slice(SEAT_STATUS_PATH.length);
		if (!isPartner(partner)) return reply(res, 404);
		if (req.method !== "GET") return reply(res, 405);
		if (!authorized(req.headers.authorization, deps.token)) {
			return reply(res, 401);
		}
		res
			.writeHead(200, { "content-type": "application/json" })
			.end(JSON.stringify(seatStatusJson(deps.status(partner))));
	});
