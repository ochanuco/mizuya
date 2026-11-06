import * as v from "valibot";
import {
	editInteractionOriginal,
	MessageSchema,
	sendEphemeralFollowup,
} from "./discord.ts";
import { type Bindings, inboxOf, type WaitUntil } from "./env.ts";
import { listPendingDeployments, reviewPendingDeployments } from "./github.ts";
import {
	type Decision,
	decisionOf,
	type Outcome,
	type ReviewTarget,
	settledMessage,
	targetOf,
} from "./review.ts";
import { verifyDiscordSignature } from "./signature.ts";
import { parseJson } from "./webhook.ts";

const InteractionType = { PING: 1, MESSAGE_COMPONENT: 3 } as const;
const ResponseType = {
	PONG: 1,
	CHANNEL_MESSAGE: 4,
	DEFERRED_UPDATE_MESSAGE: 6,
} as const;
const EPHEMERAL = 1 << 6;

const UserSchema = v.object({
	id: v.string(),
	username: v.optional(v.string()),
	global_name: v.nullish(v.string()),
	bot: v.optional(v.boolean()),
});

/** Working が出したボタンの custom_id の頭。これで始まるボタンは Working の受け箱に回す */
export const WORKING_BUTTON_PREFIX = "working:";

const InteractionSchema = v.object({
	type: v.number(),
	application_id: v.string(),
	token: v.string(),
	guild_id: v.optional(v.string()),
	channel_id: v.optional(v.string()),
	member: v.nullish(
		v.object({ user: UserSchema, nick: v.nullish(v.string()) }),
	),
	user: v.nullish(UserSchema),
	data: v.nullish(v.object({ custom_id: v.optional(v.string()) })),
	message: v.nullish(MessageSchema),
});

type Interaction = v.InferOutput<typeof InteractionSchema>;

function json(body: unknown): Response {
	return Response.json(body);
}

function ephemeral(content: string): Response {
	return json({
		type: ResponseType.CHANNEL_MESSAGE,
		data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] } },
	});
}

export async function handleDiscordInteraction(
	request: Request,
	env: Bindings,
	waitUntil: WaitUntil,
): Promise<Response> {
	const body = await request.text();
	const valid = await verifyDiscordSignature(
		env.DISCORD_PUBLIC_KEY,
		body,
		request.headers.get("x-signature-ed25519"),
		request.headers.get("x-signature-timestamp"),
	);
	if (!valid) return new Response("invalid request signature", { status: 401 });

	const parsed = v.safeParse(InteractionSchema, parseJson(body));
	if (!parsed.success)
		return new Response("unexpected payload", { status: 400 });
	const interaction = parsed.output;

	if (interaction.type === InteractionType.PING) {
		return json({ type: ResponseType.PONG });
	}
	if (interaction.type !== InteractionType.MESSAGE_COMPONENT) {
		return ephemeral("mizuya はこの操作に対応していません。");
	}

	const customId = interaction.data?.custom_id;
	if (customId?.startsWith(WORKING_BUTTON_PREFIX)) {
		return forwardToWorking(interaction, customId, env, waitUntil);
	}

	const decision = interaction.data?.custom_id
		? decisionOf(interaction.data.custom_id)
		: null;
	const target = interaction.message ? targetOf(interaction.message) : null;
	if (!decision || !target || !interaction.message) {
		return ephemeral("mizuya のボタンではありません。");
	}

	const userId = interaction.member?.user.id ?? interaction.user?.id;
	if (userId !== env.DISCORD_APPROVER_USER_ID) {
		return ephemeral("このボタンは承認者だけが押せます。");
	}

	// Discord は 3 秒で応答を求めるので、先に deferred update を返し、GitHub への反映は後で行う
	waitUntil(
		review(interaction, interaction.message, decision, target, userId, env),
	);
	return json({ type: ResponseType.DEFERRED_UPDATE_MESSAGE });
}

