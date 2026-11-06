// コンテナでは node で直接動かすため、node の組み込み以外を import しない。
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";

/** 受付が起動時に書く、記憶の口の接続情報。Claude CLI の環境変数には載せず、この CLI の中でだけ読む。 */
export type MemoryCredentials = {
	url: string;
	client_id: string;
	client_secret: string;
	/** 記憶の持ち主。WORKING_OWNER_DISCORD_USER_IDS の先頭。 */
	discord_user_id: string;
	partner_id: string;
};

export const CREDENTIALS_FILE = "memory-credentials.json";
export const credentialsPathOf = (stateDir: string) =>
	join(stateDir, CREDENTIALS_FILE);

const PARTNER = /^[a-z]+$/;

/**
 * 席の中で呼ばれたら、その席の投稿の ID。見張りの新着をその投稿に書くのに使う。
 * 席の作業場所は YUNOMI_SEATS_DIR の下の seat-<投稿の ID>（src/guard/env.ts の seatOf と同じ形）。
 */
export const seatThreadOf = (
	seatsDir: string | undefined,
	cwd: string,
): string | null => {
	if (!seatsDir) return null;
	const rel = relative(seatsDir, cwd);
	if (rel === "" || rel.startsWith("..") || rel.startsWith("/")) return null;
	const m = /^seat-(\d{1,25})$/.exec(rel.split("/")[0] ?? "");
	return m?.[1] ?? null;
};

export const MEMORY_KINDS = ["decided", "done", "goal"] as const;
export const GOAL_CLOSINGS = ["achieved", "dropped"] as const;
/** Worker の WORK_NOTE_SUMMARY_MAX_LENGTH と揃える。 */
export const SUMMARY_MAX_LENGTH = 200;
/** Worker の WATCH_SEEN_KEY_MAX_LENGTH と揃える。 */
export const SEEN_KEY_MAX_LENGTH = 200;

/** Talking の道具 watch_add（packages/capabilities の definitions/watch.ts）と揃える。日時の形と過去の期限は Worker が同じ検証で弾く。 */
export const WATCH_QUERY_MAX_LENGTH = 200;
export const WATCH_SOURCE_MAX_LENGTH = 300;
export const WATCH_SOURCES_MAX = 5;
export const WATCH_INTERVAL_MIN_HOURS = 2;
export const WATCH_INTERVAL_MAX_HOURS = 24 * 7;
export const WATCH_INTERVAL_DEFAULT_HOURS = 24;

export type CliOutput = { code: number; stdout: string; stderr: string };

const USAGE = `使い方:
  yunomi-memory read
  yunomi-memory write --kind decided|done|goal --summary "<1行の要約>"
  yunomi-memory close --id <目標の id> --status achieved|dropped
  yunomi-memory watch-add --query "<何を>" [--source "<どこを>"]... [--interval-hours <時間>] [--until "<ISO 8601>"]
  yunomi-memory watch-stop --id <見張りの id>
  yunomi-memory watch-checked --id <見張りの id> [--seen "<知らせたものの key>"]...
`;

const fail = (code: number, message: string): CliOutput => ({
	code,
	stdout: "",
	stderr: `${message}\n`,
});

const readCredentials = (
	env: Record<string, string | undefined>,
): MemoryCredentials | null => {
	const stateDir =
		env.YUNOMI_STATE_DIR ?? `${env.HOME ?? "/home/worker"}/state`;
	try {
		const c = JSON.parse(
			readFileSync(credentialsPathOf(stateDir), "utf8"),
		) as Partial<MemoryCredentials>;
		const keys = [
			"url",
			"client_id",
			"client_secret",
			"discord_user_id",
			"partner_id",
		] as const;
		return keys.every((k) => typeof c[k] === "string" && c[k] !== "")
			? (c as MemoryCredentials)
			: null;
	} catch {
		return null;
	}
};

const threadField = (seatsDir: string | undefined, cwd: string) => {
	const thread = seatThreadOf(seatsDir, cwd);
	return thread === null ? {} : { notify_thread_id: thread };
};

/**
 * Working の記憶の口（Worker の /v1/partners/:id/working/memory）を読み書きする。
 * 接続情報は標準出力にも標準エラーにも出さない。Claude CLI の出力に載ると投稿に書かれるため。
 */
