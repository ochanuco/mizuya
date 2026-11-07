import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";

const base = {
	HOME: "/home/w",
	DISCORD_TOKEN: "t",
	YUKARIN_DISCORD_TOKEN: "ty",
	WORK_TEXT_CHANNEL_ID: "100",
	WORK_FORUM_CHANNEL_ID: "200",
	WORKING_OWNER_DISCORD_USER_IDS: "300, 400,",
};

describe("loadConfig", () => {
	it("最小構成を受理し、既定値を HOME から補う", () => {
		expect(loadConfig(base)).toEqual({
			ok: true,
			value: {
				discordToken: "t",
				personaTokens: { yukarin: "ty", akarin: null },
				roleIds: { yukarin: null, akarin: null },
				inbox: null,
				codexHome: "/home/w/.codex",
				workTextChannelId: "100",
				workForumChannelId: "200",
				ownerUserIds: new Set(["300", "400"]),
				ownerDiscordUserId: "300",
				port: 8080,
				stateDir: "/home/w/state",
				workDir: "/home/w/work",
				personaScript: "/home/w/bin/persona.sh",
				personaDir: "/home/w/persona",
				handoffDir: "/home/w/handoff",
				claudeBin: "claude",
				orcaBin: "orca-ide",
				seatsRepo: "/home/w/work/seats",
				seatsDir: "/home/w/work/orca/workspaces/seats",
				seatLimit: 6,
				seatSleepAfterMs: 7_200_000,
				logLevel: "info",
				memory: null,
				memoryBin: "yunomi-memory",
				chimera: null,
				playwright: null,
				macState: null,
				standup: {
					enabled: true,
					at: { hour: 9, minute: 0 },
					githubOwner: "ochanuco",
					heartbeatIntervalMs: 2 * 3600_000,
				},
				activityLog: null,
			},
		});
	});

	it("活動ログはスレッドがあるときだけまとめ、時刻の既定は 23:30", () => {
		const r = loadConfig({ ...base, ACTIVITY_LOG_THREAD_ID: "900" });
		expect(r.ok && r.value.activityLog).toEqual({
			threadId: "900",
			at: { hour: 23, minute: 30 },
		});
		const early = loadConfig({
			...base,
			ACTIVITY_LOG_THREAD_ID: "900",
			ACTIVITY_LOG_TIME: "08:00",
		});
		expect(early.ok && early.value.activityLog?.at).toEqual({
			hour: 8,
			minute: 0,
		});
		expect(loadConfig({ ...base, ACTIVITY_LOG_TIME: "8:00" }).ok).toBe(false);
	});

	it("席の role と人格の bot の token を読む", () => {
		const r = loadConfig({
			...base,
			YUKARIN_ROLE_ID: "501",
			AKARIN_ROLE_ID: "502",
			AKARIN_DISCORD_TOKEN: "ta",
		});
		expect(r.ok && r.value.roleIds).toEqual({ yukarin: "501", akarin: "502" });
		expect(r.ok && r.value.personaTokens).toEqual({
			yukarin: "ty",
			akarin: "ta",
		});
	});

	it("Yukarin の bot の token が無ければ読めない", () => {
		const { YUKARIN_DISCORD_TOKEN: _, ...rest } = base;
		expect(loadConfig(rest).ok).toBe(false);
	});

	it("受け箱は 4 つそろったときだけ読む", () => {
		const inbox = {
			MIZUYA_INBOX_URL: "wss://mizuya.example.com/working/inbox",
			MIZUYA_INBOX_TOKEN: "t",
			MIZUYA_ACCESS_CLIENT_ID: "id",
			MIZUYA_ACCESS_CLIENT_SECRET: "secret",
		};
		const r = loadConfig({ ...base, ...inbox });
		expect(r.ok && r.value.inbox).toEqual({
			url: "wss://mizuya.example.com/working/inbox",
			token: "t",
			clientId: "id",
			clientSecret: "secret",
		});
		const partial = loadConfig({ ...base, ...inbox, MIZUYA_INBOX_TOKEN: "" });
		expect(partial.ok && partial.value.inbox).toBeNull();
	});

	it("数値の設定を読み、空文字は未設定として扱う", () => {
		const r = loadConfig({
			...base,
			PORT: "9000",
			SEAT_LIMIT: "3",
			SEAT_SLEEP_AFTER_MINUTES: "30",
			SEATS_DIR: "",
		});
		expect(r.ok && r.value.port).toBe(9000);
		expect(r.ok && r.value.seatLimit).toBe(3);
		expect(r.ok && r.value.seatSleepAfterMs).toBe(1_800_000);
		expect(r.ok && r.value.seatsDir).toBe("/home/w/work/orca/workspaces/seats");
		expect(loadConfig({ ...base, SEAT_LIMIT: "0" }).ok).toBe(false);
		expect(loadConfig({ ...base, PORT: "x" }).ok).toBe(false);
	});

	it("記憶の口・席の状態の口・朝会の設定を読む", () => {
		const r = loadConfig({
			...base,
			YUNOMI_URL: "https://worker.example",
			CF_ACCESS_CLIENT_ID: "id",
			CF_ACCESS_CLIENT_SECRET: "secret",
			MAC_STATE_TOKEN: "mac",
			STANDUP_ENABLED: "false",
			STANDUP_TIME: "08:30",
		});
		expect(r.ok && r.value.memory).toEqual({
			url: "https://worker.example",
			clientId: "id",
			clientSecret: "secret",
		});
		expect(r.ok && r.value.macState).toEqual({ token: "mac", port: 8090 });
		expect(r.ok && r.value.standup).toEqual({
			enabled: false,
			at: { hour: 8, minute: 30 },
			githubOwner: "ochanuco",
			heartbeatIntervalMs: 2 * 3600_000,
		});
		expect(loadConfig({ ...base, STANDUP_TIME: "25:00" }).ok).toBe(false);
		const hourly = loadConfig({ ...base, HEARTBEAT_INTERVAL_MINUTES: "60" });
		expect(hourly.ok && hourly.value.standup.heartbeatIntervalMs).toBe(
			3600_000,
		);
		const off = loadConfig({ ...base, HEARTBEAT_ENABLED: "false" });
		expect(off.ok && off.value.standup.heartbeatIntervalMs).toBeNull();
		// 短すぎる間隔は席が重なりトークン代もかさむので受けない
		expect(loadConfig({ ...base, HEARTBEAT_INTERVAL_MINUTES: "10" }).ok).toBe(
			false,
		);
		// service token が欠けていれば記憶の口は使わない
		const partial = loadConfig({
			...base,
			YUNOMI_URL: "https://worker.example",
		});
		expect(partial.ok && partial.value.memory).toBeNull();
	});

	it("chimera の口は URL と service token がそろったときだけ使う", () => {
		const r = loadConfig({
			...base,
			CHIMERA_URL: "https://chimera.example",
			CHIMERA_ACCESS_CLIENT_ID: "cid",
			CHIMERA_ACCESS_CLIENT_SECRET: "csecret",
		});
		expect(r.ok && r.value.chimera).toEqual({
			url: "https://chimera.example",
			clientId: "cid",
			clientSecret: "csecret",
		});
		const partial = loadConfig({
			...base,
			CHIMERA_URL: "https://chimera.example",
			CHIMERA_ACCESS_CLIENT_ID: "cid",
		});
		expect(partial.ok && partial.value.chimera).toBeNull();
	});

	it("Playwright MCP の口は URL と service token がそろったときだけ使う", () => {
		const r = loadConfig({
			...base,
			PLAYWRIGHT_MCP_URL: "https://playwright.example/mcp",
			PLAYWRIGHT_ACCESS_CLIENT_ID: "pid",
			PLAYWRIGHT_ACCESS_CLIENT_SECRET: "psecret",
		});
		expect(r.ok && r.value.playwright).toEqual({
			url: "https://playwright.example/mcp",
			clientId: "pid",
			clientSecret: "psecret",
		});
		const partial = loadConfig({
			...base,
			PLAYWRIGHT_MCP_URL: "https://playwright.example/mcp",
		});
		expect(partial.ok && partial.value.playwright).toBeNull();
	});

	it("トークンとチャンネル ID が欠けていれば理由を返す", () => {
		const r = loadConfig({ DISCORD_TOKEN: "t" });
		expect(r.ok).toBe(false);
		expect(!r.ok && r.error.join("\n")).toContain("WORK_FORUM_CHANNEL_ID");
		expect(!r.ok && r.error.join("\n")).toContain(
			"WORKING_OWNER_DISCORD_USER_IDS",
		);
	});
});
