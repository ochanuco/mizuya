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
import { createChakai } from "./chakai.ts";
import { pickupTasks } from "./chakai-pickup.ts";
import { childEnv, createSummarizer } from "./claude-cli.ts";
import {
	claudeConfigPathOf,
	syncClaudeMcpServer,
	trustWorkspace,
} from "./claude-trust.ts";
import { syncCodexMcpServer } from "./codex-mcp.ts";
import { trustCodexProject } from "./codex-trust.ts";
import { loadConfig } from "./config.ts";
import { createDiscordRest } from "./discord-rest.ts";
import { spawnExec } from "./exec.ts";
import { startWorkGateway } from "./gateway.ts";
import { createGithubEventBatcher, runGithubEvents } from "./github-events.ts";
import { guardDirOf } from "./guard/env.ts";
import { createLedger } from "./guard/ledger.ts";
import { createHishaku } from "./hishaku.ts";
import { startInbox } from "./inbox.ts";
import { agentOf, createIntake, type SeatPartner } from "./intake.ts";
import { createGhIssueTracker } from "./issue-close.ts";
import { pickupIssues, startIssuePickupTimer } from "./issue-pickup.ts";
import { ok, PARTNER_IDS } from "./lib/core.ts";
import { createLogger } from "./logger.ts";
import { createMacStateServer, openMacStateStore } from "./mac-state.ts";
import { credentialsPathOf } from "./memory-cli/cli.ts";
import { openPatrolStore } from "./patrol.ts";
import { readTypicalSleep } from "./persona-profile.ts";
import { buildSeatPreamble } from "./prompts.ts";
import { startRepoMapSync } from "./repo-map/sync.ts";
import {
	createDkronClient,
	createSchedulerServer,
	desiredJobs,
	type RunRequest,
	startSchedulerSync,
} from "./scheduler.ts";
import { createSeatStatusServer } from "./seat-status.ts";
import { openSeatStore } from "./seat-store.ts";
import { createHealthServer } from "./server.ts";
import {
	finishStandup,
	startStandup,
	startWatch,
	type WatchTarget,
} from "./standup.ts";
import {
	gatherStandupMaterials,
	readWatches,
	withoutWatches,
} from "./standup-materials.ts";
import {
	type HeartbeatKind,
	type HeartbeatPlan,
	parseQuietHours,
	patrolDue,
	startStandupTimer,
} from "./standup-timer.ts";
import { createSystemPoster } from "./system.ts";
import { createTurnEngine, seatEnv } from "./turn-engine.ts";
import {
	claudeCredentialsPathOf,
	createClaudeUsageReader,
	createCodexUsageReader,
	startUsagePolling,
	usageByPartner,
} from "./usage.ts";
import { createFindWorkBranches } from "./work-branch.ts";

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
const trustSeat = (dir: string) =>
	trustWorkspace(claudeConfigPathOf(process.env), dir);
// hs は prepare と push の間の状態を XDG_CACHE_HOME に残す。受付を作り直しても続きを預けられるよう state の volume に置く
const hsCacheDir = join(cfg.stateDir, "cache");
const engine = createTurnEngine({
	hsBin: cfg.hishaku?.bin ?? "hs",
	exec: spawnExec,
	seatEnv: seatEnv(process.env, {
		stateDir: cfg.stateDir,
		seatsDir: cfg.seatsDir,
	}),
	hishakuEnv: cfg.hishaku
		? {
				HISHAKU_URL: cfg.hishaku.url,
				HISHAKU_ACCESS_CLIENT_ID: cfg.hishaku.clientId,
				HISHAKU_ACCESS_CLIENT_SECRET: cfg.hishaku.clientSecret,
				HISHAKU_HOLDER: cfg.hishaku.holder,
				CODEX_HOME: cfg.codexHome,
				XDG_CACHE_HOME: hsCacheDir,
			}
		: {},
	seatsRepo: cfg.seatsRepo,
	seatsDir: cfg.seatsDir,
	specDir: join(cfg.stateDir, "specs"),
	trust: trustSeat,
	logger,
});
const hishaku = cfg.hishaku
	? createHishaku({
			...cfg.hishaku,
			exec: spawnExec,
			env: {
				...env,
				CODEX_HOME: cfg.codexHome,
				XDG_CACHE_HOME: hsCacheDir,
			},
			cwd: cfg.workDir,
		})
	: null;
if (!hishaku) {
	logger.warn("hishaku disabled", {
		reason:
			"HISHAKU_URL / HISHAKU_ACCESS_CLIENT_ID / HISHAKU_ACCESS_CLIENT_SECRET",
	});
}
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
	speakers: akarin ? { akarin: akarin.discord } : {},
	assign: seats.assign,
	watchThreads: new Map<string, WatchTarget>(),
	logger,
};

