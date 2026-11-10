import * as v from "valibot";
import { err, ok, type Result } from "./lib/core.ts";
import type { LogLevel } from "./logger.ts";

const nonEmpty = v.pipe(v.string(), v.nonEmpty());
const positiveInt = v.pipe(
	v.string(),
	v.regex(/^\d+$/),
	v.transform(Number),
	v.minValue(1),
);

const timeOfDay = v.pipe(v.string(), v.regex(/^([01]\d|2[0-3]):[0-5]\d$/));

const envSchema = v.object({
	DISCORD_TOKEN: nonEmpty,
	YUKARIN_DISCORD_TOKEN: nonEmpty,
	AKARIN_DISCORD_TOKEN: v.optional(nonEmpty),
	YUKARIN_ROLE_ID: v.optional(nonEmpty),
	AKARIN_ROLE_ID: v.optional(nonEmpty),
	MIZUYA_INBOX_URL: v.optional(v.pipe(v.string(), v.url())),
	MIZUYA_INBOX_TOKEN: v.optional(nonEmpty),
	MIZUYA_ACCESS_CLIENT_ID: v.optional(nonEmpty),
	MIZUYA_ACCESS_CLIENT_SECRET: v.optional(nonEmpty),
	CODEX_HOME: v.optional(nonEmpty),
	WORK_TEXT_CHANNEL_ID: nonEmpty,
	WORK_FORUM_CHANNEL_ID: nonEmpty,
	WORKING_OWNER_DISCORD_USER_IDS: nonEmpty,
	PORT: v.optional(positiveInt),
	STATE_DIR: v.optional(nonEmpty),
	WORK_DIR: v.optional(nonEmpty),
	PERSONA_SCRIPT: v.optional(nonEmpty),
	PERSONA_DIR: v.optional(nonEmpty),
	HANDOFF_DIR: v.optional(nonEmpty),
	CLAUDE_BIN: v.optional(nonEmpty),
	SEATS_REPO: v.optional(nonEmpty),
	SEATS_DIR: v.optional(nonEmpty),
	SEAT_LIMIT: v.optional(positiveInt),
	SEAT_SLEEP_AFTER_MINUTES: v.optional(positiveInt),
	SEAT_DONE_LINGER_MINUTES: v.optional(positiveInt),
	TITLE_SETTLE_MINUTES: v.optional(positiveInt),
	LOG_LEVEL: v.optional(v.picklist(["debug", "info", "warn", "error"])),
	YUNOMI_URL: v.optional(v.pipe(v.string(), v.url())),
	CF_ACCESS_CLIENT_ID: v.optional(nonEmpty),
	CF_ACCESS_CLIENT_SECRET: v.optional(nonEmpty),
	MEMORY_BIN: v.optional(nonEmpty),
	CHIMERA_URL: v.optional(v.pipe(v.string(), v.url())),
	CHIMERA_ACCESS_CLIENT_ID: v.optional(nonEmpty),
	CHIMERA_ACCESS_CLIENT_SECRET: v.optional(nonEmpty),
	PLAYWRIGHT_MCP_URL: v.optional(v.pipe(v.string(), v.url())),
	PLAYWRIGHT_ACCESS_CLIENT_ID: v.optional(nonEmpty),
	PLAYWRIGHT_ACCESS_CLIENT_SECRET: v.optional(nonEmpty),
	CHAKAI_MCP_URL: v.optional(v.pipe(v.string(), v.url())),
	CHAKAI_ACCESS_CLIENT_ID: v.optional(nonEmpty),
	CHAKAI_ACCESS_CLIENT_SECRET: v.optional(nonEmpty),
	MAC_STATE_TOKEN: v.optional(nonEmpty),
	MAC_STATE_PORT: v.optional(positiveInt),
	SEAT_STATUS_TOKEN: v.optional(nonEmpty),
	SEAT_STATUS_PORT: v.optional(positiveInt),
	STANDUP_ENABLED: v.optional(v.picklist(["true", "false"])),
	STANDUP_TIME: v.optional(timeOfDay),
	STANDUP_GITHUB_OWNER: v.optional(nonEmpty),
	HEARTBEAT_ENABLED: v.optional(v.picklist(["true", "false"])),
	HEARTBEAT_INTERVAL_MINUTES: v.optional(v.pipe(positiveInt, v.minValue(30))),
	ACTIVITY_LOG_THREAD_ID: v.optional(nonEmpty),
	ACTIVITY_LOG_TIME: v.optional(timeOfDay),
	SCHEDULER_URL: v.optional(v.pipe(v.string(), v.url())),
	SCHEDULER_ACCESS_CLIENT_ID: v.optional(nonEmpty),
	SCHEDULER_ACCESS_CLIENT_SECRET: v.optional(nonEmpty),
	SCHEDULER_TOKEN: v.optional(nonEmpty),
	SCHEDULER_SELF_URL: v.optional(v.pipe(v.string(), v.url())),
	SCHEDULER_PORT: v.optional(positiveInt),
	SCHEDULER_SYNC_INTERVAL_MINUTES: v.optional(positiveInt),
	PATROL_SCHEDULE: v.optional(nonEmpty),
	HISHAKU_URL: v.optional(v.pipe(v.string(), v.url())),
	HISHAKU_ACCESS_CLIENT_ID: v.optional(nonEmpty),
	HISHAKU_ACCESS_CLIENT_SECRET: v.optional(nonEmpty),
	HISHAKU_HOLDER: v.optional(nonEmpty),
	HS_BIN: v.optional(nonEmpty),
});

