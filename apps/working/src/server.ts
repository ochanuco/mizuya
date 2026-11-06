import { timingSafeEqual } from "node:crypto";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import * as v from "valibot";
import type { SeatSummary } from "./intake.ts";
import type { PartnerId } from "./lib/core.ts";
import {
	DISCORD_BUTTON_PRESSED,
	type DiscordButtonPressedEnvelope,
	type DiscordMessageCreatedEnvelope,
	discordButtonPressedEnvelopeSchema,
	discordMessageCreatedEnvelopeSchema,
} from "./lib/protocol.ts";
import type { Logger } from "./logger.ts";
import type { Usage } from "./usage.ts";

export const EVENTS_PATH = "/events";
export const SEATS_SUMMARY_PATH = "/seats/summary";
const BODY_LIMIT = 1_000_000;

export type ServerDeps = {
	sharedToken: string;
	accept: (envelope: DiscordMessageCreatedEnvelope) => void;
	/** 仕事カテゴリで押されたボタン。 */
	press: (envelope: DiscordButtonPressedEnvelope) => void;
	/** gateway が bot のステータスに出す。各 gateway は自分のパートナーの分を読む。 */
	seatSummary: () => WorkingSummary;
	logger: Logger;
};

/** 作業中の席の数と、パートナーの席で動く CLI の使用率。読めていない使用率は載せない。 */
export type WorkingSummary = SeatSummary & {
	usage: Partial<Record<PartnerId, Usage>>;
};

export const authorized = (
	header: string | undefined,
	token: string,
): boolean => {
	if (!header?.startsWith("Bearer ")) return false;
	const given = Buffer.from(header.slice("Bearer ".length));
	const expected = Buffer.from(token);
	return given.length === expected.length && timingSafeEqual(given, expected);
};

export const readBody = (req: IncomingMessage): Promise<string | null> =>
	new Promise((resolve) => {
		let size = 0;
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => {
			size += c.length;
			if (size > BODY_LIMIT) {
				resolve(null);
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", () => resolve(null));
	});

export const reply = (res: ServerResponse, status: number) => {
	res.writeHead(status).end();
};

/**
 * gateway から発言とボタンの envelope を受け、席の数を返す。仕事は数分かかるので、受け取った時点で 202 を返し、処理は待たない。
 */
export const createWorkingServer = (deps: ServerDeps): Server =>
	createServer(async (req, res) => {
		if (req.method === "GET" && req.url === "/healthz") return reply(res, 200);
		if (req.url === SEATS_SUMMARY_PATH) {
			if (req.method !== "GET") return reply(res, 405);
			if (!authorized(req.headers.authorization, deps.sharedToken)) {
				return reply(res, 401);
			}
			res
				.writeHead(200, { "content-type": "application/json" })
				.end(JSON.stringify(deps.seatSummary()));
			return;
		}
		if (req.url !== EVENTS_PATH) return reply(res, 404);
		if (req.method !== "POST") return reply(res, 405);
		if (!authorized(req.headers.authorization, deps.sharedToken)) {
			return reply(res, 401);
		}
		const raw = await readBody(req);
		if (raw === null) return reply(res, 413);
		let json: unknown;
		try {
			json = JSON.parse(raw);
		} catch {
			return reply(res, 400);
		}
		const invalid = (issues: readonly v.BaseIssue<unknown>[]) => {
			deps.logger.warn("invalid envelope", {
				issues: issues.map((i) => i.message),
			});
			return reply(res, 400);
		};
		if (
			typeof json === "object" &&
			json !== null &&
			"type" in json &&
			json.type === DISCORD_BUTTON_PRESSED
		) {
			const parsed = v.safeParse(discordButtonPressedEnvelopeSchema, json);
			if (!parsed.success) return invalid(parsed.issues);
			deps.press(parsed.output as DiscordButtonPressedEnvelope);
			return reply(res, 202);
		}
		const parsed = v.safeParse(discordMessageCreatedEnvelopeSchema, json);
		if (!parsed.success) return invalid(parsed.issues);
		deps.accept(parsed.output as DiscordMessageCreatedEnvelope);
		return reply(res, 202);
	});
