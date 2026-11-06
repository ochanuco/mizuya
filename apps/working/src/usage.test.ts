import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentOf } from "./intake.ts";
import { err, ok } from "./lib/core.ts";
import { silentLogger } from "./logger.ts";
import {
	claudeCredentialsPathOf,
	createClaudeUsageReader,
	parseClaudeUsage,
	parseCodexRateLimits,
	startUsagePolling,
	type Usage,
	usageByPartner,
} from "./usage.ts";

afterEach(() => {
	vi.useRealTimers();
});

const usage = (five: number, week: number): Usage => ({
	fiveHour: { usedPercent: five, resetsAt: 1 },
	weekly: { usedPercent: week, resetsAt: 2 },
});

describe("parseClaudeUsage", () => {
	it("five_hour と seven_day の使用率とリセット時刻を読み、知らない項目は無視する", () => {
		expect(
			parseClaudeUsage({
				five_hour: {
					utilization: 46,
					resets_at: "2026-11-06T09:59:59.607887+00:00",
				},
				seven_day: {
					utilization: 21,
					resets_at: "2026-11-11T15:59:59.607913+00:00",
				},
				seven_day_opus: null,
				extra_usage: { is_enabled: false },
			}),
		).toEqual(
			ok({
				fiveHour: {
					usedPercent: 46,
					resetsAt: Date.parse("2026-11-06T09:59:59.607Z"),
				},
				weekly: {
					usedPercent: 21,
					resetsAt: Date.parse("2026-11-11T15:59:59.607Z"),
				},
			}),
		);
	});

	it("使い始めていない枠は 0% でリセット時刻なし、形が違えば err", () => {
		expect(parseClaudeUsage({ five_hour: null, seven_day: null })).toEqual(
			ok({
				fiveHour: { usedPercent: 0, resetsAt: null },
				weekly: { usedPercent: 0, resetsAt: null },
			}),
		);
		expect(parseClaudeUsage({ error: "x" }).ok).toBe(false);
	});
});

describe("parseCodexRateLimits", () => {
	it("primary を 5 時間枠、secondary を週枠として読み、秒をミリ秒に直す", () => {
		expect(
			parseCodexRateLimits({
				ordinaryUsageAllowed: true,
				rateLimits: {
					limitId: "codex",
					primary: {
						usedPercent: 1,
						windowDurationMins: 300,
						resetsAt: 1793961335,
					},
					secondary: {
						usedPercent: 0,
						windowDurationMins: 10080,
						resetsAt: 1794131955,
					},
				},
			}),
		).toEqual(
			ok({
				fiveHour: { usedPercent: 1, resetsAt: 1793961335000 },
				weekly: { usedPercent: 0, resetsAt: 1794131955000 },
			}),
		);
		expect(parseCodexRateLimits({}).ok).toBe(false);
	});
});

describe("createClaudeUsageReader", () => {
	const writeCredentials = async (expiresAt: number) => {
		const dir = await mkdtemp(join(tmpdir(), "usage-"));
		const path = join(dir, ".credentials.json");
		await writeFile(
			path,
			JSON.stringify({
				claudeAiOauth: { accessToken: "tok", refreshToken: "r", expiresAt },
			}),
		);
		return path;
	};

	it("ログイン情報のトークンで usage を読む", async () => {
		const fetch = vi.fn(
			async (_url: string | URL | Request, _init?: RequestInit) =>
				Response.json({
					five_hour: { utilization: 10, resets_at: null },
					seven_day: { utilization: 20, resets_at: null },
				}),
		);
		const read = createClaudeUsageReader({
			credentialsPath: await writeCredentials(2_000),
			fetch,
			now: () => 1_000,
		});
		const r = await read();
		expect(r.ok && r.value.weekly.usedPercent).toBe(20);
		expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({
			authorization: "Bearer tok",
			"anthropic-beta": "oauth-2025-04-20",
		});
	});

	it("期限の切れたトークンでは問い合わせず、ログイン情報がなければ err", async () => {
		const fetch = vi.fn();
		const expired = createClaudeUsageReader({
			credentialsPath: await writeCredentials(1_000),
			fetch,
			now: () => 1_000,
		});
		expect((await expired()).ok).toBe(false);
		expect(fetch).not.toHaveBeenCalled();
		const missing = createClaudeUsageReader({
			credentialsPath: "/nonexistent/.credentials.json",
			fetch,
		});
		expect((await missing()).ok).toBe(false);
	});

	it("CLAUDE_CONFIG_DIR があればその中のログイン情報を読む", () => {
		expect(claudeCredentialsPathOf({ CLAUDE_CONFIG_DIR: "/c" })).toBe(
			"/c/.credentials.json",
		);
		expect(claudeCredentialsPathOf({ HOME: "/h" })).toBe(
			"/h/.claude/.credentials.json",
		);
	});
});

describe("startUsagePolling", () => {
	it("読めなかったときは最後の値を残し、古くなったら出さない", async () => {
		vi.useFakeTimers();
		let t = 0;
		const answers = [
			ok(usage(10, 20)),
			err({ type: "UsageUnavailable" as const, reason: "x" }),
			err({ type: "UsageUnavailable" as const, reason: "x" }),
			err({ type: "UsageUnavailable" as const, reason: "x" }),
		];
		const polling = startUsagePolling({
			readers: { claude: async () => answers.shift() ?? ok(usage(0, 0)) },
			logger: silentLogger,
			intervalMs: 100,
			staleAfterMs: 250,
			now: () => t,
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(polling.current()).toEqual({ claude: usage(10, 20) });
		t = 200;
		await vi.advanceTimersByTimeAsync(200);
		expect(polling.current()).toEqual({ claude: usage(10, 20) });
		t = 300;
		await vi.advanceTimersByTimeAsync(100);
		expect(polling.current()).toEqual({});
		polling.stop();
	});
});

describe("usageByPartner", () => {
	it("Yukarin には Claude、Akarin には Codex の使用率を割り当てる", () => {
		expect(
			usageByPartner({ claude: usage(1, 2), codex: usage(3, 4) }, agentOf),
		).toEqual({ yukarin: usage(1, 2), akarin: usage(3, 4) });
		expect(usageByPartner({ claude: usage(1, 2) }, agentOf)).toEqual({
			yukarin: usage(1, 2),
		});
	});
});
