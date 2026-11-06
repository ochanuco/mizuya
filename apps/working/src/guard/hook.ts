// Claude CLI の PreToolUse と PermissionDenied の hook。
// PreToolUse の例外で Claude CLI は hook の失敗を無視して進むので、どんな失敗も exit 2（止める）にする。
import { readFileSync } from "node:fs";
import { decide, type HookInput, recordDenied } from "./decide.ts";
import { guardRunFromEnv } from "./env.ts";
import { createLedger } from "./ledger.ts";

try {
	const input = JSON.parse(readFileSync(0, "utf8")) as HookInput;
	if (
		typeof input.tool_name !== "string" ||
		typeof input.tool_input !== "object"
	) {
		throw new Error("hook input is malformed");
	}
	const run = guardRunFromEnv(process.env, input.cwd);
	const ledger = createLedger(run.guardDir);
	if (input.hook_event_name === "PermissionDenied") {
		recordDenied(input, run, ledger);
		process.exit(0);
	}
	const d = decide(input, run, ledger);
	if (d !== null) {
		process.stdout.write(
			JSON.stringify({
				hookSpecificOutput: {
					hookEventName: "PreToolUse",
					permissionDecision: d.decision,
					permissionDecisionReason: d.reason,
				},
			}),
		);
	}
	process.exit(0);
} catch (e) {
	process.stderr.write(`guard failed: ${String(e)}\n`);
	process.exit(2);
}
