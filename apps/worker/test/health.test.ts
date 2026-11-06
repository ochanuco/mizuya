import { describe, expect, it } from "vitest";
import { callWorker, makeEnv } from "./helpers.ts";

describe("routing", () => {
	it("GET /health は 200", async () => {
		const { env } = await makeEnv();
		const { response } = await callWorker(
			new Request("https://mizuya.example.com/health"),
			env,
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
	});

	it("知らない経路は 404", async () => {
		const { env } = await makeEnv();
		const { response } = await callWorker(
			new Request("https://mizuya.example.com/github/webhook"),
			env,
		);
		expect(response.status).toBe(404);
	});
});
