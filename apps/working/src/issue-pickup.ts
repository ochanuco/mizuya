import * as v from "valibot";
import type { Exec } from "./exec.ts";
import type { PartnerId } from "./lib/core.ts";
import type { Result } from "./lib/result.ts";
import type { Logger } from "./logger.ts";
import type { PickedIssue } from "./prompts.ts";
import { partnerName } from "./seat-model.ts";

/** label は chabatake（github/labels.tf）が全 repo に置いている。名前を変えるときは両方を合わせる。 */
export const ISSUE_LABELS = {
	any: "working",
	yukarin: "working-yukarin",
	akarin: "working-akarin",
	picked: "working-picked",
} as const;

const searchSchema = v.array(
	v.object({
		repository: v.object({ nameWithOwner: v.string() }),
		number: v.number(),
		title: v.string(),
		url: v.string(),
		body: v.optional(v.string()),
		labels: v.optional(v.array(v.object({ name: v.string() }))),
	}),
);

/**
 * label から席を決める。席の指定が無ければ、作業中の席が少ないほうに渡す。
 * あかりんの席が無いときにあかりん宛ての issue は拾わず、label を残して後で拾えるようにする。
 */
export const choosePartner = (
	labels: readonly string[],
	working: Record<PartnerId, number>,
	akarinEnabled: boolean,
): PartnerId | null => {
	if (labels.includes(ISSUE_LABELS.yukarin)) return "yukarin";
	if (labels.includes(ISSUE_LABELS.akarin))
		return akarinEnabled ? "akarin" : null;
	if (!akarinEnabled) return "yukarin";
	return working.akarin < working.yukarin ? "akarin" : "yukarin";
};

export type IssuePickupDeps = {
	exec: Exec;
	env: Record<string, string>;
	cwd: string;
	owner: string;
	akarinEnabled: boolean;
	/** パートナーごとの作業中の席の数。 */
	working: () => Record<PartnerId, number>;
	start: (
		issue: PickedIssue,
		partner: PartnerId,
	) => Promise<Result<{ threadId: string }, { type: string }>>;
	logger: Logger;
};

const GH_TIMEOUT_MS = 60_000;

export const pickupIssues = async (deps: IssuePickupDeps): Promise<void> => {
	const log = deps.logger;
	const gh = (args: readonly string[]) =>
		deps.exec("gh", args, {
			stdin: "",
			cwd: deps.cwd,
			timeoutMs: GH_TIMEOUT_MS,
			env: deps.env,
		});
	const found = await gh([
		"search",
		"issues",
		"--owner",
		deps.owner,
		"--state",
		"open",
		"--sort",
		"created",
		"--order",
		"asc",
		"--json",
		"repository,number,title,url,body,labels",
		"--limit",
		"50",
		"--",
		`label:${ISSUE_LABELS.any},${ISSUE_LABELS.yukarin},${ISSUE_LABELS.akarin}`,
		`-label:${ISSUE_LABELS.picked}`,
	]);
	if (found.code !== 0) {
		log.warn("issue search failed", { stderr: found.stderr.slice(0, 300) });
		return;
	}
	let json: unknown;
	try {
		json = JSON.parse(found.stdout);
	} catch {
		log.warn("issue search output not json", {});
		return;
	}
	const parsed = v.safeParse(searchSchema, json);
	if (!parsed.success) {
		log.warn("issue search output unexpected", {});
		return;
	}
	const working = { ...deps.working() };
	for (const item of parsed.output) {
		const labels = (item.labels ?? []).map((l) => l.name);
		// search の索引は label の付け外しに遅れるので、拾った印は結果でも見る
		if (labels.includes(ISSUE_LABELS.picked)) continue;
		const issue: PickedIssue = {
			repo: item.repository.nameWithOwner,
			number: item.number,
			title: item.title,
			url: item.url,
			body: item.body ?? "",
		};
		const ref = `${issue.repo}#${issue.number}`;
		const partner = choosePartner(labels, working, deps.akarinEnabled);
		if (partner === null) {
			log.info("issue skipped; seat unavailable", { issue: ref });
			continue;
		}
		const issueArgs = [String(issue.number), "--repo", issue.repo];
		// 先に印を付け、席を立てた後で印が付かずに次の回でもう一度拾うことを避ける
		const marked = await gh([
			"issue",
			"edit",
			...issueArgs,
			"--add-label",
			ISSUE_LABELS.picked,
		]);
		if (marked.code !== 0) {
			log.warn("issue mark failed", {
				issue: ref,
				stderr: marked.stderr.slice(0, 300),
			});
			continue;
		}
		const started = await deps.start(issue, partner);
		if (!started.ok) {
			// 印を外して次の回に拾い直す
			const unmarked = await gh([
				"issue",
				"edit",
				...issueArgs,
				"--remove-label",
				ISSUE_LABELS.picked,
			]);
			log.error("issue pickup failed", {
				issue: ref,
				error: started.error.type,
				unmarked: unmarked.code === 0,
			});
			continue;
		}
		working[partner] += 1;
		log.info("issue picked", {
			issue: ref,
			partner,
			thread_id: started.value.threadId,
		});
		// public の repo にも書くので、Discord の ID やリンクは載せない
		const commented = await gh([
			"issue",
			"comment",
			...issueArgs,
			"--body",
			`Working の${partnerName(partner)}の席が拾い、Discord の仕事フォーラムで作業します。`,
		]);
		if (commented.code !== 0) {
			log.warn("issue comment failed", {
				issue: ref,
				stderr: commented.stderr.slice(0, 300),
			});
		}
	}
};

/** intervalMs ごとに run を回す。前の回が終わっていなければその回は飛ばす。 */
export const startIssuePickupTimer = (input: {
	run: () => Promise<void>;
	intervalMs: number;
	logger: Logger;
	/** ログに出す見回りの名前。 */
	name?: string;
}) => {
	let running = false;
	const tick = () => {
		if (running) return;
		running = true;
		void input
			.run()
			.catch((e: unknown) => {
				input.logger.error(`${input.name ?? "issue pickup"} crashed`, {
					error: String(e),
				});
			})
			.finally(() => {
				running = false;
			});
	};
	tick();
	const timer = setInterval(tick, input.intervalMs);
	timer.unref();
	return { stop: () => clearInterval(timer) };
};
