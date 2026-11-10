import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as v from "valibot";
import {
	err,
	ok,
	PARTNER_IDS,
	type PartnerId,
	type Result,
} from "./lib/core.ts";
import type { Logger } from "./logger.ts";
import type { SeatAgent } from "./seat-engine.ts";

/** 使用率の枠ひとつ。resetsAt は UNIX ミリ秒で、枠をまだ使い始めていなければ null。 */
export type UsageWindow = { usedPercent: number; resetsAt: number | null };

/** CLI のサブスクリプションの、5 時間枠と週枠の使用率。 */
export type Usage = { fiveHour: UsageWindow; weekly: UsageWindow };

export type UsageError = { type: "UsageUnavailable"; reason: string };

export type UsageReader = () => Promise<Result<Usage, UsageError>>;

const unavailable = (reason: string): UsageError => ({
	type: "UsageUnavailable",
	reason,
});

const UNUSED: UsageWindow = { usedPercent: 0, resetsAt: null };

// --- Claude ---

/** Claude CLI のログイン情報。CLAUDE_CONFIG_DIR があればその中に置かれる。 */
export const claudeCredentialsPathOf = (
	env: Record<string, string | undefined>,
) =>
	env.CLAUDE_CONFIG_DIR
		? join(env.CLAUDE_CONFIG_DIR, ".credentials.json")
		: join(env.HOME ?? "/home/worker", ".claude", ".credentials.json");

const credentialsSchema = v.object({
	claudeAiOauth: v.object({
		accessToken: v.pipe(v.string(), v.nonEmpty()),
		expiresAt: v.optional(v.number()),
	}),
});

// 枠の項目そのものが無い応答は、0% と見分けられるよう読めないことにする
const claudeWindowSchema = v.nullable(
	v.object({
		utilization: v.nullish(v.number()),
		resets_at: v.nullish(v.string()),
	}),
);

const claudeUsageSchema = v.object({
	five_hour: claudeWindowSchema,
	seven_day: claudeWindowSchema,
});

const claudeWindow = (
	w: v.InferOutput<typeof claudeWindowSchema>,
): UsageWindow => {
	if (!w) return UNUSED;
	const t = w.resets_at ? Date.parse(w.resets_at) : Number.NaN;
	return {
		usedPercent: w.utilization ?? 0,
		resetsAt: Number.isNaN(t) ? null : t,
	};
};

export const parseClaudeUsage = (json: unknown): Result<Usage, UsageError> => {
	const parsed = v.safeParse(claudeUsageSchema, json);
	if (!parsed.success) return err(unavailable("unexpected claude usage shape"));
	return ok({
		fiveHour: claudeWindow(parsed.output.five_hour),
		weekly: claudeWindow(parsed.output.seven_day),
	});
};

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

/**
 * Claude Code の /usage と同じ値を読む。公開されていない API なので、形が変われば読めないだけにする。
 * アクセストークンの期限が切れていても自分では更新しない。更新すると refresh token が入れ替わり、席の Claude のログインを壊しうる。
 * 席の Claude が動けば CLI が更新するので、それまで出さない。
 */
export const createClaudeUsageReader = (opts: {
	credentialsPath: string;
	fetch?: typeof fetch;
	now?: () => number;
	timeoutMs?: number;
}): UsageReader => {
	const doFetch = opts.fetch ?? fetch;
	const now = opts.now ?? Date.now;
	return async () => {
		let raw: string;
		try {
			raw = await readFile(opts.credentialsPath, "utf8");
		} catch {
			return err(unavailable("claude credentials not found"));
		}
		let json: unknown;
		try {
			json = JSON.parse(raw);
		} catch {
			return err(unavailable("claude credentials unreadable"));
		}
		const cred = v.safeParse(credentialsSchema, json);
		if (!cred.success) return err(unavailable("claude credentials unreadable"));
		const { accessToken, expiresAt } = cred.output.claudeAiOauth;
		if (expiresAt !== undefined && expiresAt <= now()) {
			return err(unavailable("claude token expired"));
		}
		try {
			const res = await doFetch(CLAUDE_USAGE_URL, {
				headers: {
					authorization: `Bearer ${accessToken}`,
					"anthropic-beta": "oauth-2025-04-20",
				},
				signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
			});
			if (!res.ok) return err(unavailable(`claude usage ${res.status}`));
			return parseClaudeUsage(await res.json().catch(() => null));
		} catch (e) {
			return err(unavailable(String(e)));
		}
	};
};

// --- Codex ---

const codexWindowSchema = v.nullable(
	v.object({
		usedPercent: v.number(),
		resetsAt: v.nullish(v.number()),
	}),
);

const codexRateLimitsSchema = v.object({
	rateLimits: v.object({
		primary: codexWindowSchema,
		secondary: codexWindowSchema,
	}),
});

const codexWindow = (
	w: v.InferOutput<typeof codexWindowSchema>,
): UsageWindow =>
	w
		? {
				usedPercent: w.usedPercent,
				// Codex は UNIX 秒で返す
				resetsAt: w.resetsAt == null ? null : w.resetsAt * 1000,
			}
		: UNUSED;

