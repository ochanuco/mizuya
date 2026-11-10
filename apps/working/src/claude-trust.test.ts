import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmdirSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	claudeConfigPathOf,
	syncClaudeMcpServer,
	trustWorkspace,
} from "./claude-trust.ts";
import { tempDir } from "./test-support.ts";

const setup = () => {
	const root = realpathSync(tempDir());
	const config = join(root, ".claude.json");
	const seat = join(root, "work", "seat-1");
	mkdirSync(seat, { recursive: true });
	const read = () => JSON.parse(readFileSync(config, "utf8"));
	return { root, config, seat, read };
};

describe("trustWorkspace", () => {
	it("設定が空でも、席の realpath を信頼済みにして 600 で書く", async () => {
		const t = setup();
		writeFileSync(t.config, "");
		const link = join(t.root, "link");
		symlinkSync(join(t.root, "work"), link);
		const r = await trustWorkspace(t.config, join(link, "seat-1"));
		expect(r).toEqual({ ok: true, value: t.seat });
		expect(t.read()).toEqual({
			projects: { [t.seat]: { hasTrustDialogAccepted: true } },
		});
		expect(statSync(t.config).mode & 0o777).toBe(0o600);
		expect(existsSync(`${t.config}.lock`)).toBe(false);
	});

	it("ログイン情報やほかの場所の設定は残す", async () => {
		const t = setup();
		writeFileSync(
			t.config,
			JSON.stringify({
				oauthAccount: { emailAddress: "x" },
				projects: {
					"/other": { hasTrustDialogAccepted: false, allowedTools: ["a"] },
					[t.seat]: { lastSessionId: "s" },
				},
			}),
		);
		await trustWorkspace(t.config, t.seat);
		expect(t.read()).toEqual({
			oauthAccount: { emailAddress: "x" },
			projects: {
				"/other": { hasTrustDialogAccepted: false, allowedTools: ["a"] },
				[t.seat]: { lastSessionId: "s", hasTrustDialogAccepted: true },
			},
		});
	});

	it("Claude CLI がロックを持っている間は待ち、空いてから書く", async () => {
		const t = setup();
		writeFileSync(t.config, "{}");
		mkdirSync(`${t.config}.lock`);
		let waited = 0;
		const r = await trustWorkspace(t.config, t.seat, {
			sleep: async () => {
				waited++;
				// 待っている間に Claude CLI が書いて、ロックを外す
				if (waited === 3) {
					writeFileSync(t.config, JSON.stringify({ numStartups: 7 }));
					rmdirSync(`${t.config}.lock`);
				}
			},
		});
		expect(r.ok).toBe(true);
		expect(waited).toBe(3);
		expect(t.read()).toEqual({
			numStartups: 7,
			projects: { [t.seat]: { hasTrustDialogAccepted: true } },
		});
	});

	it("落ちたプロセスが残した古いロックは外して進む", async () => {
		const t = setup();
		mkdirSync(`${t.config}.lock`);
		const old = new Date(Date.now() - 60_000);
		utimesSync(`${t.config}.lock`, old, old);
		const r = await trustWorkspace(t.config, t.seat, { sleep: async () => {} });
		expect(r.ok).toBe(true);
	});

	it("読めない設定は上書きしない", async () => {
		const t = setup();
		writeFileSync(t.config, "{ broken");
		const r = await trustWorkspace(t.config, t.seat);
		expect(r.ok).toBe(false);
		expect(readFileSync(t.config, "utf8")).toBe("{ broken");
		expect(existsSync(`${t.config}.lock`)).toBe(false);
	});

	it("同時に別の席を登録しても、どちらも残る", async () => {
		const t = setup();
		writeFileSync(t.config, "{}");
		const seats = [1, 2, 3, 4].map((i) => {
			const d = join(t.root, "work", `seat-c${i}`);
			mkdirSync(d);
			return d;
		});
		await Promise.all(seats.map((d) => trustWorkspace(t.config, d)));
		expect(Object.keys(t.read().projects).sort()).toEqual([...seats].sort());
	});

	it("設定の場所は CLAUDE_CONFIG_DIR を優先する", () => {
		expect(claudeConfigPathOf({ CLAUDE_CONFIG_DIR: "/c", HOME: "/h" })).toBe(
			"/c/.claude.json",
		);
		expect(claudeConfigPathOf({ HOME: "/h" })).toBe("/h/.claude.json");
	});
});

describe("syncClaudeMcpServer", () => {
	const server = {
		url: "https://chakai.example/mcp",
		headers: {
			"CF-Access-Client-Id": "id",
			"CF-Access-Client-Secret": "secret",
			"X-Actor": "yukarin",
		},
	};

	it("設定が無ければ作って、user スコープの MCP サーバーを 600 で置く", async () => {
		const t = setup();
		const r = await syncClaudeMcpServer(t.config, "chakai", server);
		expect(r).toEqual({ ok: true, value: true });
		expect(t.read()).toEqual({
			mcpServers: { chakai: { type: "http", ...server } },
		});
		expect(statSync(t.config).mode & 0o777).toBe(0o600);
		expect(existsSync(`${t.config}.lock`)).toBe(false);
	});

	it("ほかの設定と MCP サーバーを残して置き換え、同じなら書かない", async () => {
		const t = setup();
		writeFileSync(
			t.config,
			JSON.stringify({
				oauthAccount: { emailAddress: "x" },
				mcpServers: {
					other: { type: "http", url: "https://other.example/mcp" },
					chakai: { type: "http", url: "https://old.example/mcp" },
				},
			}),
		);
		expect(await syncClaudeMcpServer(t.config, "chakai", server)).toEqual({
			ok: true,
			value: true,
		});
		expect(t.read()).toEqual({
			oauthAccount: { emailAddress: "x" },
			mcpServers: {
				other: { type: "http", url: "https://other.example/mcp" },
				chakai: { type: "http", ...server },
			},
		});
		expect(await syncClaudeMcpServer(t.config, "chakai", server)).toEqual({
			ok: true,
			value: false,
		});
	});

	it("server が null なら消し、もともと無ければ書かない", async () => {
		const t = setup();
		writeFileSync(
			t.config,
			JSON.stringify({
				mcpServers: {
					other: { type: "http", url: "https://other.example/mcp" },
					chakai: { type: "http", ...server },
				},
			}),
		);
		expect(await syncClaudeMcpServer(t.config, "chakai", null)).toEqual({
			ok: true,
			value: true,
		});
		expect(t.read()).toEqual({
			mcpServers: {
				other: { type: "http", url: "https://other.example/mcp" },
			},
		});
		expect(await syncClaudeMcpServer(t.config, "chakai", null)).toEqual({
			ok: true,
			value: false,
		});
	});

	it("読めない設定は上書きしない", async () => {
		const t = setup();
		writeFileSync(t.config, "{ broken");
		const r = await syncClaudeMcpServer(t.config, "chakai", server);
		expect(r.ok).toBe(false);
		expect(readFileSync(t.config, "utf8")).toBe("{ broken");
	});
});
