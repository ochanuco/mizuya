import { timingSafeEqual } from "node:crypto";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";

const BODY_LIMIT = 1_000_000;

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

/** 生存確認だけを返す。image の HEALTHCHECK が読む。 */
export const createHealthServer = (): Server =>
	createServer((req, res) => {
		if (req.method === "GET" && req.url === "/healthz") return reply(res, 200);
		return reply(res, 404);
	});