type Pending = { type: "not_pending" };

async function review(
	interaction: Interaction,
	message: NonNullable<Interaction["message"]>,
	decision: Decision,
	target: ReviewTarget,
	userId: string,
	env: Bindings,
): Promise<void> {
	// 例外でも結果を書き込み、何も起きなかったように見せない
	const outcome = await decide(decision, target, userId, env).catch(
		(error: unknown): Outcome => ({
			type: "failed",
			decision,
			message: error instanceof Error ? error.message : String(error),
		}),
	);

	// 承認待ちが無いのは、先に押した操作か GitHub の画面で決着した後。その決着の書き込みを上書きしないよう、押した人にだけ伝える
	if (outcome.type === "not_pending") {
		const res = await sendEphemeralFollowup(
			interaction.application_id,
			interaction.token,
			"承認待ちが見つかりません（すでに決着したか、run が終わっています）。",
		);
		if (!res.ok) console.error("discord: 返事の送信に失敗", res.error);
		return;
	}

	const res = await editInteractionOriginal(
		interaction.application_id,
		interaction.token,
		settledMessage(message, outcome),
	);
	if (!res.ok) console.error("discord: 結果の反映に失敗", res.error);
}

async function decide(
	decision: Decision,
	target: ReviewTarget,
	userId: string,
	env: Bindings,
): Promise<Outcome | Pending> {
	const fail = (message: string): Outcome => ({
		type: "failed",
		decision,
		message,
	});

	const pending = await listPendingDeployments(
		env.GITHUB_APPROVER_TOKEN,
		target.repo,
		target.runId,
	);
	if (!pending.ok) {
		return fail(`GitHub ${pending.error.status}: ${pending.error.message}`);
	}
	const matching = pending.value.filter(
		(d) => d.environment.name === target.environment,
	);
	if (matching.length === 0) return { type: "not_pending" };
	const environmentIds = matching
		.filter((d) => d.current_user_can_approve)
		.map((d) => d.environment.id);
	if (environmentIds.length === 0) {
		return fail(
			"GITHUB_APPROVER_TOKEN の持ち主はこの Environment を承認できない",
		);
	}

	const state = decision === "approve" ? "approved" : "rejected";
	const res = await reviewPendingDeployments(
		env.GITHUB_APPROVER_TOKEN,
		target.repo,
		target.runId,
		environmentIds,
		state,
		`mizuya: Discord から${decision === "approve" ? "承認" : "却下"}`,
	);
	if (!res.ok) return fail(`GitHub ${res.error.status}: ${res.error.message}`);
	return { type: state, by: `Discord で <@${userId}>` };
}

/**
 * Working のボタンは受け箱に置き、Working が受け取って処理する。押した人が持ち主かどうかは Working が決める。
 * 受け箱に置くのを待たずに応答し、Working が止まっていても Discord には失敗と見せない。
 */
function forwardToWorking(
	interaction: Interaction,
	customId: string,
	env: Bindings,
	waitUntil: WaitUntil,
): Response {
	const member = interaction.member;
	const user = member?.user ?? interaction.user;
	if (
		!user ||
		!interaction.guild_id ||
		!interaction.channel_id ||
		!interaction.message
	) {
		return ephemeral("サーバーのメッセージのボタンだけを受け付けます。");
	}
	const button = {
		guild_id: interaction.guild_id,
		channel_id: interaction.channel_id,
		message_id: interaction.message.id,
		custom_id: customId,
		user: {
			id: user.id,
			display_name:
				member?.nick ?? user.global_name ?? user.username ?? user.id,
			is_bot: user.bot ?? false,
		},
	};
	waitUntil(
		inboxOf(env)
			.put("button", button)
			.catch((error: unknown) => {
				console.error("inbox: ボタンを置けない", error);
			}),
	);
	return json({ type: ResponseType.DEFERRED_UPDATE_MESSAGE });
}
