import { describe, expect, it } from "vitest";
import { newAlerts } from "../src/alerts.ts";
import { dailyMessage, failureMessage } from "../src/message.ts";
import { summarize, type UsageRow } from "../src/usage.ts";
import { APPROVER_ID } from "./fixtures.ts";

const period = { start: "2026-11-01", end: "2026-12-01" };

const row = (
	family: string,
	cost: number,
	chargeDate = "2026-11-05",
): UsageRow => ({
	periodStart: period.start,
	chargeDate,
	serviceName: `${family} Standard`,
	serviceFamily: family,
	cost,
	quantity: null,
	unit: null,
});

describe("dailyMessage", () => {
	it("普段の日は誰にもメンションしない", () => {
		const summary = summarize(
			[row("Workers", 1, "2026-11-10"), row("R2", 0.5)],
			period,
			"2026-11-11",
			10,
		);
		const body = dailyMessage(summary, [], APPROVER_ID);
		expect(body.content).toBeUndefined();
		expect(body.allowed_mentions).toEqual({ parse: [] });
		const embed = body.embeds[0];
		expect(embed?.url).toBe("https://budget.chanu.co/");
		expect(embed?.fields?.map((f) => f.name)).toEqual([
			"前日の額",
			"今期の累計",
			"月末の予測",
			"製品別",
		]);
		expect(embed?.fields?.[0]?.value).toBe("$1.00");
		expect(embed?.fields?.[1]?.value).toBe("$1.50 / $10.00（15%）");
		expect(embed?.fields?.[3]?.value).toBe("Workers: $1.00\nR2: $0.50");
	});

	it("閾値を越えた日は承認者だけにメンションし、どの閾値かを書く", () => {
		const summary = summarize([row("Workers", 5)], period, "2026-11-11", 10);
		const alerts = newAlerts(summary, [50, 90, 100], new Set());
		const body = dailyMessage(summary, alerts, APPROVER_ID);
		expect(body.content).toBe(
			`<@${APPROVER_ID}> 今期の累計が予算の 50% に達しました。月末の予測が予算を超えています。`,
		);
		expect(body.allowed_mentions).toEqual({ parse: [], users: [APPROVER_ID] });
	});

	it("製品群は上位 5 つと、残りの合計", () => {
		const summary = summarize(
			["A", "B", "C", "D", "E", "F", "G"].map((f, i) => row(f, 7 - i)),
			period,
			"2026-11-11",
			100,
		);
		const lines = dailyMessage(
			summary,
			[],
			APPROVER_ID,
		).embeds[0]?.fields?.[3]?.value.split("\n");
		expect(lines).toHaveLength(6);
		expect(lines?.at(-1)).toBe("ほか 2 件: $3.00");
	});
});

describe("failureMessage", () => {
	it("誰にもメンションしない", () => {
		const body = failureMessage("Cloudflare API 403: <@everyone>");
		expect(body.allowed_mentions).toEqual({ parse: [] });
		expect(body.content).toContain("Cloudflare API 403");
	});
});