const SCHEDULER_KEYS = [
	"SCHEDULER_URL",
	"SCHEDULER_ACCESS_CLIENT_ID",
	"SCHEDULER_ACCESS_CLIENT_SECRET",
	"SCHEDULER_TOKEN",
	"SCHEDULER_SELF_URL",
] as const;

export type WorkingConfig = {
	/** mizuya の bot トークン。Gateway で仕事チャンネルを読み、ボタンと状態の欄を書く。 */
	discordToken: string;
	/** 席の発言・投稿・リアクション・入力中の表示に使う人格の bot の token。REST だけで使い、Gateway にはつながない。 */
	personaTokens: { yukarin: string; akarin: string | null };
	/** 依頼の宛先の席を決める role。無ければその role では選べない。 */
	roleIds: { yukarin: string | null; akarin: string | null };
	/** mizuya の Worker の受け箱。4 つそろったときだけつなぎ、ボタンを受け取る。 */
	inbox: {
		url: string;
		token: string;
		clientId: string;
		clientSecret: string;
	} | null;
	/** Codex CLI の設定とログイン情報の置き場所。席の元のリポジトリの信頼をここの config.toml に書く。 */
	codexHome: string;
	workTextChannelId: string;
	workForumChannelId: string;
	/** この人たちの発言だけで作業する。ほかの人と bot は無視する。 */
	ownerUserIds: ReadonlySet<string>;
	/** 記憶の持ち主。WORKING_OWNER_DISCORD_USER_IDS の先頭。 */
	ownerDiscordUserId: string;
	port: number;
	/** 投稿とセッションの対応を置くディレクトリ。volume に載せる。 */
	stateDir: string;
	/** 受付が自分で動かす CLI の作業ディレクトリ。 */
	workDir: string;
	personaScript: string;
	/** 人格の元ファイルの置き場。`<パートナー>/profile.yaml` などが入る。persona.sh と同じ `PERSONA_DIR` を読む。 */
	personaDir: string;
	/** Mac への引き継ぎの指示（prompt.md と issue-template.md）を置いたディレクトリ。 */
	handoffDir: string;
	claudeBin: string;
	/** 席の worktree の元にする空の git リポジトリ。 */
	seatsRepo: string;
	/** 席の worktree を作る場所。席の agent と hook には MIZUYA_SEATS_DIR で渡す。 */
	seatsDir: string;
	/** 同時に Claude を動かしておく席の上限。 */
	seatLimit: number;
	/** 決めてほしいままこれだけたった席は Claude を止める。 */
	seatSleepAfterMs: number;
	/** 完了か見張り中で手を止めた投稿の席を、これだけ閉じずに残す。続きをすぐ書かれたら同じ Claude に渡す。 */
	seatDoneLingerMs: number;
	/** 決めてほしい・引き継ぎ・完了になってから、これだけ投稿が放っておかれたら件名に状態の絵文字を付ける。 */
	titleSettleMs: number;
	logLevel: LogLevel;
	/** Working の記憶の口。3 つそろったときだけ yunomi-memory が使える。 */
	memory: { url: string; clientId: string; clientSecret: string } | null;
	memoryBin: string;
	/** chimera の画像を取る口。3 つそろったときだけ `chimera:` の行の画像を付ける。 */
	chimera: { url: string; clientId: string; clientSecret: string } | null;
	/** Akarin の席の Codex に渡す Playwright MCP。3 つそろったときだけ席から使える。 */
	playwright: { url: string; clientId: string; clientSecret: string } | null;
	/** 席の agent に渡す chakai（タスク台帳）の MCP。3 つそろったときだけ席から使える。 */
	chakai: { url: string; clientId: string; clientSecret: string } | null;
	/**
	 * 席の agent のセッションを預ける hishaku の Manager。3 つそろったときだけ使う。
	 * holder はこの受付の Commander の ID で、Mac の hs が貸し出しの持ち主として見る。
	 */
	hishaku: {
		url: string;
		clientId: string;
		clientSecret: string;
		holder: string;
		bin: string;
	} | null;
	/** Mac から席の状態を受ける口。トークンがなければ待ち受けない。 */
	macState: { token: string; port: number } | null;
	/** yunomi の gateway に席の状態を渡す口。トークンがなければ待ち受けない。 */
	seatStatus: { token: string; port: number } | null;
	/**
	 * Dkron から朝会・見回り・見張りを起こすときの設定。5 つそろったときだけ Dkron に任せ、内蔵のタイマーは回さない。
	 * 受付だけが使い、席には渡さない。
	 */
	scheduler: {
		/** Dkron の API。Cloudflare Access の内側にある。 */
		url: string;
		clientId: string;
		clientSecret: string;
		/** Dkron が起こす口のトークン。 */
		token: string;
		/** Dkron から届く、LAN に公開したこの受付の口（`/run` まで）。 */
		selfUrl: string;
		port: number;
		syncIntervalMs: number;
		/** 見回りのジョブの schedule（Dkron の 6 フィールドの cron、Asia/Tokyo）。 */
		patrolSchedule: string;
	} | null;
	standup: {
		/** 朝会・見回り・見張り・GitHub の出来事を回すか。 */
		enabled: boolean;
		/** 内蔵のタイマーで朝会と見回りを回すか。Dkron に任せるときは回さない。 */
		timer: boolean;
		at: { hour: number; minute: number };
		githubOwner: string;
		/** 朝会の合間の見回りの間隔。null なら見回らず、朝会だけを回す。 */
		heartbeatIntervalMs: number | null;
	};
	/** 席がしたことを 1 日 1 回まとめて投稿するスレッドと時刻。スレッドが無ければまとめない。 */
	activityLog: {
		threadId: string;
		at: { hour: number; minute: number };
	} | null;
};

