import { readFile } from "node:fs/promises";
import * as v from "valibot";
import { parse } from "yaml";
import { err, ok, type Result } from "./lib/core.ts";

const profileSchema = v.object({
	living_rhythm: v.object({ typical_sleep: v.string() }),
});

/**
 * image に入れた人格の profile.yaml から `living_rhythm.typical_sleep` を読む。
 * 人格の正本は yunomi の partners にあり、image の build で取り込む。
 */
export const readTypicalSleep = async (
	profilePath: string,
): Promise<Result<string, { reason: string }>> => {
	let text: string;
	try {
		text = await readFile(profilePath, "utf8");
	} catch (e) {
		return err({ reason: `${profilePath} を読めない: ${String(e)}` });
	}
	let doc: unknown;
	try {
		doc = parse(text);
	} catch (e) {
		return err({ reason: `${profilePath} が YAML でない: ${String(e)}` });
	}
	const parsed = v.safeParse(profileSchema, doc);
	if (!parsed.success) {
		return err({
			reason: `${profilePath} に living_rhythm.typical_sleep がない`,
		});
	}
	return ok(parsed.output.living_rhythm.typical_sleep);
};
