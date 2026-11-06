// 正本は yunomi の packages/protocol/src/github.ts。段階 3 で GitHub の出来事の受け口が mizuya に入れば消す。
import * as v from "valibot";

/** Working が Worker から GitHub の出来事を取り出す口。取り出した分は Worker から消える。 */
export const GITHUB_EVENTS_PATH = "/v1/working/github-events";

const text = v.string();
const repo = v.pipe(v.string(), v.nonEmpty());
const number = v.pipe(v.number(), v.integer(), v.minValue(1));

/**
 * Worker が webhook の payload から抜き出した、席の材料になる分だけの形。
 * payload は大きく、席に要らない値も多いので、Worker で絞ってから D1 に置く。
 */
export const githubWorkEventSchema = v.variant("kind", [
	v.object({
		kind: v.literal("ci_failed"),
		repo,
		/** 落ちた run が属する PR。main など PR の無い branch なら空。 */
		prs: v.array(number),
		name: text,
		branch: v.nullable(text),
		conclusion: text,
		url: text,
		actor: v.nullable(text),
	}),
	v.object({
		kind: v.literal("review"),
		repo,
		pr: number,
		title: text,
		state: text,
		body: text,
		url: text,
		actor: text,
		actor_is_bot: v.boolean(),
	}),
	v.object({
		kind: v.literal("comment"),
		repo,
		number,
		is_pr: v.boolean(),
		title: text,
		body: text,
		url: text,
		actor: text,
		actor_is_bot: v.boolean(),
	}),
]);

export type GithubWorkEvent = v.InferOutput<typeof githubWorkEventSchema>;

export const githubEventsResponseSchema = v.object({
	events: v.array(
		v.object({
			id: v.pipe(v.string(), v.nonEmpty()),
			received_at: v.string(),
			event: githubWorkEventSchema,
		}),
	),
});

export type GithubEventsResponse = v.InferOutput<
	typeof githubEventsResponseSchema
>;