export const loadConfig = (
	env: Record<string, string | undefined>,
): Result<WorkingConfig, string[]> => {
	// 空文字は未設定として扱う（.env で `KEY=` と書かれがち）
	const cleaned = Object.fromEntries(
		Object.entries(env).filter(([, val]) => val !== undefined && val !== ""),
	);
	const parsed = v.safeParse(envSchema, cleaned);
	if (!parsed.success) {
		return err(
			parsed.issues.map((i) => {
				const path = v.getDotPath(i);
				return path ? `${path}: ${i.message}` : i.message;
			}),
		);
	}
	const e = parsed.output;
	const home = env.HOME ?? "/home/worker";
	const owners = e.WORKING_OWNER_DISCORD_USER_IDS.split(",")
		.map((id) => id.trim())
		.filter((id) => id !== "");
	const [owner] = owners;
	if (owner === undefined) {
		return err(["WORKING_OWNER_DISCORD_USER_IDS: ID が 1 つもない"]);
	}
	const schedulerSet = SCHEDULER_KEYS.filter((k) => e[k] !== undefined);
	if (schedulerSet.length > 0 && schedulerSet.length < SCHEDULER_KEYS.length) {
		// 一部だけでは内蔵のタイマーに戻るので、Dkron のつもりの設定漏れに気づけるよう落とす
		return err([
			`${SCHEDULER_KEYS.filter((k) => e[k] === undefined).join(" / ")}: Dkron に任せるには ${SCHEDULER_KEYS.join(" / ")} がすべて要る`,
		]);
	}
	const scheduler =
		e.SCHEDULER_URL &&
		e.SCHEDULER_ACCESS_CLIENT_ID &&
		e.SCHEDULER_ACCESS_CLIENT_SECRET &&
		e.SCHEDULER_TOKEN &&
		e.SCHEDULER_SELF_URL
			? {
					url: e.SCHEDULER_URL,
					clientId: e.SCHEDULER_ACCESS_CLIENT_ID,
					clientSecret: e.SCHEDULER_ACCESS_CLIENT_SECRET,
					token: e.SCHEDULER_TOKEN,
					selfUrl: e.SCHEDULER_SELF_URL,
					port: e.SCHEDULER_PORT ?? 8092,
					syncIntervalMs: (e.SCHEDULER_SYNC_INTERVAL_MINUTES ?? 10) * 60_000,
					patrolSchedule: e.PATROL_SCHEDULE ?? "0 0 */2 * * *",
				}
			: null;
	const standupEnabled = (e.STANDUP_ENABLED ?? "true") === "true";
	const timeOf = (hhmm: string) => {
		const [hour = 0, minute = 0] = hhmm.split(":").map(Number);
		return { hour, minute };
	};
	return ok({
		discordToken: e.DISCORD_TOKEN,
		personaTokens: {
			yukarin: e.YUKARIN_DISCORD_TOKEN,
			akarin: e.AKARIN_DISCORD_TOKEN ?? null,
		},
		roleIds: {
			yukarin: e.YUKARIN_ROLE_ID ?? null,
			akarin: e.AKARIN_ROLE_ID ?? null,
		},
		inbox:
			e.MIZUYA_INBOX_URL &&
			e.MIZUYA_INBOX_TOKEN &&
			e.MIZUYA_ACCESS_CLIENT_ID &&
			e.MIZUYA_ACCESS_CLIENT_SECRET
				? {
						url: e.MIZUYA_INBOX_URL,
						token: e.MIZUYA_INBOX_TOKEN,
						clientId: e.MIZUYA_ACCESS_CLIENT_ID,
						clientSecret: e.MIZUYA_ACCESS_CLIENT_SECRET,
					}
				: null,
		codexHome: e.CODEX_HOME ?? `${home}/.codex`,
		workTextChannelId: e.WORK_TEXT_CHANNEL_ID,
		workForumChannelId: e.WORK_FORUM_CHANNEL_ID,
		ownerUserIds: new Set(owners),
		ownerDiscordUserId: owner,
		port: e.PORT ?? 8080,
		stateDir: e.STATE_DIR ?? `${home}/state`,
		workDir: e.WORK_DIR ?? `${home}/work`,
		personaScript: e.PERSONA_SCRIPT ?? `${home}/bin/persona.sh`,
		personaDir: e.PERSONA_DIR ?? `${home}/persona`,
		handoffDir: e.HANDOFF_DIR ?? `${home}/handoff`,
		claudeBin: e.CLAUDE_BIN ?? "claude",
		seatsRepo: e.SEATS_REPO ?? `${home}/work/seats`,
		// 既にある席の worktree をそのまま使えるよう、Orca が作っていた場所のままにする
		seatsDir: e.SEATS_DIR ?? `${home}/work/orca/workspaces/seats`,
		seatLimit: e.SEAT_LIMIT ?? 6,
		seatSleepAfterMs: (e.SEAT_SLEEP_AFTER_MINUTES ?? 120) * 60_000,
		// Anthropic のプロンプトキャッシュが残る長さ（約 1 時間）に合わせる
		seatDoneLingerMs: (e.SEAT_DONE_LINGER_MINUTES ?? 60) * 60_000,
		titleSettleMs: (e.TITLE_SETTLE_MINUTES ?? 60) * 60_000,
		logLevel: e.LOG_LEVEL ?? "info",
		memory:
			e.YUNOMI_URL && e.CF_ACCESS_CLIENT_ID && e.CF_ACCESS_CLIENT_SECRET
				? {
						url: e.YUNOMI_URL,
						clientId: e.CF_ACCESS_CLIENT_ID,
						clientSecret: e.CF_ACCESS_CLIENT_SECRET,
					}
				: null,
		memoryBin: e.MEMORY_BIN ?? "yunomi-memory",
		chimera:
			e.CHIMERA_URL &&
			e.CHIMERA_ACCESS_CLIENT_ID &&
			e.CHIMERA_ACCESS_CLIENT_SECRET
				? {
						url: e.CHIMERA_URL,
						clientId: e.CHIMERA_ACCESS_CLIENT_ID,
						clientSecret: e.CHIMERA_ACCESS_CLIENT_SECRET,
					}
				: null,
		playwright:
			e.PLAYWRIGHT_MCP_URL &&
			e.PLAYWRIGHT_ACCESS_CLIENT_ID &&
			e.PLAYWRIGHT_ACCESS_CLIENT_SECRET
				? {
						url: e.PLAYWRIGHT_MCP_URL,
						clientId: e.PLAYWRIGHT_ACCESS_CLIENT_ID,
						clientSecret: e.PLAYWRIGHT_ACCESS_CLIENT_SECRET,
					}
				: null,
		chakai:
			e.CHAKAI_MCP_URL &&
			e.CHAKAI_ACCESS_CLIENT_ID &&
			e.CHAKAI_ACCESS_CLIENT_SECRET
				? {
						url: e.CHAKAI_MCP_URL,
						clientId: e.CHAKAI_ACCESS_CLIENT_ID,
						clientSecret: e.CHAKAI_ACCESS_CLIENT_SECRET,
					}
				: null,
		hishaku:
			e.HISHAKU_URL &&
			e.HISHAKU_ACCESS_CLIENT_ID &&
			e.HISHAKU_ACCESS_CLIENT_SECRET
				? {
						url: e.HISHAKU_URL,
						clientId: e.HISHAKU_ACCESS_CLIENT_ID,
						clientSecret: e.HISHAKU_ACCESS_CLIENT_SECRET,
						// コンテナのホスト名は作り直すたびに変わるので、hs の既定（ホスト名）に任せない
						holder: e.HISHAKU_HOLDER ?? "docker01",
						bin: e.HS_BIN ?? "hs",
					}
				: null,
		macState: e.MAC_STATE_TOKEN
			? { token: e.MAC_STATE_TOKEN, port: e.MAC_STATE_PORT ?? 8090 }
			: null,
		seatStatus: e.SEAT_STATUS_TOKEN
			? { token: e.SEAT_STATUS_TOKEN, port: e.SEAT_STATUS_PORT ?? 8091 }
			: null,
		scheduler,
		standup: {
			enabled: standupEnabled,
			timer: standupEnabled && scheduler === null,
			at: timeOf(e.STANDUP_TIME ?? "09:00"),
			githubOwner: e.STANDUP_GITHUB_OWNER ?? "ochanuco",
			heartbeatIntervalMs:
				(e.HEARTBEAT_ENABLED ?? "true") === "true"
					? (e.HEARTBEAT_INTERVAL_MINUTES ?? 120) * 60_000
					: null,
		},
		activityLog: e.ACTIVITY_LOG_THREAD_ID
			? {
					threadId: e.ACTIVITY_LOG_THREAD_ID,
					at: timeOf(e.ACTIVITY_LOG_TIME ?? "23:30"),
				}
			: null,
	});
};
