import * as v from "valibot";
import { checkServiceToken } from "./access.ts";
import { type Bindings, inboxOf } from "./env.ts";

/**
 * yunomi の Talking が会話で頼まれた仕事を Working に渡す口。受け箱に kind `work` で置き、
 * Working が仕事フォーラムに投稿を立てて席を開く。席の経過は Working が yunomi の出来事の口に送る。
 */

const singleLine = (max: number) =>
	v.pipe(
		v.string(),
		v.check((s) => !/[\r\n]/.test(s), "改行を含む"),
		v.trim(),
		v.minLength(1),
		v.maxLength(max),
	);

// 投稿と席の prompt にそのまま入るので、Discord のメッセージへのリンクだけを通す
const DISCORD_LINK =
	/^https:\/\/(?:ptb\.|canary\.)?discord\.com\/channels\/\d+\/\d+(?:\/\d+)?$/;

const workRequestSchema = v.object({
	request_id: v.pipe(v.string(), v.uuid()),
	partner: v.picklist(["yukarin", "akarin"]),
	title: singleLine(100),
	request: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(2000)),
	requested_by: v.pipe(v.string(), v.regex(/^\d+$/)),
	context_url: v.optional(
		v.nullable(v.pipe(v.string(), v.regex(DISCORD_LINK))),
		null,
	),
});

/** 受け箱に置く形。Working の `inbox.ts` が読む形と揃える。 */
export type WorkRequest = v.InferOutput<typeof workRequestSchema>;

const failure = (status: number, error: string, message?: string) =>
	Response.json(message ? { error, message } : { error }, { status });

export async function handleWorkRequest(
	request: Request,
	env: Bindings,
): Promise<Response> {
	const denied = await checkServiceToken(request, {
		teamDomain: env.ACCESS_TEAM_DOMAIN,
		aud: env.WORKING_REQUESTS_ACCESS_AUD,
		clientId: env.WORKING_REQUESTS_CLIENT_ID,
	});
	if (denied) return failure(denied.status, denied.error);
	if (request.method !== "POST") {
		return failure(405, "method_not_allowed");
	}
	let json: unknown;
	try {
		json = await request.json();
	} catch {
		return failure(400, "invalid_json");
	}
	const parsed = v.safeParse(workRequestSchema, json);
	if (!parsed.success) {
		return failure(
			400,
			"validation_failed",
			parsed.issues
				.map((i) => `${v.getDotPath(i) ?? "(body)"}: ${i.message}`)
				.join("; "),
		);
	}
	const body: WorkRequest = parsed.output;
	const id = await inboxOf(env).putWork(body.request_id, body);
	return Response.json({ id }, { status: 202 });
}
