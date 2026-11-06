import { spawn } from "node:child_process";

export type ExecResult = {
	code: number | null;
	stdout: string;
	stderr: string;
};

export type Exec = (
	bin: string,
	args: readonly string[],
	opts: {
		stdin: string;
		cwd: string;
		timeoutMs: number;
		env: Record<string, string>;
	},
) => Promise<ExecResult>;

export const spawnExec: Exec = (bin, args, opts) =>
	new Promise((resolve) => {
		const child = spawn(bin, args, {
			cwd: opts.cwd,
			env: opts.env,
			stdio: ["pipe", "pipe", "pipe"],
			timeout: opts.timeoutMs,
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => {
			stdout += d;
		});
		child.stderr.on("data", (d) => {
			stderr += d;
		});
		child.on("error", (e) =>
			resolve({ code: null, stdout, stderr: String(e) }),
		);
		child.on("close", (code) => resolve({ code, stdout, stderr }));
		// 標準入力を読まずに終わる子に書くと EPIPE になる。拾わないと受付ごと落ちる
		child.stdin.on("error", () => {});
		child.stdin.end(opts.stdin);
	});