export const runMemoryCli = async (
	argv: readonly string[],
	env: Record<string, string | undefined>,
	doFetch: typeof fetch = fetch,
	cwd: string = process.cwd(),
): Promise<CliOutput> => {
	const [command, ...rest] = argv;
	if (
		command !== "read" &&
		command !== "write" &&
		command !== "close" &&
		command !== "watch-add" &&
		command !== "watch-stop" &&
		command !== "watch-checked"
	) {
		return fail(2, USAGE);
	}
	let values: {
		kind?: string;
		summary?: string;
		id?: string;
		status?: string;
		seen?: string[];
		query?: string;
		source?: string[];
		"interval-hours"?: string;
		until?: string;
	};
	try {
		values = parseArgs({
			args: [...rest],
			options: {
				kind: { type: "string" },
				summary: { type: "string" },
				id: { type: "string" },
				status: { type: "string" },
				seen: { type: "string", multiple: true },
				query: { type: "string" },
				source: { type: "string", multiple: true },
				"interval-hours": { type: "string" },
				until: { type: "string" },
			},
			strict: true,
			allowPositionals: false,
		}).values;
	} catch {
		return fail(2, USAGE);
	}
	const given = (Object.keys(values) as (keyof typeof values)[]).filter(
		(k) => values[k] !== undefined,
	);
	const allowed: Record<typeof command, readonly string[]> = {
		read: [],
		write: ["kind", "summary"],
		close: ["id", "status"],
		"watch-add": ["query", "source", "interval-hours", "until"],
		"watch-stop": ["id"],
		"watch-checked": ["id", "seen"],
	};
	if (given.some((k) => !allowed[command].includes(k))) return fail(2, USAGE);
	if (command === "write") {
		if (!MEMORY_KINDS.includes(values.kind as (typeof MEMORY_KINDS)[number])) {
			return fail(2, `--kind は decided か done か goal\n${USAGE}`);
		}
		const summary = (values.summary ?? "").trim();
		if (summary === "" || /[\r\n]/.test(summary)) {
			return fail(2, "--summary は改行を含まない 1 行で書く");
		}
		if (summary.length > SUMMARY_MAX_LENGTH) {
			return fail(2, `--summary は ${SUMMARY_MAX_LENGTH} 字以内`);
		}
		values.summary = summary;
	}
	if (command === "close") {
		if ((values.id ?? "").trim() === "") return fail(2, USAGE);
		if (
			!GOAL_CLOSINGS.includes(values.status as (typeof GOAL_CLOSINGS)[number])
		) {
			return fail(2, `--status は achieved か dropped\n${USAGE}`);
		}
		values.id = (values.id ?? "").trim();
	}
	let watch:
		| {
				query: string;
				sources: string[];
				interval_hours: number;
				until: string | null;
		  }
		| undefined;
	if (command === "watch-add") {
		const query = (values.query ?? "").trim();
		if (query === "" || /[\r\n]/.test(query)) {
			return fail(2, "--query は改行を含まない 1 行で書く");
		}
		if (query.length > WATCH_QUERY_MAX_LENGTH) {
			return fail(2, `--query は ${WATCH_QUERY_MAX_LENGTH} 字以内`);
		}
		const sources = (values.source ?? []).map((s) => s.trim());
		if (sources.some((s) => s === "" || /[\r\n]/.test(s))) {
			return fail(2, "--source は改行を含まない 1 行で書く");
		}
		if (sources.some((s) => s.length > WATCH_SOURCE_MAX_LENGTH)) {
			return fail(2, `--source は ${WATCH_SOURCE_MAX_LENGTH} 字以内`);
		}
		if (sources.length > WATCH_SOURCES_MAX) {
			return fail(2, `--source は ${WATCH_SOURCES_MAX} 件まで`);
		}
		const hoursText =
			values["interval-hours"]?.trim() ?? String(WATCH_INTERVAL_DEFAULT_HOURS);
		const hours = Number(hoursText);
		if (
			!/^\d+$/.test(hoursText) ||
			hours < WATCH_INTERVAL_MIN_HOURS ||
			hours > WATCH_INTERVAL_MAX_HOURS
		) {
			return fail(
				2,
				`--interval-hours は ${WATCH_INTERVAL_MIN_HOURS} 〜 ${WATCH_INTERVAL_MAX_HOURS} の整数`,
			);
		}
		const until = values.until?.trim();
		if (until !== undefined && (until === "" || /[\r\n]/.test(until))) {
			return fail(2, "--until はタイムゾーン付きの ISO 8601 の日時で書く");
		}
		watch = { query, sources, interval_hours: hours, until: until ?? null };
	}
	if (command === "watch-stop") {
		if ((values.id ?? "").trim() === "") return fail(2, USAGE);
		values.id = (values.id ?? "").trim();
	}
	if (command === "watch-checked") {
		if ((values.id ?? "").trim() === "") return fail(2, USAGE);
		const seen = (values.seen ?? []).map((k) => k.trim());
		if (seen.some((k) => k === "" || /[\r\n]/.test(k))) {
			return fail(2, "--seen は改行を含まない 1 行で書く");
		}
		if (seen.some((k) => k.length > SEEN_KEY_MAX_LENGTH)) {
			return fail(2, `--seen は ${SEEN_KEY_MAX_LENGTH} 字以内`);
		}
		values.id = (values.id ?? "").trim();
		values.seen = seen;
	}

	const creds = readCredentials(env);
	if (creds === null) return fail(1, "記憶の口の接続情報がない");
	// Akarin の席（Codex）は YUNOMI_PARTNER=akarin を付けて呼ぶ。無ければ接続情報の既定（Yukarin）
	const partner = PARTNER.test(env.YUNOMI_PARTNER ?? "")
		? (env.YUNOMI_PARTNER as string)
		: creds.partner_id;
	const base = `${creds.url.replace(/\/$/, "")}/v1/partners/${encodeURIComponent(partner)}/working/memory`;
	const headers = {
		"CF-Access-Client-Id": creds.client_id,
		"CF-Access-Client-Secret": creds.client_secret,
	};
	let res: Response;
	try {
		res =
			command === "read"
				? await doFetch(
						`${base}?discord_user_id=${encodeURIComponent(creds.discord_user_id)}`,
						{ headers, signal: AbortSignal.timeout(15_000) },
					)
				: await doFetch(base, {
						method:
							command === "write" || command === "watch-add" ? "POST" : "PATCH",
						headers: { ...headers, "content-type": "application/json" },
						body: JSON.stringify(
							command === "write"
								? {
										discord_user_id: creds.discord_user_id,
										kind: values.kind,
										summary: values.summary,
									}
								: command === "watch-add"
									? {
											discord_user_id: creds.discord_user_id,
											watch,
											...threadField(env.YUNOMI_SEATS_DIR, cwd),
										}
									: command === "watch-stop"
										? {
												discord_user_id: creds.discord_user_id,
												watch_id: values.id,
												status: "stopped",
											}
										: command === "close"
											? {
													discord_user_id: creds.discord_user_id,
													id: values.id,
													status: values.status,
												}
											: {
													discord_user_id: creds.discord_user_id,
													watch_id: values.id,
													seen: values.seen,
												},
						),
						signal: AbortSignal.timeout(15_000),
					});
	} catch {
		return fail(1, "記憶の口に届かない");
	}
	const text = await res.text().catch(() => "");
	if (!res.ok) {
		let code = "";
		try {
			const e = JSON.parse(text) as { error?: unknown; message?: unknown };
			if (typeof e.error === "string") code = `: ${e.error}`;
			if (typeof e.message === "string") code += ` (${e.message})`;
		} catch {}
		return fail(1, `記憶の口が ${res.status} を返した${code}`);
	}
	if (command === "read") return { code: 0, stdout: `${text}\n`, stderr: "" };
	if (command === "watch-add" && watch) {
		let id = "";
		try {
			const r = JSON.parse(text) as { id?: unknown };
			if (typeof r.id === "string") id = r.id;
		} catch {}
		const where =
			watch.sources.length === 0 ? "普通の検索" : watch.sources.join("、");
		const lines = [
			`見張りを足した (id: ${id})`,
			`何を: ${watch.query}`,
			`どこを: ${where}`,
			`間隔: ${watch.interval_hours} 時間おき`,
			`期限: ${watch.until ?? "なし"}`,
		];
		return { code: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
	}
	if (command === "watch-stop") {
		let query = "";
		try {
			const r = JSON.parse(text) as { query?: unknown };
			if (typeof r.query === "string") query = ` ${r.query}`;
		} catch {}
		return {
			code: 0,
			stdout: `見張りを止めた:${query} (id: ${values.id})\n`,
			stderr: "",
		};
	}
	if (command === "watch-checked") {
		return {
			code: 0,
			stdout: `調べ終えた: ${values.id}（知らせたもの ${values.seen?.length ?? 0} 件）\n`,
			stderr: "",
		};
	}
	if (command === "close") {
		return {
			code: 0,
			stdout: `閉じた: ${values.status} ${values.id}\n`,
			stderr: "",
		};
	}
	let id = "";
	try {
		const r = JSON.parse(text) as { id?: unknown };
		if (typeof r.id === "string") id = ` (id: ${r.id})`;
	} catch {}
	return {
		code: 0,
		stdout: `残した: ${values.kind} ${values.summary}${id}\n`,
		stderr: "",
	};
};
