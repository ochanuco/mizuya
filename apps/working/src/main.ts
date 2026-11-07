import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	gatherActivityPrs,
	openActivityLog,
	postActivityLog,
	startDailyTimer,
} from "./activity-log.ts";
import { openApprovalStore } from "./approval-store.ts";
import {
	createAttachmentCollector,
	createChimeraImages,
} from "./attachments.ts";
import { childEnv, createSummarizer } from "./claude-cli.ts";
import { claudeConfigPathOf, trustWorkspace } from "./claude-trust.ts";
import { syncCodexMcpServer } from "./codex-mcp.ts";
import { trustCodexProject } from "./codex-trust.ts";
import { loadConfig } from "./config.ts";
import { createDiscordRest } from "./discord-rest.ts";
import { spawnExec } from "./exec.ts";
import { startWorkGateway } from "./gateway.ts";
import { createGithubEventBatcher, runGithubEvents } from "./github-events.ts";
import { guardDirOf } from "./guard/env.ts";
import { createLedger } from "./guard/ledger.ts";
import { startInbox } from "./inbox.ts";
import { agentOf, createIntake, type SeatPartner } from "./intake.ts";
import { createLogger } from "./logger.ts";
import { createMacStateServer, openMacStateStore } from "./mac-state.ts";
import { credentialsPathOf } from "./memory-cli/cli.ts";
import { createOrcaCli } from "./orca.ts";
import { openPatrolStore } from "./patrol.ts";
import { readTypicalSleep } from "./persona-profile.ts";
import { buildSeatPreamble } from "./prompts.ts";
import { startRepoMapSync } from "./repo-map/sync.ts";
import { openSeatStore } from "./seat-store.ts";
import { createHealthServer } from "./server.ts";
import { finishStandup, startStandup } from "./standup.ts";
import { gatherStandupMaterials } from "./standup-materials.ts";
import { parseQuietHours, startStandupTimer } from "./standup-timer.ts";
import { createSystemPoster } from "./system.ts";
import {
	claudeCredentialsPathOf,
	createClaudeUsageReader,
	createCodexUsageReader,
	startUsagePolling,
	usageByPartner,
} from "./usage.ts";
import { startWorkActivity } from "./work-activity.ts";

const config = loadConfig(process.env);
if (!config.ok) {
	console.error("設定が不正です:");
	for (const issue of config.error) console.error(`  - ${issue}`);
	process.exit(1);
}
const cfg = config.value;
const logger = createLogger(cfg.logLevel);

const typicalSleep = await readTypicalSleep(
	join(cfg.personaDir, "yukarin", "profile.yaml"),
);
if (!typicalSleep.ok) {
	console.error(`人格を読めない: ${typicalSleep.error.reason}`);
	process.exit(1);
}

const personaOf = async (args: string[]) =>
	(
		await promisify(execFile)(cfg.personaScript, args, {
			maxBuffer: 10_000_000,
		})
	).stdout;
await mkdir(cfg.stateDir, { recursive: true });
await mkdir(cfg.workDir, { recursive: true });
const handoffPrompt = await readFile(join(cfg.handoffDir, "prompt.md"), "utf8");
const issueTemplate = await readFile(
	join(cfg.handoffDir, "issue-template.md"),
	"utf8",
);
const preamble = buildSeatPreamble({
	persona: await personaOf([]),
	handoffPrompt,
	issueTemplate,
});

// yunomi-memory はこのファイルから接続情報を読む。Claude CLI の環境変数に service token を載せないため
const credentialsPath = credentialsPathOf(cfg.stateDir);
if (cfg.memory) {
	await writeFile(
		credentialsPath,
		JSON.stringify({
			url: cfg.memory.url,
			client_id: cfg.memory.clientId,
			client_secret: cfg.memory.clientSecret,
			discord_user_id: cfg.ownerDiscordUserId,
			partner_id: "yukarin",
		}),
		{ mode: 0o600 },
	);
} else {
	await rm(credentialsPath, { force: true });
	logger.warn("working memory disabled", {
		reason: "YUNOMI_URL / CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET",
	});
}

// 受信・ボタン・状態の欄は mizuya の bot、席の発言・投稿・リアクション・入力中の表示は人格の bot で行う
const rest = createDiscordRest({ token: cfg.discordToken, logger });
const me = await rest.me();
if (!me.ok) {
	logger.error("discord login failed", { error: me.error.type });
	process.exit(1);
}
const system = createSystemPoster(rest);
const discord = createDiscordRest({
	token: cfg.personaTokens.yukarin,
	logger,
});
const yukarinMe = await discord.me();
if (!yukarinMe.ok) {
	logger.error("yukarin discord login failed", {
		error: yukarinMe.error.type,
	});
	process.exit(1);
}

