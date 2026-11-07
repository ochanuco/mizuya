import { afterEach, describe, expect, it, vi } from "vitest";
import { dashboardView } from "../src/dashboard.ts";
import { runDaily } from "../src/report.ts";
import {
	ACCOUNT_ID,
	APPROVER_ID,
	billingInfo,
	type Call,
	CHANNEL_ID,
	envelope,
	makeEnv,
	mockFetch,
	record,
} from "./fixtures.ts";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

const NOW = new Date("2026-11-07T01:00:00Z");

type Options = {
	usage?: unknown[];
	usageStatus?: number;
	discordStatus?: number;
};

function cloudflareAndDiscord({
	usage = [],
	usageStatus = 200,
	discordStatus = 200,
}: Options) {
	return (call: Call) => {
		const base = `/client/v4/accounts/${ACCOUNT_ID}/billable-usage`;
		if (call.url.pathname === `${base}/info`)
			return Response.json(billingInfo());
		if (call.url.pathname === base) {
			if (usageStatus !== 200) {
				return Response.json(
					{
						success: false,
						errors: [{ code: 10000, message: "Authentication error" }],
						messages: [],
						result: null,
					},
					{ status: usageStatus },
				);
			}
			return Response.json(envelope(usage));
		}
		if (call.url.pathname === `/api/v10/channels/${CHANNEL_ID}/messages`)
			return new Response("{}", { status: discordStatus });
		return undefined;
	};
}

const posts = (calls: Call[]) =>
	calls.filter((c) => c.url.hostname === "discord.com");

describe("runDaily", () => {
	it("今期の分を取り、D1 に入れ、メンションなしで報告する", async () => {
		const { env, raw } = makeEnv();
		const calls = mockFetch(
			cloudflareAndDiscord({
				usage: [
					record("2026-10-15", 0.5),
					record("2026-11-06", 0.25),
					record("2026-11-06", 0.25, { family: "R2", service: "R2 Storage" }),
				],
			}),
		);
		await runDaily(env, NOW);

		const usageCall = calls.find((c) =>
			c.url.pathname.endsWith("/billable-usage"),
		);
		expect(usageCall?.url.searchParams.get("from")).toBe("2026-10-15");
		expect(usageCall?.url.searchParams.get("to")).toBe("2026-11-07");

		const [post] = posts(calls);
		expect(post?.body).toMatchObject({ allowed_mentions: { parse: [] } });
		expect(post?.body).not.toHaveProperty("content");

		expect(raw.prepare("SELECT COUNT(*) AS n FROM usage").get()).toEqual({
			n: 3,
		});
		const view = await dashboardView(env);
		if (view.kind !== "ready") throw new Error(view.kind);
		expect(view.fetchedAt).toBe(NOW.toISOString());
		expect(view.summary.periodToDate).toBe(1);
		expect(view.summary.yesterday).toBe(0.5);
	});

	it("期間の初日は前日の分から取る", async () => {
		const { env } = makeEnv();
		const calls = mockFetch(cloudflareAndDiscord({}));
		await runDaily(env, new Date("2026-11-15T01:00:00Z"));
		const usageCall = calls.find((c) =>
			c.url.pathname.endsWith("/billable-usage"),
		);
		expect(usageCall?.url.searchParams.get("from")).toBe("2026-11-14");
	});

	it("閾値を越えた最初の日だけメンションする", async () => {
		const { env, raw } = makeEnv();
		const calls = mockFetch(
			cloudflareAndDiscord({ usage: [record("2026-11-01", 8)] }),
		);
		await runDaily(env, NOW);
		await runDaily(env, new Date("2026-11-08T01:00:00Z"));

		const [first, second] = posts(calls);
		expect(first?.body).toMatchObject({
			content: expect.stringContaining(`<@${APPROVER_ID}>`),
			allowed_mentions: { parse: [], users: [APPROVER_ID] },
		});
		expect(first?.body).toMatchObject({
			content: expect.stringContaining("50%"),
		});
		expect(second?.body).not.toHaveProperty("content");
		expect(second?.body).toMatchObject({ allowed_mentions: { parse: [] } });
		expect(
			raw.prepare("SELECT kind FROM notified ORDER BY kind").all(),
		).toEqual([{ kind: "actual:50" }, { kind: "forecast:100" }]);
	});

	it("投稿に失敗した日は、閾値を知らせ済みにしない", async () => {
		const { env, raw } = makeEnv();
		vi.spyOn(console, "error").mockImplementation(() => {});
		mockFetch(
			cloudflareAndDiscord({
				usage: [record("2026-11-01", 6)],
				discordStatus: 500,
			}),
		);
		await runDaily(env, NOW);
		expect(raw.prepare("SELECT COUNT(*) AS n FROM notified").get()).toEqual({
			n: 0,
		});
	});

	it("Cloudflare API が失敗したら、メンションなしで失敗を知らせる", async () => {
		const { env } = makeEnv();
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const calls = mockFetch(cloudflareAndDiscord({ usageStatus: 403 }));
		await runDaily(env, NOW);

		const [post] = posts(calls);
		expect(post?.body).toMatchObject({
			content: expect.stringContaining("Cloudflare API 403"),
			allowed_mentions: { parse: [] },
		});
		expect(error).toHaveBeenCalled();
		expect((await dashboardView(env)).kind).toBe("empty");
	});

	it("設定が不正なら失敗を知らせ、API は呼ばない", async () => {
		const { env } = makeEnv({ BUDGET_MONTHLY_USD: "ten" });
		vi.spyOn(console, "error").mockImplementation(() => {});
		const calls = mockFetch(cloudflareAndDiscord({}));
		await runDaily(env, NOW);
		expect(calls.map((c) => c.url.hostname)).toEqual(["discord.com"]);
	});

	it("Discord も落ちていても例外を投げない", async () => {
		const { env } = makeEnv();
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("network down");
			}),
		);
		await expect(runDaily(env, NOW)).resolves.toBeUndefined();
	});
});
