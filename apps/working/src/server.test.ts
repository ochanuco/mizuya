import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createHealthServer } from "./server.ts";

let close = () => {};
afterEach(() => close());

describe("createHealthServer", () => {
	it("healthz にだけ 200 を返し、ほかは 404", async () => {
		const server = createHealthServer();
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		close = () => server.close();
		const { port } = server.address() as AddressInfo;
		const base = `http://127.0.0.1:${port}`;
		expect((await fetch(`${base}/healthz`)).status).toBe(200);
		expect((await fetch(`${base}/events`, { method: "POST" })).status).toBe(
			404,
		);
		expect((await fetch(`${base}/seats/summary`)).status).toBe(404);
	});
});
