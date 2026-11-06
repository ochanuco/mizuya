import type { Embed, Message, MessageBody } from "./discord.ts";

export type Decision = "approve" | "reject";

/** ボタンの custom_id が指す承認待ち。environment が null なら、その run で承認できる Environment すべてを指す */
export type ReviewTarget = {
	repo: string;
	runId: number;
	environment: string | null;
};

const PREFIX = "mizuya";
const ALL_ENVIRONMENTS = "*";
// Discord の custom_id の上限
const CUSTOM_ID_MAX = 100;

const COLOR_PENDING = 0xf1c40f;
const COLOR_APPROVED = 0x2ecc71;
const COLOR_REJECTED = 0xe74c3c;
const COLOR_FAILED = 0x95a5a6;

// Environment 名は区切りの ":" を含みうるので末尾に置き、repo 名（":" を含まない）を先に置く
export function encodeCustomId(
	decision: Decision,
	target: ReviewTarget,
): string {
	const head = `${PREFIX}:${decision}:${target.repo}:${target.runId}:`;
	const full = head + (target.environment ?? ALL_ENVIRONMENTS);
	return full.length <= CUSTOM_ID_MAX ? full : head + ALL_ENVIRONMENTS;
}

export function decodeCustomId(
	customId: string,
): { decision: Decision; target: ReviewTarget } | null {
	const parts = customId.split(":");
	if (parts.length < 5 || parts[0] !== PREFIX) return null;
	const [, decision, repo, runIdText] = parts;
	if (decision !== "approve" && decision !== "reject") return null;
	if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return null;
	if (!runIdText || !/^\d+$/.test(runIdText)) return null;
	const environment = parts.slice(4).join(":");
	return {
		decision,
		target: {
			repo,
			runId: Number(runIdText),
			environment:
				environment === ALL_ENVIRONMENTS || environment === ""
					? null
					: environment,
		},
	};
}

export type ReviewRequest = {
	repo: string;
	repoUrl: string;
	runId: number;
	runUrl: string;
	workflow: string;
	ref: string | null;
	sha: string;
	environment: string;
	requestor: string | null;
};

export function requestedMessage(req: ReviewRequest): MessageBody {
	const target = {
		repo: req.repo,
		runId: req.runId,
		environment: req.environment,
	};
	const shortSha = req.sha.slice(0, 7);
	const fields = [
		{ name: "workflow", value: req.workflow, inline: true },
		{ name: "Environment", value: req.environment, inline: true },
		{
			name: "ref",
			value: `${req.ref ?? "(なし)"} @ [${shortSha}](${req.repoUrl}/commit/${req.sha})`,
			inline: false,
		},
	];
	if (req.requestor) {
		fields.push({ name: "起動した人", value: req.requestor, inline: true });
	}
	return {
		embeds: [
			{
				title: `承認待ち: ${req.repo}`,
				url: req.runUrl,
				color: COLOR_PENDING,
				fields,
			},
		],
		components: [
			{
				type: 1,
				components: [
					{
						type: 2,
						style: 3,
						label: "承認",
						custom_id: encodeCustomId("approve", target),
					},
					{
						type: 2,
						style: 4,
						label: "却下",
						custom_id: encodeCustomId("reject", target),
					},
				],
			},
		],
		allowed_mentions: { parse: [] },
	};
}

export type Outcome =
	| { type: "approved" | "rejected"; by: string }
	| { type: "failed"; decision: Decision; message: string };

function outcomeField(outcome: Outcome): { color: number; text: string } {
	switch (outcome.type) {
		case "approved":
			return { color: COLOR_APPROVED, text: `承認（${outcome.by}）` };
		case "rejected":
			return { color: COLOR_REJECTED, text: `却下（${outcome.by}）` };
		case "failed": {
			const verb = outcome.decision === "approve" ? "承認" : "却下";
			return {
				color: COLOR_FAILED,
				text: `${verb}に失敗: ${outcome.message}`.slice(0, 1024),
			};
		}
	}
}

/** 元のメッセージの embed を残したまま、結果を足してボタンを消す */
export function settledMessage(
	original: Pick<Message, "embeds">,
	outcome: Outcome,
): MessageBody {
	const { color, text } = outcomeField(outcome);
	const [first, ...rest] = original.embeds;
	const base: Embed = first ?? { title: "承認待ち" };
	const title = base.title?.replace(/^承認待ち: /, "") ?? "";
	const fields = (base.fields ?? []).filter((f) => f.name !== "結果");
	return {
		embeds: [
			{
				...base,
				title: title ? `決着: ${title}` : "決着",
				color,
				fields: [...fields, { name: "結果", value: text, inline: false }],
			},
			...rest,
		],
		components: [],
		allowed_mentions: { parse: [] },
	};
}

/** メッセージのボタンが指す承認待ちを返す。決着済み（ボタンなし）や mizuya 以外のメッセージは空 */
export function targetsOf(
	message: Pick<Message, "components">,
): ReviewTarget[] {
	const targets: ReviewTarget[] = [];
	for (const row of message.components) {
		for (const component of row.components ?? []) {
			const decoded = component.custom_id
				? decodeCustomId(component.custom_id)
				: null;
			if (decoded?.decision === "approve") targets.push(decoded.target);
		}
	}
	return targets;
}
