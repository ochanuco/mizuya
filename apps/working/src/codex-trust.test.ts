import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { trustCodexProject } from "./codex-trust.ts";
import { tempDir } from "./test-support.ts";

describe("trustCodexProject", () => {
	it("設定が無ければ作り、席の元のリポジトリを信頼済みにする", async () => {
		const path = join(tempDir(), ".codex", "config.toml");
		expect(await trustCodexProject(path, "/home/w/work/seats")).toBe(true);
		expect(readFileSync(path, "utf8")).toBe(
			'[projects."/home/w/work/seats"]\ntrust_level = "trusted"\n',
		);
	});

	it("持ち主の設定を残して末尾に足し、2 度目は書かない", async () => {
		const path = join(tempDir(), "config.toml");
		writeFileSync(path, 'model = "x"');
		await trustCodexProject(path, "/seats");
		expect(await trustCodexProject(path, "/seats")).toBe(false);
		expect(readFileSync(path, "utf8")).toBe(
			'model = "x"\n\n[projects."/seats"]\ntrust_level = "trusted"\n',
		);
	});
});