// Akarin の bot に入れなければ Akarin の席を作らず、Akarin 宛ての依頼も Yukarin が受ける
const akarin: SeatPartner | null = await (async () => {
	const token = cfg.personaTokens.akarin;
	if (!token) {
		logger.info("akarin seats disabled", { reason: "AKARIN_DISCORD_TOKEN" });
		return null;
	}
	const akarinDiscord = createDiscordRest({ token, logger });
	const akarinMe = await akarinDiscord.me();
	if (!akarinMe.ok) {
		logger.error("akarin discord login failed; akarin seats disabled", {
			error: akarinMe.error.type,
		});
		return null;
	}
	return {
		discord: akarinDiscord,
		botUserId: akarinMe.value.id,
		preamble: buildSeatPreamble({
			persona: await personaOf(["akarin"]),
			handoffPrompt,
			issueTemplate,
			partnerName: "Akarin",
		}),
	};
})();

const env = childEnv(process.env, cfg.stateDir);
const summarize = createSummarizer({
	bin: cfg.claudeBin,
	cwd: cfg.workDir,
	env,
	exec: spawnExec,
});
const orca = createOrcaCli({
	bin: cfg.orcaBin,
	exec: spawnExec,
	env,
	cwd: cfg.workDir,
	seatsRepo: cfg.seatsRepo,
	seatsDir: cfg.seatsDir,
	specDir: join(cfg.stateDir, "specs"),
	trust: (dir) => trustWorkspace(claudeConfigPathOf(process.env), dir),
	logger,
});
const ORCA_READY_TIMEOUT_MS = 180_000;
const seats = await openSeatStore(cfg.stateDir);
const approvals = await openApprovalStore(cfg.stateDir);
const ledger = createLedger(guardDirOf(cfg.stateDir));
const macState = openMacStateStore(cfg.stateDir);
const patrolStore = openPatrolStore(cfg.stateDir);
const activityLog = openActivityLog(cfg.stateDir);
const standupDeps = {
	discord,
	system,
	ownerUserId: cfg.ownerDiscordUserId,
	approvals,
	ledger,
	workForumChannelId: cfg.workForumChannelId,
	workTextChannelId: cfg.workTextChannelId,
	recordActivity: activityLog.record,
	watchThreads: new Map<string, string>(),
	logger,
};

// start.sh は受付と orca serve を同時に起動するので、serve が受け付けるまで待ってから席の準備をする
logger.info("discord connected", { bot_user_id: me.value.id });
const ready = await orca.waitReady(ORCA_READY_TIMEOUT_MS);
if (!ready.ok) {
	logger.error("orca serve not ready", { reason: ready.error.reason });
	process.exit(1);
}
logger.info("orca serve ready");
const prepared = await orca.prepare(seats.orca());
if (!prepared.ok) {
	logger.error("orca prepare failed", { reason: prepared.error.reason });
	process.exit(1);
}
await seats.setOrca(prepared.value);
logger.info("orca prepared", { run_id: prepared.value.runId });
{
	const added = await trustCodexProject(
		join(cfg.codexHome, "config.toml"),
		await realpath(cfg.seatsRepo),
	);
	if (added) logger.info("codex trusted seats repo");
	const mcp = await syncCodexMcpServer(
		join(cfg.codexHome, "config.toml"),
		"playwright",
		cfg.playwright && {
			url: cfg.playwright.url,
			headers: {
				"CF-Access-Client-Id": cfg.playwright.clientId,
				"CF-Access-Client-Secret": cfg.playwright.clientSecret,
			},
		},
	);
	if (mcp) {
		logger.info("codex playwright mcp updated", {
			enabled: cfg.playwright !== null,
		});
	}
}

if (!cfg.chimera) {
	logger.warn("chimera images disabled", {
		reason:
			"CHIMERA_URL / CHIMERA_ACCESS_CLIENT_ID / CHIMERA_ACCESS_CLIENT_SECRET",
	});
}
// chimera の service token は受付だけが持つ。席の Claude には seat-env.sh が渡さない
const collectAttachments = createAttachmentCollector({
	chimera: cfg.chimera
		? createChimeraImages({
				baseUrl: cfg.chimera.url,
				clientId: cfg.chimera.clientId,
				clientSecret: cfg.chimera.clientSecret,
			})
		: null,
	logger,
});

