import * as v from "valibot";
import { editInteractionOriginal, MessageSchema } from "./discord.ts";
import type { Bindings, WaitUntil } from "./env.ts";
import { listPendingDeployments, reviewPendingDeployments } from "./github.ts";
import { decodeCustomId, type Outcome, settledMessage } from "./review.ts";
import { verifyDiscordSignature } from "./signature.ts";

const InteractionType = { PING: 1, MESSAGE_COMPONENT: 3 } as const;
const ResponseType = {
	PONG: 1,
	CHANNEL_MESSAGE: 4,
	DEFERRED_UPDATE_MESSAGE: 6,
} as const;
const EPHEMERAL = 1 << 6;

const UserSchema = v.object({ id: v.string() });

const InteractionSchema = v.object({
	type: v.number(),
	application_id: v.string(),
	token: v.string(),
	member: v.nullish(v.object({ user: UserSchema })),
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

	const parsed = v.safeParse(InteractionSchema, JSON.parse(body));
	if (!parsed.success)
		return new Response("unexpected payload", { status: 400 });
	const interaction = parsed.output;

	if (interaction.type === InteractionType.PING) {
		return json({ type: ResponseType.PONG });
	}
	if (interaction.type !== InteractionType.MESSAGE_COMPONENT) {
		return ephemeral("mizuya はこの操作に対応していません。");
	}

	const decoded = interaction.data?.custom_id
		? decodeCustomId(interaction.data.custom_id)
		: null;
	if (!decoded || !interaction.message) {
		return ephemeral("mizuya のボタンではありません。");
	}

	const userId = interaction.member?.user.id ?? interaction.user?.id;
	if (userId !== env.DISCORD_APPROVER_USER_ID) {
		return ephemeral("このボタンは承認者だけが押せます。");
	}

	// Discord は 3 秒で応答を求めるので、先に deferred update を返し、GitHub への反映は後で行う
	waitUntil(review(interaction, decoded, userId, env));
	return json({ type: ResponseType.DEFERRED_UPDATE_MESSAGE });
}

async function review(
	interaction: Interaction,
	{ decision, target }: NonNullable<ReturnType<typeof decodeCustomId>>,
	userId: string,
	env: Bindings,
): Promise<void> {
	// 例外でも決着を書き込み、ボタンを押せるまま放置しない
	const outcome = await decide(decision, target, userId, env).catch(
		(error: unknown): Outcome => ({
			type: "failed",
			decision,
			message: error instanceof Error ? error.message : String(error),
		}),
	);
	const message = interaction.message ?? { embeds: [] };
	const res = await editInteractionOriginal(
		interaction.application_id,
		interaction.token,
		settledMessage(message, outcome),
	);
	if (!res.ok) console.error("discord: 結果の反映に失敗", res.error);
}

async function decide(
	decision: "approve" | "reject",
	target: { repo: string; runId: number; environment: string | null },
	userId: string,
	env: Bindings,
): Promise<Outcome> {
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
	const environmentIds = pending.value
		.filter(
			(d) =>
				d.current_user_can_approve &&
				(target.environment === null ||
					d.environment.name === target.environment),
		)
		.map((d) => d.environment.id);
	if (environmentIds.length === 0) {
		return fail(
			"承認待ちが見つからない（GitHub で処理済みか、run が終わっている）",
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
