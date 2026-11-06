// 正本は yunomi の packages/protocol（discord.ts と core の envelope.ts）。段階 2 で Gateway の振り分けが mizuya に入れば消す。
import * as v from "valibot";

export type Envelope<TType extends string = string, TPayload = unknown> = {
	event_id: string;
	type: TType;
	source: string;
	partner_id: string;
	occurred_at: string;
	received_at: string;
	schema_version: number;
	payload: TPayload;
};

export const envelopeSchema = <const TPayload extends v.GenericSchema>(
	payloadSchema: TPayload,
) =>
	v.object({
		event_id: v.pipe(v.string(), v.uuid()),
		type: v.pipe(v.string(), v.nonEmpty()),
		source: v.pipe(v.string(), v.nonEmpty()),
		partner_id: v.pipe(v.string(), v.nonEmpty()),
		occurred_at: v.pipe(v.string(), v.isoTimestamp()),
		received_at: v.pipe(v.string(), v.isoTimestamp()),
		schema_version: v.pipe(v.number(), v.integer(), v.minValue(1)),
		payload: payloadSchema,
	});

export const DISCORD_MESSAGE_CREATED = "discord.message.created";
export const DISCORD_SOURCE = "discord";

const snowflake = v.pipe(v.string(), v.nonEmpty());

export const discordMessageCreatedPayloadSchema = v.object({
	guild_id: snowflake,
	channel_id: snowflake,
	message_id: snowflake,
	author: v.object({
		id: snowflake,
		display_name: v.pipe(v.string(), v.nonEmpty()),
		is_bot: v.boolean(),
	}),
	content: v.string(),
	mentions: v.array(snowflake),
	// 作者がいま入っている VC（Gateway から見えるもの）。入っていなければ null、古い Gateway は省略
	author_voice_channel_id: v.nullish(snowflake),
	reply_to_message_id: v.nullish(snowflake),
	attachments: v.array(
		v.object({
			name: v.string(),
			content_type: v.nullish(v.string()),
			size: v.pipe(v.number(), v.integer(), v.minValue(0)),
		}),
	),
});

export type DiscordMessageCreatedPayload = v.InferOutput<
	typeof discordMessageCreatedPayloadSchema
>;

/** Gateway → Working。仕事カテゴリに書かれたメッセージ。 */
export const discordMessageCreatedEnvelopeSchema = v.pipe(
	envelopeSchema(discordMessageCreatedPayloadSchema),
	v.check(
		(e) => e.type === DISCORD_MESSAGE_CREATED,
		`type は ${DISCORD_MESSAGE_CREATED} でなければならない`,
	),
	v.check(
		(e) => e.source === DISCORD_SOURCE,
		`source は ${DISCORD_SOURCE} でなければならない`,
	),
);

export type DiscordMessageCreatedEnvelope = Envelope<
	typeof DISCORD_MESSAGE_CREATED,
	DiscordMessageCreatedPayload
>;

export const DISCORD_BUTTON_PRESSED = "discord.button.pressed";

/** bot のメッセージに付けたボタンが押された。押されたボタンはメッセージを書いた bot の Gateway にだけ届く。 */
export const discordButtonPressedPayloadSchema = v.object({
	guild_id: snowflake,
	channel_id: snowflake,
	message_id: snowflake,
	custom_id: v.pipe(v.string(), v.nonEmpty()),
	user: v.object({
		id: snowflake,
		display_name: v.pipe(v.string(), v.nonEmpty()),
		is_bot: v.boolean(),
	}),
});

export type DiscordButtonPressedPayload = v.InferOutput<
	typeof discordButtonPressedPayloadSchema
>;

/** Gateway → Working。仕事カテゴリで押されたボタン。 */
export const discordButtonPressedEnvelopeSchema = v.pipe(
	envelopeSchema(discordButtonPressedPayloadSchema),
	v.check(
		(e) => e.type === DISCORD_BUTTON_PRESSED,
		`type は ${DISCORD_BUTTON_PRESSED} でなければならない`,
	),
	v.check(
		(e) => e.source === DISCORD_SOURCE,
		`source は ${DISCORD_SOURCE} でなければならない`,
	),
);

export type DiscordButtonPressedEnvelope = Envelope<
	typeof DISCORD_BUTTON_PRESSED,
	DiscordButtonPressedPayload
>;