logger.info("discord connected", { bot_user_id: me.value.id });
const started = await engine.start();
if (!started.ok) {
	logger.error("seat engine failed to start", {
		reason: started.error.reason,
	});
	process.exit(1);
}
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
	// chakai は X-Actor で席の人格を見分ける。席の agent は人格ごとに決まっているので、agent の設定に人格を書ける
	for (const partner of PARTNER_IDS) {
		const server = cfg.chakai && {
			url: cfg.chakai.url,
			headers: {
				"CF-Access-Client-Id": cfg.chakai.clientId,
				"CF-Access-Client-Secret": cfg.chakai.clientSecret,
				"X-Actor": partner,
			},
		};
		const agent = agentOf(partner);
		const synced =
			agent === "claude"
				? await syncClaudeMcpServer(
						claudeConfigPathOf(process.env),
						"chakai",
						server,
					)
				: ok(
						await syncCodexMcpServer(
							join(cfg.codexHome, "config.toml"),
							"chakai",
							server,
						),
					);
		if (!synced.ok) {
			logger.warn("chakai mcp not updated", {
				agent,
				reason: synced.error.reason,
			});
		} else if (synced.value) {
			logger.info("chakai mcp updated", {
				agent,
				enabled: cfg.chakai !== null,
			});
		}
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

// 同期は intake より後に作るので、席の返事の時点で決まっている方を呼ぶ
let syncScheduler: (() => void) | null = null;

// 席の agent は MCP で使い、受付は同じ service token で REST を呼ぶ
const chakai = cfg.chakai
	? createChakai({
			mcpUrl: cfg.chakai.url,
			clientId: cfg.chakai.clientId,
			clientSecret: cfg.chakai.clientSecret,
		})
	: null;

const intake = createIntake({
	seatReplied: () => syncScheduler?.(),
	discord,
	engine,
	hishaku,
	findWorkBranches: hishaku
		? createFindWorkBranches({ exec: spawnExec, env })
		: null,
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
	standupDone: async (text, blocked, kind, partner) => {
		await finishStandup(standupDeps, text, blocked, kind, partner);
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
	notifyUserId: cfg.ownerDiscordUserId,
	issues: createGhIssueTracker({ exec: spawnExec, env, cwd: cfg.workDir }),
	chakai,
	seatLimit: cfg.seatLimit,
	sleepAfterMs: cfg.seatSleepAfterMs,
	doneLingerMs: cfg.seatDoneLingerMs,
	titleSettleMs: cfg.titleSettleMs,
	logger,
});
await intake.reconcile();
logger.info("seats reconciled", { seats: seats.all().length });

// 席からのメッセージを待ち続ける。受付が落ちている間に届いたものも、次の check で受け取れる
let stopped = false;
const MAIL_WAIT_MS = 10 * 60_000;
void (async () => {
	while (!stopped) {
		const r = await engine.waitMessages(MAIL_WAIT_MS);
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
	void intake.applyDueTitles().catch((e: unknown) => {
		logger.error("thread title apply crashed", { error: String(e) });
	});
	void intake.watchLends().catch((e: unknown) => {
		logger.error("hishaku lend watch crashed", { error: String(e) });
	});
}, 60_000);
// hs の貸し出しの期限（数分）より短い間隔で延ばす
const LEASE_RENEW_MS = 30_000;
const leaseTimer = setInterval(() => {
	void intake.renewLeases().catch((e: unknown) => {
		logger.error("hishaku renew crashed", { error: String(e) });
	});
}, LEASE_RENEW_MS);

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

const seatStatusConfig = cfg.seatStatus;
const seatStatusServer = seatStatusConfig
	? createSeatStatusServer({
			token: seatStatusConfig.token,
			status: (partner) => ({
				working: intake.summary().partners[partner],
				usage: usageByPartner(usage.current(), agentOf)[partner] ?? null,
			}),
		})
	: null;
if (seatStatusConfig && seatStatusServer) {
	seatStatusServer.listen(seatStatusConfig.port, () => {
		logger.info("seat status ready", { port: seatStatusConfig.port });
	});
}

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

const heartbeatPlan: HeartbeatPlan = {
	standupAt: cfg.standup.at,
	intervalMs: cfg.standup.heartbeatIntervalMs,
	// 朝会と見回りは Yukarin の席で回すので、Yukarin が寝ている時間帯は見回らない
	quiet: parseQuietHours(typicalSleep.value),
};
const schedulerConfig = cfg.scheduler;
const memoryDeps = {
	exec: spawnExec,
	env,
	cwd: cfg.workDir,
	memoryBin: cfg.memoryBin,
	logger,
};

const runHeartbeat = (kind: HeartbeatKind) =>
	inPatrolLane(async () => {
		await startStandup({
			deps: standupDeps,
			kind,
			store: patrolStore,
			gather: async () => {
				const materials = await gatherStandupMaterials({
					...memoryDeps,
					claudeBin: cfg.claudeBin,
					partners: PARTNER_IDS,
					githubOwner: cfg.standup.githubOwner,
					macState,
					now: () => new Date(),
				});
				return schedulerConfig ? withoutWatches(materials) : materials;
			},
			start: intake.startStandup,
		});
	});

const standupTimer = cfg.standup.timer
	? startStandupTimer({ plan: heartbeatPlan, run: runHeartbeat, logger })
	: null;

const runScheduled = async (r: RunRequest) => {
	if (r.kind === "standup") return runHeartbeat("standup");
	if (r.kind === "patrol") {
		if (!patrolDue(new Date(), heartbeatPlan)) {
			logger.info("patrol skipped", { reason: "quiet or near standup" });
			return;
		}
		return runHeartbeat("patrol");
	}
	await inPatrolLane(() =>
		startWatch({
			deps: standupDeps,
			partner: r.partner,
			watchId: r.watchId,
			read: (partner) => readWatches(memoryDeps, partner),
			start: intake.startStandup,
		}),
	);
};

// 朝会を止めているときは起こされる口を開かず、同期で受付のジョブを Dkron から消す
const schedulerServer =
	schedulerConfig && cfg.standup.enabled
		? createSchedulerServer({
				token: schedulerConfig.token,
				run: runScheduled,
				logger,
			})
		: null;
if (schedulerConfig && schedulerServer) {
	const { port } = schedulerConfig;
	schedulerServer.listen(port, () => {
		logger.info("scheduler intake ready", { port });
	});
}
const schedulerSync = schedulerConfig
	? startSchedulerSync({
			client: createDkronClient({
				url: schedulerConfig.url,
				clientId: schedulerConfig.clientId,
				clientSecret: schedulerConfig.clientSecret,
			}),
			desired: async () =>
				desiredJobs({
					standupAt: cfg.standup.enabled ? cfg.standup.at : null,
					patrolSchedule:
						cfg.standup.enabled && cfg.standup.heartbeatIntervalMs !== null
							? schedulerConfig.patrolSchedule
							: null,
					watches: cfg.standup.enabled
						? await Promise.all(
								PARTNER_IDS.map(
									async (p) => [p, await readWatches(memoryDeps, p)] as const,
								),
							)
						: [],
					selfUrl: schedulerConfig.selfUrl,
					token: schedulerConfig.token,
				}),
			intervalMs: schedulerConfig.syncIntervalMs,
			logger,
		})
	: null;
if (schedulerSync) syncScheduler = () => void schedulerSync.syncNow();

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

// label の付いた issue は Discord の依頼と同じく、仕事フォーラムの投稿を立てて席で作業する
const ISSUE_PICKUP_INTERVAL_MS = 10 * 60_000;
const issuePickupTimer = cfg.standup.enabled
	? startIssuePickupTimer({
			run: () =>
				pickupIssues({
					exec: spawnExec,
					env,
					cwd: cfg.workDir,
					owner: cfg.standup.githubOwner,
					akarinEnabled: akarin !== null,
					working: () => intake.summary().partners,
					start: intake.startFromIssue,
					logger,
				}),
			intervalMs: ISSUE_PICKUP_INTERVAL_MS,
			logger,
		})
	: null;

// chakai で担当を割り当てた todo のタスクも、issue と同じ間隔の見回りで拾って席を立てる
const taskPickupTimer = chakai
	? startIssuePickupTimer({
			run: () =>
				pickupTasks({
					chakai,
					akarinEnabled: akarin !== null,
					start: intake.startFromTask,
					logger,
				}),
			intervalMs: ISSUE_PICKUP_INTERVAL_MS,
			logger,
			name: "chakai task pickup",
		})
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
				command: (envelope) => {
					void intake.command(envelope).catch((e: unknown) => {
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
	clearInterval(leaseTimer);
	repoMapSync.stop();
	usage.stop();
	standupTimer?.stop();
	schedulerSync?.stop();
	schedulerServer?.close();
	activityLogTimer?.stop();
	githubEvents?.stop();
	issuePickupTimer?.stop();
	taskPickupTimer?.stop();
	macStateServer?.close();
	server.close();
	inbox?.stop();
	seatStatusServer?.close();
	void gateway.stop();
	process.exit(0);
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
