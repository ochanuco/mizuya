import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readTypicalSleep } from "./persona-profile.ts";

const write = async (body: string) => {
	const dir = await mkdtemp(join(tmpdir(), "persona-"));
	const path = join(dir, "profile.yaml");
	await writeFile(path, body);
	return path;
};

describe("readTypicalSleep", () => {
	it("living_rhythm.typical_sleep を返す", async () => {
		const path = await write(
			'name: x\nliving_rhythm:\n  typical_sleep: "26:00-08:00"\n',
		);
		expect(await readTypicalSleep(path)).toEqual({
			ok: true,
			value: "26:00-08:00",
		});
	});

	it("項目がなければ失敗を返す", async () => {
		const path = await write("name: x\n");
		const r = await readTypicalSleep(path);
		expect(r.ok).toBe(false);
	});

	it("ファイルがなければ失敗を返す", async () => {
		const r = await readTypicalSleep("/nonexistent/profile.yaml");
		expect(r.ok).toBe(false);
	});
});
