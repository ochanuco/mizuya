import * as v from "valibot";
import type { Exec } from "./exec.ts";
import { err, ok, type Result } from "./lib/core.ts";
import { acceptTitle, SUMMARY_SYSTEM_PROMPT, summaryInput } from "./prompts.ts";

/**
 * 受付が自分で動かす CLI（件名の要約、記憶、gh、ログインの期限）に渡す環境変数。
 * 受付の秘密（Discord のトークン、gateway と共有するトークン）と記憶の口の service token は渡さない。
 */
const CHILD_ENV_KEYS = [
	"HOME",
	"PATH",
	"LANG",
	"LC_ALL",
	"TZ",
	"USER",
	"CLAUDE_CONFIG_DIR",
	"GH_TOKEN",
] as const;

export const childEnv = (
	env: Record<string, string | undefined>,
	stateDir: string,
): Record<string, string> => {
	const out: Record<string, string> = {};
	for (const key of CHILD_ENV_KEYS) {
		const val = env[key];
		if (val !== undefined) out[key] = val;
	}
	// yunomi-memory は接続情報をここから読む
	out.YUNOMI_STATE_DIR = stateDir;
	return out;
};

export type SummaryError = { type: "SummaryFailed"; reason: string };

/** フォーラム投稿の件名にする短い要約。セッションを残さない。 */
export type Summarizer = (
	text: string,
) => Promise<Result<string, SummaryError>>;

const resultSchema = v.object({
	is_error: v.optional(v.boolean()),
	result: v.optional(v.string()),
});

export const createSummarizer =
	(opts: {
		bin: string;
		cwd: string;
		env: Record<string, string>;
		exec: Exec;
	}): Summarizer =>
	async (text) => {
		const out = await opts.exec(
			opts.bin,
			[
				"-p",
				"--output-format",
				"json",
				"--model",
				"haiku",
				"--no-session-persistence",
				"--tools",
				"",
				"--system-prompt",
				SUMMARY_SYSTEM_PROMPT,
			],
			{
				stdin: summaryInput(text),
				cwd: opts.cwd,
				timeoutMs: 60_000,
				env: opts.env,
			},
		);
		let json: unknown = null;
		try {
			json = JSON.parse(out.stdout);
		} catch {
			json = null;
		}
		const parsed = v.safeParse(resultSchema, json);
		if (out.code !== 0 || !parsed.success || parsed.output.is_error) {
			return err({
				type: "SummaryFailed",
				reason: out.stderr.slice(0, 300) || `exit ${out.code}`,
			});
		}
		const title = acceptTitle(parsed.output.result ?? "");
		return title === null
			? err({ type: "SummaryFailed", reason: "summary rejected" })
			: ok(title);
	};