const intake = createIntake({
	discord,
	orca,
	seats,
	approvals,
	ledger,
	summarize,
	collectAttachments,
	remember: async (summary, partner) => {
		if (!cfg.memory) return;
		const out = await spawnExec(
			cfg.memoryBin,
			["write", "--kind", "done", "--summary", summary.slice(0, 200)],
			{
				stdin: "",
				cwd: cfg.workDir,
				timeoutMs: 30_000,
				env: { ...env, YUNOMI_PARTNER: partner },
			},
		);
		if (out.code !== 0) {
			logger.warn("memory write failed", { stderr: out.stderr.slice(0, 300) });
		}
	},
	recordActivity: activityLog.record,
	standupDone: async (text, blocked, kind) => {
		await finishStandup(standupDeps, text, blocked, kind);
	},
	preamble,
	botUserId: yukarinMe.value.id,
	system,
	systemUserId: me.value.id,
	akarin,
	roleIds: cfg.roleIds,
	workTextChannelId: cfg.workTextChannelId,
	workForumChannelId: cfg.workForumChannelId,
	ownerUserIds: cfg.ownerUserIds,
	seatLimit: cfg.seatLimit,
	sleepAfterMs: cfg.seatSleepAfterMs,
	logger,
});
await intake.reconcile();
logger.info("seats reconciled", { seats: seats.all().length });

// 席からのメッセージを待ち続ける。受付が落ちている間に届いたものも、次の check で受け取れる
let stopped = false;
const MAIL_WAIT_MS = 10 * 60_000;
void (async () => {
	while (!stopped) {
		const r = await orca.waitMessages(MAIL_WAIT_MS);
		if (!r.ok) {
			logger.warn("seat mail check failed", { reason: r.error.reason });
			await new Promise((res) => setTimeout(res, 5_000));
			continue;
		}
		for (const msg of r.value) {
			void intake.onSeatMessage(msg).catch((e: unknown) => {
				logger.error("seat message crashed", { id: msg.id, error: String(e) });
			});
		}
	}
})();
const sleepTimer = setInterval(() => {
	void intake.sleepIdle().catch((e: unknown) => {
		logger.error("seat sleep crashed", { error: String(e) });
	});
	void intake.refreshPanels().catch((e: unknown) => {
		logger.error("seat panel refresh crashed", { error: String(e) });
	});
}, 60_000);

// 席の Claude の SessionStart hook は写しだけを読み、席を起動するたびに GitHub へ行かない
const REPO_MAP_SYNC_MS = 60 * 60_000;
const repoMapSync = startRepoMapSync({
	exec: spawnExec,
	env,
	cwd: cfg.workDir,
	stateDir: cfg.stateDir,
	logger,
	intervalMs: REPO_MAP_SYNC_MS,
});

const usage = startUsagePolling({
	readers: {
		claude: createClaudeUsageReader({
			credentialsPath: claudeCredentialsPathOf(process.env),
		}),
		codex: createCodexUsageReader({
			bin: "codex",
			env: { ...env, CODEX_HOME: cfg.codexHome },
		}),
	},
	logger,
});

const server = createHealthServer();
server.listen(cfg.port, () => {
	logger.info("working intake ready", {
		port: cfg.port,
		bot_user_id: me.value.id,
	});
});

const gateway = await startWorkGateway({
	token: cfg.discordToken,
	textChannelId: cfg.workTextChannelId,
	forumChannelId: cfg.workForumChannelId,
	accept: (envelope) => {
		void intake.handle(envelope).catch((e: unknown) => {
			logger.error("intake crashed", {
				event_id: envelope.event_id,
				error: String(e),
			});
		});
	},
	logger,
});

const stopWorkActivity = startWorkActivity({
	snapshot: () => ({
		partners: intake.summary().partners,
		usage: usageByPartner(usage.current(), agentOf),
	}),
	setActivity: gateway.setActivity,
	setBio: gateway.setBio,
	logger,
});

const macStateServer = cfg.macState
	? createMacStateServer({ token: cfg.macState.token, store: macState, logger })
	: null;
if (cfg.macState && macStateServer) {
	const { port } = cfg.macState;
	macStateServer.listen(port, () => {
		logger.info("mac state intake ready", { port });
	});
}

