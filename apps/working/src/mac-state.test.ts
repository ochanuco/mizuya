import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { silentLogger } from "./logger.ts";
import { createMacStateServer, openMacStateStore } from "./mac-state.ts";
import { tempDir } from "./test-support.ts";

const state = {
	sent_at: 1_793_000_000_000,
	worktrees: [
		{
			repo: "yunomi",
			branch: "dev/x",
			name: "x",
			status: "in-progress",
			active: true,
			unread: false,
			last_activity_at: 1_793_000_000_000,
			pr: { number: 12, state: "open", checks: "failure" },
			agents: [
				{
					type: "claude",
					state: "working",
					title: null,
					updated_at: 1_793_000_000_000,
				},
			],
		},
	],
};

let close = () => {};
afterEach(() => close());

const start = async () => {
	const dir = tempDir();
	const store = openMacStateStore(dir);
	const server = createMacStateServer({
		token: "mac-token",
		store,
		now: () => new Date("2026-11-05T00:30:00Z"),
		logger: silentLogger,
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	close = () => server.close();
	const { port } = server.address() as AddressInfo;
	return { store, url: `http://127.0.0.1:${port}/mac-state` };
};

const post = (url: string, body: unknown, token?: string) =>
	fetch(url, {
		method: "POST",
		headers: token ? { authorization: `Bearer ${token}` } : {},
		body: typeof body === "string" ? body : JSON.stringify(body),
	});

describe("mac-state", () => {
	it("トークンが合えば最新の 1 件を受け取り時刻つきで残す", async () => {
		const { store, url } = await start();
		expect(await store.latest()).toBeNull();
		expect((await post(url, state, "mac-token")).status).toBe(204);
		const next = { ...state, worktrees: [] };
		expect((await post(url, next, "mac-token")).status).toBe(204);
		expect(await store.latest()).toEqual({
			receivedAt: new Date("2026-11-05T00:30:00Z"),
			state: next,
		});
	});

	it("トークンが違えば 401 で、保存しない", async () => {
		const { store, url } = await start();
		expect((await post(url, state)).status).toBe(401);
		expect((await post(url, state, "working-token")).status).toBe(401);
		expect(await store.latest()).toBeNull();
	});

	it("形が違う本文は 400、ほかの経路は 404", async () => {
		const { store, url } = await start();
		expect((await post(url, "{", "mac-token")).status).toBe(400);
		expect((await post(url, { worktrees: "x" }, "mac-token")).status).toBe(400);
		expect(
			(await post(url.replace("/mac-state", "/events"), state, "mac-token"))
				.status,
		).toBe(404);
		expect(await store.latest()).toBeNull();
	});
});
