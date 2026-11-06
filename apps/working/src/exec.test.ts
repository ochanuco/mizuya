import { describe, expect, it } from "vitest";
import { spawnExec } from "./exec.ts";

describe("spawnExec", () => {
	it("標準入力を読まずに終わる子に大きな入力を渡しても、落ちずに結果を返す", async () => {
		const r = await spawnExec(process.execPath, ["-e", "process.exit(3)"], {
			stdin: "x".repeat(1_000_000),
			cwd: process.cwd(),
			timeoutMs: 10_000,
			env: { PATH: process.env.PATH ?? "" },
		});
		expect(r.code).toBe(3);
	});

	it("作業ディレクトリが無ければ code null で返す", async () => {
		const r = await spawnExec("true", [], {
			stdin: "",
			cwd: "/nonexistent/yunomi",
			timeoutMs: 10_000,
			env: { PATH: process.env.PATH ?? "" },
		});
		expect(r.code).toBeNull();
	});
});