/** app-server の account/rateLimits/read の結果を読む。primary が 5 時間枠、secondary が週枠。 */
export const parseCodexRateLimits = (
	json: unknown,
): Result<Usage, UsageError> => {
	const parsed = v.safeParse(codexRateLimitsSchema, json);
	if (!parsed.success) return err(unavailable("unexpected codex usage shape"));
	return ok({
		fiveHour: codexWindow(parsed.output.rateLimits.primary),
		weekly: codexWindow(parsed.output.rateLimits.secondary),
	});
};

/** `codex app-server` を起こし、JSON-RPC を 1 つだけ投げて結果を返す。 */
export const codexAppServerCall = (opts: {
	bin: string;
	env: Record<string, string>;
	method: string;
	timeoutMs: number;
}): Promise<Result<unknown, UsageError>> =>
	new Promise((resolve) => {
		const child = spawn(opts.bin, ["app-server"], {
			env: opts.env,
			stdio: ["pipe", "pipe", "ignore"],
		});
		let settled = false;
		const finish = (r: Result<unknown, UsageError>) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.kill();
			resolve(r);
		};
		const timer = setTimeout(
			() => finish(err(unavailable("codex app-server timed out"))),
			opts.timeoutMs,
		);
		const send = (msg: Record<string, unknown>) =>
			child.stdin.write(`${JSON.stringify(msg)}\n`);
		child.on("error", (e) => finish(err(unavailable(String(e)))));
		child.on("close", () =>
			finish(err(unavailable("codex app-server exited"))),
		);
		// 先に終わった子に書くと EPIPE になる。拾わないと受付ごと落ちる
		child.stdin.on("error", () => {});
		let buf = "";
		child.stdout.on("data", (d: Buffer) => {
			buf += d.toString("utf8");
			for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
				const line = buf.slice(0, i);
				buf = buf.slice(i + 1);
				let msg: { id?: unknown; result?: unknown; error?: unknown };
				try {
					msg = JSON.parse(line);
				} catch {
					continue;
				}
				if (msg.id === 1) {
					send({ method: "initialized" });
					send({ id: 2, method: opts.method });
				} else if (msg.id === 2) {
					finish(
						msg.error === undefined
							? ok(msg.result)
							: err(unavailable(`codex ${opts.method} failed`)),
					);
				}
			}
		});
		send({
			id: 1,
			method: "initialize",
			params: { clientInfo: { name: "mizuya-working", version: "0" } },
		});
	});

export const createCodexUsageReader = (opts: {
	bin: string;
	env: Record<string, string>;
	timeoutMs?: number;
}): UsageReader => {
	return async () => {
		const r = await codexAppServerCall({
			bin: opts.bin,
			env: opts.env,
			method: "account/rateLimits/read",
			timeoutMs: opts.timeoutMs ?? 30_000,
		});
		return r.ok ? parseCodexRateLimits(r.value) : r;
	};
};

// --- 定期読み取り ---

export const USAGE_INTERVAL_MS = 5 * 60_000;

export type UsagePolling = {
	/** いま出してよい使用率。古くなったものは含めない。 */
	current: () => Partial<Record<SeatAgent, Usage>>;
	stop: () => void;
};

/**
 * CLI ごとの使用率を定期的に読んでおく。
 * 一度読めなかっただけで消すと表示がちらつくので、最後に読めた値を staleAfterMs まで残す。
 */
export const startUsagePolling = (opts: {
	readers: Partial<Record<SeatAgent, UsageReader>>;
	logger: Logger;
	intervalMs?: number;
	staleAfterMs?: number;
	now?: () => number;
}): UsagePolling => {
	const intervalMs = opts.intervalMs ?? USAGE_INTERVAL_MS;
	const staleAfterMs = opts.staleAfterMs ?? intervalMs * 3;
	const now = opts.now ?? Date.now;
	const latest = new Map<SeatAgent, { usage: Usage; readAt: number }>();
	const entries = Object.entries(opts.readers) as [SeatAgent, UsageReader][];
	const update = async () => {
		await Promise.all(
			entries.map(async ([agent, read]) => {
				const r = await read();
				if (r.ok) latest.set(agent, { usage: r.value, readAt: now() });
				else opts.logger.debug("usage unavailable", { agent, ...r.error });
			}),
		);
	};
	void update();
	const timer = setInterval(() => void update(), intervalMs);
	timer.unref();
	return {
		current: () => {
			const out: Partial<Record<SeatAgent, Usage>> = {};
			for (const [agent, { usage, readAt }] of latest) {
				if (now() - readAt <= staleAfterMs) out[agent] = usage;
			}
			return out;
		},
		stop: () => clearInterval(timer),
	};
};

/** パートナーごとに、そのパートナーの席で動く CLI の使用率を引く。 */
export const usageByPartner = (
	byAgent: Partial<Record<SeatAgent, Usage>>,
	agentOf: (partner: PartnerId) => SeatAgent,
): Partial<Record<PartnerId, Usage>> => {
	const out: Partial<Record<PartnerId, Usage>> = {};
	for (const partner of PARTNER_IDS) {
		const usage = byAgent[agentOf(partner)];
		if (usage) out[partner] = usage;
	}
	return out;
};
