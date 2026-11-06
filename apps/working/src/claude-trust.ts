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

const isRecord = (x: unknown): x is Record<string, unknown> =>
	typeof x === "object" && x !== null && !Array.isArray(x);

/**
 * 席の作業場所を Claude CLI の信頼済みの場所に登録する。
 * 信頼していない場所で起動した Claude は確認の画面で止まり、Orca は席を始められない。
 * Claude CLI は場所を realpath で引くので、realpath で登録する。
 */
export const trustWorkspace = async (
	configPath: string,
	dir: string,
	opts: { sleep?: (ms: number) => Promise<void>; now?: () => number } = {},
): Promise<Result<string, TrustError>> => {
	const sleep =
		opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const now = opts.now ?? Date.now;
	let real: string;
	try {
		real = await realpath(dir);
	} catch (e) {
		return err({ type: "TrustFailed", reason: `realpath: ${String(e)}` });
	}

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
		const projects = isRecord(config.projects) ? config.projects : {};
		const entry = projects[real];
		const current: Record<string, unknown> = isRecord(entry) ? entry : {};
		if (current.hasTrustDialogAccepted === true) return ok(real);
		const next = {
			...config,
			projects: {
				...projects,
				[real]: { ...current, hasTrustDialogAccepted: true },
			},
		};
		const tmp = `${configPath}.tmp.${process.pid}.${now()}`;
		await writeFile(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
		await rename(tmp, configPath);
		return ok(real);
	} catch (e) {
		return err({ type: "TrustFailed", reason: String(e).slice(0, 300) });
	} finally {
		await rmdir(lock).catch(() => {});
	}
};
