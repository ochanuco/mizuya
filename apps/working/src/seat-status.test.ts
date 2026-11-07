import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createSeatStatusServer } from "./seat-status.ts";

let close = () => {};
afterEach(() => close());

const start = async () => {
	const server = createSeatStatusServer({
		token: "seat-token",
		status: (partner) =>
			partner === "yukarin"
				? {
						working: 2,
						usage: {
							fiveHour: { usedPercent: 30.4, resetsAt: 1_793_000_000_000 },
							weekly: { usedPercent: 12, resetsAt: null },
						},
					}
				: { working: 0, usage: null },
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	close = () => server.close();
	const { port } = server.address() as AddressInfo;
	return `http://127.0.0.1:${port}/seat-status`;
};

const get = (url: string, token?: string, method = "GET") =>
	fetch(url, {
		method,
		headers: token ? { authorization: `Bearer ${token}` } : {},
	});

describe("seat-status", () => {
	it("席ごとに作業中の数と使用率を返す", async () => {
		const base = await start();
		const res = await get(`${base}/yukarin`, "seat-token");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			working: 2,
			usage: {
				five_hour: { used_percent: 30.4, resets_at_ms: 1_793_000_000_000 },
				weekly: { used_percent: 12, resets_at_ms: null },
			},
		});
		expect(await (await get(`${base}/akarin`, "seat-token")).json()).toEqual({
			working: 0,
			usage: null,
		});
	});

	it("トークンが違えば 401、知らない席と経路は 404、GET 以外は 405", async () => {
		const base = await start();
		expect((await get(`${base}/yukarin`)).status).toBe(401);
		expect((await get(`${base}/yukarin`, "other")).status).toBe(401);
		expect((await get(`${base}/mizuya`, "seat-token")).status).toBe(404);
		expect((await get(`${base.replace("/seat-status", "/x")}`)).status).toBe(
			404,
		);
		expect((await get(`${base}/yukarin`, "seat-token", "POST")).status).toBe(
			405,
		);
	});
});
