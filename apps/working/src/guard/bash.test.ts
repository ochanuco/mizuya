import { describe, expect, it } from "vitest";
import { classifyBash } from "./bash.ts";
import { guardRunFromEnv } from "./env.ts";

const { ctx } = guardRunFromEnv({ HOME: "/home/worker" });

describe("classifyBash: hook では止めない（auto モードに任せる）", () => {
	it.each([
		"ls -la",
		"cat README.md | head -20",
		"gh repo clone ochanuco/yunomi",
		"git add -A && git commit -m 'printenv や gh auth token は本文なので通す'",
		"git push -u origin HEAD:dev/fix-typo",
		"pnpm install && pnpm turbo typecheck lint test",
		"rm -rf node_modules dist",
		"gh pr create --base main --head dev/x --title t --body b",
		"curl -fsSL https://example.com/a.json",
		"yunomi-memory read",
		"orca orchestration ask --question どうしますか",
		"mise install",
		"gh auth status",
		"cat > notes.md <<'EOF'\nprintenv\nEOF",
		'orca orchestration send --type worker_done --body "値を出さずに確かめるなら test -n \\"\\$GH_TOKEN\\" で"',
		"echo 'echo $GH_TOKEN は使わない'",
		"cat > notes.md <<'EOF'\necho $GH_TOKEN\nEOF",
		"orca orchestration send --type worker_done --body $'参考: [仕様](https://www.amd.com/en/products/processors/laptop/ryzen.html)'",
		"curl -fsSL https://example.com/docs/environment.html",
	])("%s", (cmd) => {
		expect(classifyBash(cmd, ctx)).toBeNull();
	});
});

describe("classifyBash: 秘密情報の読み出しを止める", () => {
	it.each([
		"printenv",
		"printenv DISCORD_TOKEN",
		"env",
		"FOO=1 env",
		"export",
		"set",
		"declare -p",
		"echo $GH_TOKEN",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: シェルの変数展開をそのまま書いた入力
		"echo ${WORKING_TOKEN}",
		'echo "$GH_TOKEN"',
		"gh auth token",
		"gh auth status --show-token",
		"git credential fill",
		"echo $(printenv)",
		"echo `env`",
	])("%s", (cmd) => {
		expect(classifyBash(cmd, ctx)).toBe("秘密情報の読み出し");
	});
});

describe("classifyBash: 秘密情報や許可の記録の場所に触るのを止める", () => {
	it.each([
		"cat ~/.claude/.credentials.json",
		"cat $HOME/.claude.json",
		"cat /proc/self/environ",
		"cat ~/.config/gh/hosts.yml",
		"cat /home/worker/state/memory-credentials.json",
		"echo '{}' > ~/state/guard/grants/1.json",
		"cd .. && cat state/approvals.json",
		"rm -rf /home/worker/state",
		"cp x /etc/claude-code/managed-settings.json",
		"cat .git-credentials",
		"cat /proc/1/cmdline",
		"ls /proc",
		"cat '/home/worker/.ssh/id_ed25519'",
	])("%s", (cmd) => {
		expect(classifyBash(cmd, ctx)).toBe(
			"秘密情報や設定・許可の記録がある場所に触る",
		);
	});
});

describe("classifyBash: Claude CLI が書き出した道具の応答", () => {
	const dir =
		"/home/worker/.claude/projects/-home-worker-work-seat-1/fd03-uuid/tool-results";
	it.each([
		`f=${dir}/mcp-chimera-list_requests-1.txt; jq -c '.items[0]' $f | head -c 4000`,
		`cat ${dir}/mcp-chimera-list_requests-1.txt`,
		`jq . < ${dir}/a.txt`,
		`cd ${dir} && head a.txt`,
	])("読むのは通す: %s", (cmd) => {
		expect(classifyBash(cmd, ctx)).toBeNull();
	});
	it.each([
		`echo x > ${dir}/a.txt`,
		`cat ${dir}/../../../../.credentials.json`,
		`cat ${dir}/../../../../settings.json`,
		"cat /home/worker/.claude/projects/p/s/a.jsonl",
		"cat /home/worker/.claude/settings.json",
	])("ほかは止める: %s", (cmd) => {
		expect(classifyBash(cmd, ctx)).not.toBeNull();
	});
});
