import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { syncCodexMcpServer } from "./codex-mcp.ts";
import { tempDir } from "./test-support.ts";

const server = {
	url: "https://playwright.example/mcp",
	headers: { "CF-Access-Client-Id": "id", "CF-Access-Client-Secret": 's"x' },
};

const block = [
	"[mcp_servers.playwright]",
	'url = "https://playwright.example/mcp"',
	'http_headers = { "CF-Access-Client-Id" = "id", "CF-Access-Client-Secret" = "s\\"x" }',
	"startup_timeout_sec = 20",
	"tool_timeout_sec = 120",
	"",
].join("\n");

describe("syncCodexMcpServer", () => {
	it("設定が無ければ作って MCP サーバーの表を置く", async () => {
		const path = join(tempDir(), ".codex", "config.toml");
		expect(await syncCodexMcpServer(path, "playwright", server)).toBe(true);
		expect(readFileSync(path, "utf8")).toBe(block);
	});

	it("ほかの表を残して古い表（下位の表も）を置き換え、同じなら書かない", async () => {
		const path = join(tempDir(), "config.toml");
		writeFileSync(
			path,
			[
				'model = "x"',
				"",
				"[mcp_servers.playwright]",
				'url = "https://old/mcp"',
				"",
				"[mcp_servers.playwright.tools.browser_click]",
				'approval_mode = "approve"',
				"",
				'[projects."/seats"]',
				'trust_level = "trusted"',
				"",
			].join("\n"),
		);
		expect(await syncCodexMcpServer(path, "playwright", server)).toBe(true);
		expect(readFileSync(path, "utf8")).toBe(
			`model = "x"\n\n[projects."/seats"]\ntrust_level = "trusted"\n\n${block}`,
		);
		expect(await syncCodexMcpServer(path, "playwright", server)).toBe(false);
	});

	it("null なら表を消し、ほかの MCP サーバーは残す", async () => {
		const path = join(tempDir(), "config.toml");
		writeFileSync(
			path,
			`[mcp_servers.other]\nurl = "https://other"\n\n${block}`,
		);
		expect(await syncCodexMcpServer(path, "playwright", null)).toBe(true);
		expect(readFileSync(path, "utf8")).toBe(
			'[mcp_servers.other]\nurl = "https://other"\n',
		);
		expect(await syncCodexMcpServer(path, "playwright", null)).toBe(false);
	});
});
