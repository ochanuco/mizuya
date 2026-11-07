import * as v from "valibot";
import {
	type AiChoice,
	aiChoiceOf,
	type CommandOption,
	choiceOfModalId,
	REQUEST_FIELD,
	requestModal,
} from "./commands.ts";
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

const InteractionType = {
	PING: 1,
	APPLICATION_COMMAND: 2,
	MESSAGE_COMPONENT: 3,
	MODAL_SUBMIT: 5,
} as const;
const ResponseType = {
	PONG: 1,
	CHANNEL_MESSAGE: 4,
	DEFERRED_CHANNEL_MESSAGE: 5,
	DEFERRED_UPDATE_MESSAGE: 6,
	MODAL: 9,
} as const;
/** 公開・非公開のスレッド。仕事フォーラムの投稿はスレッドとして届く。 */
const THREAD_TYPES = new Set([11, 12]);
const EPHEMERAL = 1 << 6;

const UserSchema = v.object({
	id: v.string(),
	username: v.optional(v.string()),
	global_name: v.nullish(v.string()),
	bot: v.optional(v.boolean()),
});

/** Working が出したボタンの custom_id の頭。これで始まるボタンは Working の受け箱に回す */
export const WORKING_BUTTON_PREFIX = "working:";

const CommandOptionSchema: v.GenericSchema<CommandOption> = v.object({
	name: v.string(),
	type: v.number(),
	options: v.optional(v.array(v.lazy(() => CommandOptionSchema))),
});

const ModalRowSchema = v.object({
	components: v.optional(
		v.array(
			v.object({
				custom_id: v.optional(v.string()),
				value: v.optional(v.string()),
			}),
		),
		[],
	),
});

const InteractionSchema = v.object({
	type: v.number(),
	application_id: v.string(),
	token: v.string(),
	guild_id: v.optional(v.string()),
	channel_id: v.optional(v.string()),
	channel: v.nullish(v.object({ id: v.string(), type: v.number() })),
	member: v.nullish(
		v.object({ user: UserSchema, nick: v.nullish(v.string()) }),
	),
	user: v.nullish(UserSchema),
	data: v.nullish(
		v.object({
			custom_id: v.optional(v.string()),
			name: v.optional(v.string()),
			options: v.optional(v.array(CommandOptionSchema)),
			components: v.optional(v.array(ModalRowSchema)),
		}),
	),
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
	if (interaction.type === InteractionType.APPLICATION_COMMAND) {
		return handleAiCommand(interaction, env, waitUntil);
	}
	if (interaction.type === InteractionType.MODAL_SUBMIT) {
		return handleRequestModal(interaction, env, waitUntil);
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

/** 受け箱に渡す、操作した人。表示名はサーバーでのニックネームを先に使う。 */
function actorOf(interaction: Interaction) {
	const member = interaction.member;
	const user = member?.user ?? interaction.user;
	if (!user) return null;
	return {
		id: user.id,
		display_name: member?.nick ?? user.global_name ?? user.username ?? user.id,
		is_bot: user.bot ?? false,
	};
}

type CommandItem = {
	type: "request" | "model";
	choice: AiChoice;
	content?: string;
};

/**
 * `/ai` の依頼とモデルの切り替えを受け箱に置く。Working は interaction の token で本人にだけ見える返事を書き換える。
 * 置くのを待たずに応答し、Working が止まっていても Discord には失敗と見せない。
 */
function putCommand(
	interaction: Interaction,
	item: CommandItem,
	env: Bindings,
	waitUntil: WaitUntil,
): boolean {
	const user = actorOf(interaction);
	if (!user || !interaction.guild_id || !interaction.channel_id) return false;
	const body = {
		type: item.type,
		application_id: interaction.application_id,
		token: interaction.token,
		guild_id: interaction.guild_id,
		channel_id: interaction.channel_id,
		user,
		agent: item.choice.agent,
		model: item.choice.model,
		...(item.content === undefined ? {} : { content: item.content }),
	};
	waitUntil(
		inboxOf(env)
			.put("command", body)
			.catch((error: unknown) => {
				console.error("inbox: コマンドを置けない", error);
			}),
	);
	return true;
}

/**
 * スレッドの中で打たれたら、その投稿の席のモデルを変える。仕事フォーラムの投稿かどうかは Working が親を引いて決める。
 * スレッドの外なら、依頼を書く modal を返す。
 */
function handleAiCommand(
	interaction: Interaction,
	env: Bindings,
	waitUntil: WaitUntil,
): Response {
	const choice = interaction.data ? aiChoiceOf(interaction.data) : null;
	if (!choice) return ephemeral("mizuya はこのコマンドに対応していません。");
	if (!interaction.guild_id) {
		return ephemeral("サーバーの中で使ってください。");
	}
	if (!THREAD_TYPES.has(interaction.channel?.type ?? -1)) {
		return json({ type: ResponseType.MODAL, data: requestModal(choice) });
	}
	if (!putCommand(interaction, { type: "model", choice }, env, waitUntil)) {
		return ephemeral("サーバーの中で使ってください。");
	}
	return json({
		type: ResponseType.DEFERRED_CHANNEL_MESSAGE,
		data: { flags: EPHEMERAL },
	});
}

function handleRequestModal(
	interaction: Interaction,
	env: Bindings,
	waitUntil: WaitUntil,
): Response {
	const choice = choiceOfModalId(interaction.data?.custom_id ?? "");
	if (!choice) return ephemeral("mizuya の依頼の欄ではありません。");
	const content = (interaction.data?.components ?? [])
		.flatMap((row) => row.components)
		.find((c) => c.custom_id === REQUEST_FIELD)?.value;
	if (!content?.trim()) return ephemeral("依頼が空でした。");
	if (
		!putCommand(
			interaction,
			{ type: "request", choice, content },
			env,
			waitUntil,
		)
	) {
		return ephemeral("サーバーの中で使ってください。");
	}
	return ephemeral("受け付けました。投稿を立てています…");
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
	const user = actorOf(interaction);
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
		user,
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
