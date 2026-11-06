import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type CodexMcpServer = {
	url: string;
	headers: Record<string, string>;
};

const tableName = (line: string): string | null => {
	const m = /^\s*\[\s*([^\]]+?)\s*\]\s*$/.exec(line);
	return m?.[1] ?? null;
};

/**
 * 席の Codex CLI の設定に、名前 `name` の MCP サーバーを置く。起動のたびに書き直すので、トークンを替えても次の起動で入る。
 * server が null なら表を消す（口を外したときに、届かないサーバーを Codex が探し続けないように）。書き換えたら true。
 * 席の環境変数には秘密を渡さない（seat-env.sh）ので、Access のヘッダーは値のまま書く。~/.codex は hook が読み出しを止める。
 */
export const syncCodexMcpServer = async (
	configPath: string,
	name: string,
	server: CodexMcpServer | null,
): Promise<boolean> => {
	const current = await readFile(configPath, "utf8").catch(() => "");
	const own = `mcp_servers.${name}`;
	const kept: string[] = [];
	let inOwn = false;
	for (const line of current === "" ? [] : current.split("\n")) {
		const table = tableName(line);
		if (table !== null) inOwn = table === own || table.startsWith(`${own}.`);
		if (!inOwn) kept.push(line);
	}
	while (kept.length > 0 && kept.at(-1)?.trim() === "") kept.pop();
	const base = kept.length > 0 ? `${kept.join("\n")}\n` : "";
	const block =
		server === null
			? ""
			: [
					`[${own}]`,
					`url = ${JSON.stringify(server.url)}`,
					`http_headers = { ${Object.entries(server.headers)
						.map(([k, v]) => `${JSON.stringify(k)} = ${JSON.stringify(v)}`)
						.join(", ")} }`,
					"startup_timeout_sec = 20",
					"tool_timeout_sec = 120",
					"",
				].join("\n");
	const next = base !== "" && block !== "" ? `${base}\n${block}` : base + block;
	if (next === current) return false;
	await mkdir(dirname(configPath), { recursive: true });
	await writeFile(configPath, next, { mode: 0o600 });
	return true;
};
