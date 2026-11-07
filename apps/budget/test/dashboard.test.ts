import { describe, expect, it } from "vitest";
import { escapeHtml, renderDashboard } from "../src/dashboard.ts";
import worker from "../src/index.ts";
import { summarize } from "../src/usage.ts";
import { makeEnv } from "./fixtures.ts";

const period = { start: "2026-11-01", end: "2026-12-01" };

const call = (env: ReturnType<typeof makeEnv>["env"], path: string) =>
	worker.fetch(new Request(`https://budget.example.com${path}`), env);

describe("escapeHtml", () => {
	it("HTML の特殊文字を置き換える", () => {
		expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
			"&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
		);
	});
});

describe("renderDashboard", () => {
	it("製品名などの文字列をエスケープする", () => {
		const summary = summarize(
			[
				{
					periodStart: period.start,
					chargeDate: "2026-11-02",
					serviceName: "<script>alert(1)</script>",
					serviceFamily: "Workers & Pages",
					cost: 1.5,
					quantity: 1234.5,
					unit: '"Requests"',
				},
			],
			period,
			"2026-11-03",
			10,
		);
		const html = renderDashboard({
			kind: "ready",
			summary,
			fetchedAt: "2026-11-03T01:00:00.000Z",
		});
		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(html).toContain("Workers &amp; Pages");
		expect(html).toContain("1,234.5 &quot;Requests&quot;");
		expect(html).toContain("2026-11-03 10:00 JST");
		expect(html).toContain("2026-11-01 〜 2026-11-30");
		expect(html).toContain("<svg");
	});

	it("エラーの文言もエスケープする", () => {
		expect(renderDashboard({ kind: "error", message: "<b>" })).toContain(
			"&lt;b&gt;",
		);
	});
});

describe("routing", () => {
	it("GET /health は ok", async () => {
		const res = await call(makeEnv().env, "/health");
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("ok");
	});

	it("まだ取得していなければ、その旨を出す", async () => {
		const res = await call(makeEnv().env, "/");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		expect(await res.text()).toContain("まだ取得していません");
	});

	it("知らない経路は 404", async () => {
		const res = await call(makeEnv().env, "/admin");
		expect(res.status).toBe(404);
	});
});
