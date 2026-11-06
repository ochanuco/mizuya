import { describe, expect, it } from "vitest";
import { callWorker, makeEnv } from "./helpers.ts";

function connect(headers: Record<string, string>) {
	return new Request("https://mizuya.example.com/working/inbox", { headers });
}

describe("GET /working/inbox", () => {
	it("token が合えば受け箱につなぐ", async () => {
		const { env, inbox } = await makeEnv();
		const { response } = await callWorker(
			connect({
				authorization: "Bearer test-inbox-token",
				upgrade: "websocket",
			}),
			env,
		);
		expect(await response.text()).toBe("connected");
		expect(inbox.connects).toHaveLength(1);
	});

	it("token が違えば 401", async () => {
		const { env, inbox } = await makeEnv();
		const { response } = await callWorker(
			connect({ authorization: "Bearer wrong", upgrade: "websocket" }),
			env,
		);
		expect(response.status).toBe(401);
		expect(inbox.connects).toHaveLength(0);
	});

	it("WebSocket でなければ 426", async () => {
		const { env } = await makeEnv();
		const { response } = await callWorker(
			connect({ authorization: "Bearer test-inbox-token" }),
			env,
		);
		expect(response.status).toBe(426);
	});

	it("token の secret が無ければ口を閉じる", async () => {
		const { env } = await makeEnv();
		delete env.WORKING_INBOX_TOKEN;
		const { response } = await callWorker(
			connect({
				authorization: "Bearer test-inbox-token",
				upgrade: "websocket",
			}),
			env,
		);
		expect(response.status).toBe(404);
	});
});