// 見回りと GitHub の出来事の席は patrol-state.json を読んで書くので、一つずつ回す。失敗は呼び出し側のログに残す
let patrolTail: Promise<unknown> = Promise.resolve();
const inPatrolLane = <T>(task: () => Promise<T>): Promise<T> => {
	const next = patrolTail.then(task, task);
	patrolTail = next.catch(() => {});
	return next;
};

const standupTimer = cfg.standup.enabled
	? startStandupTimer({
			plan: {
				standupAt: cfg.standup.at,
				intervalMs: cfg.standup.heartbeatIntervalMs,
				// 朝会と見回りは Yukarin の席で回すので、Yukarin が寝ている時間帯は見回らない
				quiet: parseQuietHours(typicalSleep.value),
			},
			run: (kind) =>
				inPatrolLane(async () => {
					await startStandup({
						deps: standupDeps,
						kind,
						store: patrolStore,
						gather: () =>
							gatherStandupMaterials({
								exec: spawnExec,
								env,
								cwd: cfg.workDir,
								claudeBin: cfg.claudeBin,
								memoryBin: cfg.memoryBin,
								githubOwner: cfg.standup.githubOwner,
								macState,
								now: () => new Date(),
								logger,
							}),
						preamble,
						start: intake.startStandup,
					});
				}),
			logger,
		})
	: null;

const activityLogConfig = cfg.activityLog;
const activityLogTimer = activityLogConfig
	? startDailyTimer({
			at: activityLogConfig.at,
			run: () =>
				postActivityLog({
					log: activityLog,
					gatherPrs: (since, until) =>
						gatherActivityPrs({
							exec: spawnExec,
							env,
							cwd: cfg.workDir,
							owner: cfg.standup.githubOwner,
							since,
							until,
							logger,
						}),
					discord,
					threadId: activityLogConfig.threadId,
					now: () => new Date(),
					logger,
				}),
			logger,
		})
	: null;
if (!activityLogConfig) {
	logger.info("activity log disabled", { reason: "ACTIVITY_LOG_THREAD_ID" });
}

// 自分の書いたコメントで席を立てないよう、GH_TOKEN の持ち主を一度だけ引く
const githubSelfLogin = async (): Promise<string | null> => {
	const out = await spawnExec("gh", ["api", "user", "--jq", ".login"], {
		stdin: "",
		cwd: cfg.workDir,
		timeoutMs: 30_000,
		env,
	});
	const login = out.stdout.trim();
	if (out.code !== 0 || login === "") {
		logger.warn("github self login unknown", {
			stderr: out.stderr.slice(0, 300),
		});
		return null;
	}
	return login;
};

// 同じ PR の出来事が続けて届いたら一つの席にまとめるため、少し待ってから回す
const GITHUB_EVENTS_WAIT_MS = 30_000;
const githubEvents = cfg.standup.enabled
	? await (async () => {
			const selfLogin = await githubSelfLogin();
			return createGithubEventBatcher({
				run: (events) =>
					inPatrolLane(async () => {
						await runGithubEvents(
							{
								store: patrolStore,
								preamble,
								selfLogin,
								start: intake.startStandup,
								logger,
							},
							events,
						);
					}),
				waitMs: GITHUB_EVENTS_WAIT_MS,
				logger,
			});
		})()
	: null;

// 受け箱は GitHub の出来事の渡し先ができてからつなぐ。つないだ直後に溜まっていた行が届く
if (!cfg.inbox) {
	logger.warn("mizuya inbox disabled; buttons are not received", {
		reason:
			"MIZUYA_INBOX_URL / MIZUYA_INBOX_TOKEN / MIZUYA_ACCESS_CLIENT_ID / MIZUYA_ACCESS_CLIENT_SECRET",
	});
}
const inbox = cfg.inbox
	? startInbox({
			connection: cfg.inbox,
			handlers: {
				press: (envelope) => {
					void intake.press(envelope).catch((e: unknown) => {
						logger.error("intake crashed", {
							event_id: envelope.event_id,
							error: String(e),
						});
					});
				},
				...(githubEvents ? { github: githubEvents.push } : {}),
			},
			logger,
		})
	: null;

const shutdown = (signal: string) => {
	logger.info("shutting down", { signal });
	stopped = true;
	clearInterval(sleepTimer);
	repoMapSync.stop();
	usage.stop();
	standupTimer?.stop();
	activityLogTimer?.stop();
	githubEvents?.stop();
	macStateServer?.close();
	server.close();
	inbox?.stop();
	stopWorkActivity();
	void gateway.stop();
	process.exit(0);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
