import {
	mkdir,
	readFile,
	realpath,
	rename,
	rmdir,
	stat,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { err, ok, type Result } from "./lib/core.ts";

export type TrustError = { type: "TrustFailed"; reason: string };

/** Claude CLI の設定ファイル。CLAUDE_CONFIG_DIR があればその中の .claude.json を使う。 */
export const claudeConfigPathOf = (env: Record<string, string | undefined>) =>
	env.CLAUDE_CONFIG_DIR
		? join(env.CLAUDE_CONFIG_DIR, ".claude.json")
		: join(env.HOME ?? "/home/worker", ".claude.json");

// Claude CLI は設定を書くとき `<設定>.lock` をディレクトリとして作り、その間に読み直してから書く。
// 同じロックを取れば、動いている席の Claude の書き込みと混ざらない。
const LOCK_WAIT_MS = 15_000;
// ロックを持ったまま落ちたプロセスの残り。Claude CLI のロックの既定の期限に合わせる。
// Orca も起動の前に信頼を書くが、残ったロックを古いとみなさないので、残りがあると書けずに確認の画面で止まる
const LOCK_STALE_MS = 10_000;

type LockOpts = { sleep?: (ms: number) => Promise<void>; now?: () => number };

const isRecord = (x: unknown): x is Record<string, unknown> =>
	typeof x === "object" && x !== null && !Array.isArray(x);

/**
 * Claude CLI の設定を、Claude CLI と同じロックの中で読んで書き換える。
 * update が null を返せば書かない。書き換えたら true。
 */
export const updateClaudeConfig = async (
	configPath: string,
	update: (config: Record<string, unknown>) => Record<string, unknown> | null,
	opts: LockOpts = {},
): Promise<Result<boolean, TrustError>> => {
	const sleep =
		opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const now = opts.now ?? Date.now;
	const lock = `${configPath}.lock`;
	const deadline = now() + LOCK_WAIT_MS;
	for (;;) {
		try {
			await mkdir(lock);
			break;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
				return err({ type: "TrustFailed", reason: `lock: ${String(e)}` });
			}
			const held = await stat(lock).catch(() => null);
			if (held && now() - held.mtimeMs > LOCK_STALE_MS) {
				await rmdir(lock).catch(() => {});
				continue;
			}
			if (now() >= deadline) {
				return err({
					type: "TrustFailed",
					reason: "lock: Claude CLI の設定のロックが空かない",
				});
			}
			await sleep(100);
		}
	}

	try {
		const raw = await readFile(configPath, "utf8").catch(
			(e: NodeJS.ErrnoException) => {
				if (e.code === "ENOENT") return null;
				throw e;
			},
		);
		let config: Record<string, unknown> = {};
		if (raw !== null && raw.trim() !== "") {
			const parsed: unknown = JSON.parse(raw);
			// 読めない設定を上書きすると、ログイン情報ごと消してしまう
			if (!isRecord(parsed)) {
				return err({
					type: "TrustFailed",
					reason: "Claude CLI の設定が JSON のオブジェクトでない",
				});
			}
			config = parsed;
		}
		const next = update(config);
		if (next === null) return ok(false);
		const tmp = `${configPath}.tmp.${process.pid}.${now()}`;
		await writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
		await rename(tmp, configPath);
		return ok(true);
	} catch (e) {
		return err({ type: "TrustFailed", reason: String(e).slice(0, 300) });
	} finally {
		await rmdir(lock).catch(() => {});
	}
};

/**
 * 席の作業場所を Claude CLI の信頼済みの場所に登録する。
 * 信頼していない場所で起動した Claude は確認の画面で止まり、Orca は席を始められない。
 * Claude CLI は場所を realpath で引くので、realpath で登録する。
 */
export const trustWorkspace = async (
	configPath: string,
	dir: string,
	opts: LockOpts = {},
): Promise<Result<string, TrustError>> => {
	let real: string;
	try {
		real = await realpath(dir);
	} catch (e) {
		return err({ type: "TrustFailed", reason: `realpath: ${String(e)}` });
	}
	const written = await updateClaudeConfig(
		configPath,
		(config) => {
			const projects = isRecord(config.projects) ? config.projects : {};
			const entry = projects[real];
			const current: Record<string, unknown> = isRecord(entry) ? entry : {};
			if (current.hasTrustDialogAccepted === true) return null;
			return {
				...config,
				projects: {
					...projects,
					[real]: { ...current, hasTrustDialogAccepted: true },
				},
			};
		},
		opts,
	);
	return written.ok ? ok(real) : written;
};

export type ClaudeMcpServer = {
	url: string;
	headers: Record<string, string>;
};

/**
 * 席の Claude CLI の設定（user スコープ）に、名前 `name` の MCP サーバーを置く。起動のたびに書き直すので、トークンを替えても次の起動で入る。
 * server が null なら消す。書き換えたら true。
 * 席の環境変数には秘密を渡さない（seat-env.sh）ので、Access のヘッダーは値のまま書く。設定は hook が読み出しを止める。
 */
export const syncClaudeMcpServer = (
	configPath: string,
	name: string,
	server: ClaudeMcpServer | null,
	opts: LockOpts = {},
): Promise<Result<boolean, TrustError>> =>
	updateClaudeConfig(
		configPath,
		(config) => {
			const servers = isRecord(config.mcpServers) ? config.mcpServers : {};
			const { [name]: current, ...rest } = servers;
			const want = server && {
				type: "http",
				url: server.url,
				headers: server.headers,
			};
			if (JSON.stringify(current ?? null) === JSON.stringify(want)) return null;
			return { ...config, mcpServers: want ? { ...rest, [name]: want } : rest };
		},
		opts,
	);
