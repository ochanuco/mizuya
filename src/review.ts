import type { Embed, Message, MessageBody } from "./discord.ts";

export type Decision = "approve" | "reject";

/** 承認待ちを指す。1 通のメッセージは 1 つの run の 1 つの Environment を受け持つ */
export type ReviewTarget = {
	repo: string;
	runId: number;
	environment: string;
};

// custom_id は 100 文字までで、長い repo 名や Environment 名を入れると溢れる。
// 対象は mizuya 自身が書いた embed（run の URL と Environment の欄）から読み、custom_id は決定だけを持つ
const CUSTOM_ID = {
	approve: "mizuya:approve",
	reject: "mizuya:reject",
} as const;
const ENVIRONMENT_FIELD = "Environment";
const JOB_FIELD = "job";
const RESULT_FIELD = "結果";
const ERROR_FIELD = "直近のエラー";
const PENDING_TITLE = "承認待ち: ";

const COLOR_PENDING = 0xf1c40f;
const COLOR_APPROVED = 0x2ecc71;
const COLOR_REJECTED = 0xe74c3c;
const COLOR_CANCELLED = 0x95a5a6;

export function decisionOf(customId: string): Decision | null {
	if (customId === CUSTOM_ID.approve) return "approve";
	if (customId === CUSTOM_ID.reject) return "reject";
	return null;
}

const RUN_URL = /\/([\w.-]+\/[\w.-]+)\/actions\/runs\/(\d+)(?:[/?#]|$)/;

/** ボタンが残っている mizuya のメッセージから承認待ちを読む。決着済み（ボタンなし）や別のメッセージは null */
export function targetOf(
	message: Pick<Message, "embeds" | "components">,
): ReviewTarget | null {
	const hasButtons = message.components.some((row) =>
		(row.components ?? []).some((c) => c.custom_id === CUSTOM_ID.approve),
	);
	if (!hasButtons) return null;
	const embed = message.embeds[0];
	const match = embed?.url?.match(RUN_URL);
	const environment = embed?.fields?.find(
		(f) => f.name === ENVIRONMENT_FIELD,
	)?.value;
	if (!match?.[1] || !match[2] || !environment) return null;
	return { repo: match[1], runId: Number(match[2]), environment };
}

const JOB_URL = /\/actions\/runs\/\d+\/job\/(\d+)\)/;

/** 承認待ちを起こした job の ID。job の開始・終了の webhook とメッセージを結びつける */
export function jobIdOf(message: Pick<Message, "embeds">): number | null {
	const value = message.embeds[0]?.fields?.find(
		(f) => f.name === JOB_FIELD,
	)?.value;
	const match = value?.match(JOB_URL);
	return match?.[1] ? Number(match[1]) : null;
}

export function sameTarget(a: ReviewTarget, b: ReviewTarget): boolean {
	return (
		a.repo === b.repo && a.runId === b.runId && a.environment === b.environment
	);
}

export type ReviewRequest = {
	repo: string;
	repoUrl: string;
	runId: number;
	runUrl: string;
	workflow: string;
	ref: string | null;
	approverUserId: string;
	sha: string;
	environment: string;
	job: { name: string; url: string };
};

export function requestedMessage(req: ReviewRequest): MessageBody {
	const shortSha = req.sha.slice(0, 7);
	const fields = [
		{ name: "workflow", value: req.workflow, inline: true },
		{ name: ENVIRONMENT_FIELD, value: req.environment, inline: true },
		{
			name: JOB_FIELD,
			value: `[${req.job.name.replace(/[[\]]/g, "")}](${req.job.url})`,
			inline: true,
		},
		{
			// workflow_job の head_branch と head_sha は run を起動したコミットで、
			// workflow_dispatch で別の ref を出すときはデプロイする ref と違う。デプロイする ref は workflow 名（run 名）に出る
			name: "起動元のコミット",
			value: `${req.ref ?? "(なし)"} @ [${shortSha}](${req.repoUrl}/commit/${req.sha})`,
			inline: false,
		},
	];
	return {
		content: `<@${req.approverUserId}> 承認待ちがあります`,
		embeds: [
			{
				title: `${PENDING_TITLE}${req.repo}`,
				url: req.runUrl,
				color: COLOR_PENDING,
				fields,
			},
		],
		components: [
			{
				type: 1,
				components: [
					{ type: 2, style: 3, label: "承認", custom_id: CUSTOM_ID.approve },
					{ type: 2, style: 4, label: "却下", custom_id: CUSTOM_ID.reject },
				],
			},
		],
		allowed_mentions: { parse: [], users: [req.approverUserId] },
	};
}

export type Outcome =
	| { type: "approved" | "rejected" | "cancelled"; by: string }
	| { type: "failed"; decision: Decision; message: string };

function withField(embed: Embed, name: string, value: string): Embed {
	const fields = (embed.fields ?? []).filter(
		(f) => f.name !== RESULT_FIELD && f.name !== ERROR_FIELD,
	);
	return {
		...embed,
		fields: [...fields, { name, value: value.slice(0, 1024), inline: false }],
	};
}

/**
 * 結果をメッセージに書く。決着したらボタンを消す。
 * 失敗はボタンを残し、押し直すか GitHub の画面で決着できるようにする
 */
export function settledMessage(
	original: Pick<Message, "embeds" | "components"> &
		Partial<Pick<Message, "content">>,
	outcome: Outcome,
): MessageBody {
	const [first, ...rest] = original.embeds;
	const base: Embed = first ?? {};
	if (outcome.type === "failed") {
		const verb = outcome.decision === "approve" ? "承認" : "却下";
		return {
			embeds: [
				withField(base, ERROR_FIELD, `${verb}に失敗: ${outcome.message}`),
				...rest,
			],
			components: original.components,
			allowed_mentions: { parse: [] },
		};
	}
	const name = base.title?.replace(PENDING_TITLE, "") ?? "";
	const settled = {
		approved: { label: "承認", text: "承認しました", color: COLOR_APPROVED },
		rejected: { label: "却下", text: "却下しました", color: COLOR_REJECTED },
		cancelled: {
			label: "取り消し",
			text: "取り消されました",
			color: COLOR_CANCELLED,
		},
	}[outcome.type];
	// 投稿時のメンションは残す。allowed_mentions が空なので、書き換えても再び通知しない
	const mention = original.content?.match(/^<@\d+>/)?.[0];
	return {
		content: mention ? `${mention} ${settled.text}` : settled.text,
		embeds: [
			{
				...withField(base, RESULT_FIELD, `${settled.label}（${outcome.by}）`),
				title: `${settled.label}: ${name}`,
				color: settled.color,
			},
			...rest,
		],
		components: [],
		allowed_mentions: { parse: [] },
	};
}
