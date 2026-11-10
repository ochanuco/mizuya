#!/usr/bin/env bash
# pickup.sh を、gh・orca・git をモックに差し替えて確かめる。
set -euo pipefail
# Mac の接続情報を拾うと本物の Manager を指すので、テストの値だけを使う
unset HISHAKU_URL HISHAKU_ACCESS_CLIENT_ID HISHAKU_ACCESS_CLIENT_SECRET

here="$(cd "$(dirname "$0")" && pwd)"
pickup="$here/../pickup.sh"
failures=0
STATE=""

setup() {
	STATE="$(mktemp -d)"
	export STATE
	: >"$STATE/calls"
	cat >"$STATE/repos.json" <<'EOF'
{"ok":true,"result":{"repos":[
  {"id":"repo-a","path":"/src/alpha","gitRemoteIdentity":{"canonicalKey":"github.com/ochanuco/alpha"}}
]}}
EOF
	echo '{"ok":true,"result":{"worktrees":[]}}' >"$STATE/worktrees.json"
	echo '[]' >"$STATE/issues.json"
}

add_issue() {
	local repo="$1" number="$2" branch_line="$3" labels="${4:-[\"working-handoff\"]}"
	jq --arg repo "$repo" --argjson n "$number" --arg line "$branch_line" --argjson labels "$labels" '
		. += [{
			number: $n,
			url: "https://github.com/\($repo)/issues/\($n)",
			repository: {nameWithOwner: $repo},
			labels: ($labels | map({name: .})),
			body: "## 対象\n\n- 対象リポジトリ: `\($repo)`\n\($line)\n\n## 何をしたか\n\nなにか"
		}]' "$STATE/issues.json" >"$STATE/issues.json.tmp"
	mv "$STATE/issues.json.tmp" "$STATE/issues.json"
}

pickup() {
	PATH="$here/mock:$PATH" HISHAKU_URL="${HISHAKU_URL-https://hishaku.example.com}" \
		HISHAKU_ACCESS_CLIENT_ID=cid.example HISHAKU_ACCESS_CLIENT_SECRET=secret-example \
		"${PICKUP_BASH:-bash}" "$pickup" "$@" 2>"$STATE/log"
}

calls() { grep -c -F -- "$1" "$STATE/calls" || true; }

expect() {
	local name="$1" want="$2" got="$3"
	if [ "$want" != "$got" ]; then
		echo "FAIL $name: want [$want] got [$got]"
		echo "--- calls"
		cat "$STATE/calls"
		echo "--- log"
		cat "$STATE/log"
		failures=$((failures + 1))
	fi
}

t_orca_down() {
	setup
	add_issue ochanuco/alpha 1 '- 作業ブランチ: `dev/x`'
	touch "$STATE/orca-down"
	pickup
	expect "orca down: gh を呼ばない" 0 "$(calls 'gh ')"
	expect "orca down: log" 1 "$(grep -c 'Orca が起動していない' "$STATE/log")"
}

t_pick() {
	setup
	add_issue ochanuco/alpha 7 '- 作業ブランチ: `dev/feature-a`'
	pickup
	expect "pick: worktree create" 1 "$(calls 'orca worktree create --repo id:repo-a --name handoff-7 --base-branch origin/dev/feature-a --branch dev/feature-a --issue 7 --agent claude --prompt 申し送り issue https://github.com/ochanuco/alpha/issues/7 を読んで続きをやって')"
	expect "pick: fetch" 1 "$(calls 'git -C /src/alpha fetch --quiet origin dev/feature-a')"
	expect "pick: label" 1 "$(calls 'gh issue edit 7 --repo ochanuco/alpha --add-label working-handoff-picked')"
	expect "pick: comment" 1 "$(calls 'gh issue comment 7 --repo ochanuco/alpha')"
}

t_idempotent() {
	setup
	add_issue ochanuco/alpha 7 '- 作業ブランチ: `dev/feature-a`'
	pickup
	pickup
	expect "idempotent: create は 1 回" 1 "$(calls 'orca worktree create')"
	expect "idempotent: label は 1 回" 1 "$(calls 'gh issue edit')"
}

t_already_picked() {
	setup
	add_issue ochanuco/alpha 3 '- 作業ブランチ: `dev/y`' '["working-handoff","working-handoff-picked"]'
	pickup
	expect "picked: create しない" 0 "$(calls 'orca worktree create')"
	expect "picked: edit しない" 0 "$(calls 'gh issue edit')"
}

t_worktree_exists() {
	setup
	add_issue ochanuco/alpha 5 '- 作業ブランチ: `dev/z`'
	echo '{"ok":true,"result":{"worktrees":[{"path":"/tmp/old","branch":"refs/heads/other","linkedIssue":5}]}}' \
		>"$STATE/worktrees.json"
	pickup
	expect "exists: create しない" 0 "$(calls 'orca worktree create')"
	expect "exists: 印は付ける" 1 "$(calls 'gh issue edit 5 --repo ochanuco/alpha --add-label working-handoff-picked')"
}

t_repo_missing() {
	setup
	add_issue ochanuco/beta 9 '- 作業ブランチ: `dev/b`'
	add_issue ochanuco/alpha 2 '- 作業ブランチ: `dev/a`'
	pickup
	expect "missing: beta は作らない" 0 "$(calls 'orca worktree create --repo id:repo-a --name handoff-9')"
	expect "missing: beta に印を付けない" 0 "$(calls 'gh issue edit 9')"
	expect "missing: log" 1 "$(grep -c 'ochanuco/beta#9: Orca に ochanuco/beta が登録されていない' "$STATE/log")"
	expect "missing: alpha は続けて作る" 1 "$(calls 'orca worktree create --repo id:repo-a --name handoff-2')"
}

t_bad_branch() {
	setup
	add_issue ochanuco/alpha 4 '- 作業ブランチ: `--upload-pack=evil`'
	add_issue ochanuco/alpha 6 '作業ブランチの行が無い'
	pickup
	expect "bad branch: create しない" 0 "$(calls 'orca worktree create')"
	expect "bad branch: fetch しない" 0 "$(calls 'git ')"
	expect "bad branch: log" 2 "$(grep -c '作業ブランチの行が読めない' "$STATE/log")"
}

t_dry_run() {
	setup
	add_issue ochanuco/alpha 8 '- 作業ブランチ: `dev/d`'
	pickup --dry-run
	expect "dry-run: create しない" 0 "$(calls 'orca worktree create')"
	expect "dry-run: fetch しない" 0 "$(calls 'git ')"
	expect "dry-run: 書き込まない" 0 "$(grep -c -E 'gh (issue|label)' "$STATE/calls")"
	expect "dry-run: 読み取りはする" 1 "$(calls 'gh search issues')"
	expect "dry-run: create を表示" 1 "$(grep -c 'dry-run: orca worktree create' "$STATE/log")"
	expect "dry-run: label を表示" 1 "$(grep -c 'dry-run: gh issue edit 8' "$STATE/log")"
}

t_hs_open() {
	setup
	add_issue ochanuco/alpha 7 '- 作業ブランチ: `dev/feature-a`
- hishaku の番号: `4321`'
	pickup
	expect "hs: agent を起こさない worktree" 1 "$(calls 'orca worktree create --repo id:repo-a --name hs-4321 --base-branch origin/dev/feature-a --branch dev/feature-a --issue 7 --no-parent --json')"
	expect "hs: --agent を付けない" 0 "$(calls '--agent')"
	expect "hs: hs open" 1 "$(calls 'hs open -y ochanuco/alpha 4321')"
	expect "hs: label" 1 "$(calls 'gh issue edit 7 --repo ochanuco/alpha --add-label working-handoff-picked')"
	expect "hs: worktree を作ってから開く" "orca worktree create" "$(grep -E '^(orca worktree create|hs open)' "$STATE/calls" | head -n 1 | cut -d' ' -f1-3)"
}

t_hs_open_fail() {
	setup
	add_issue ochanuco/alpha 7 '- 作業ブランチ: `dev/feature-a`
- hishaku の番号: `4321`'
	touch "$STATE/hs-fail"
	pickup || true
	expect "hs fail: 印を付けない" 0 "$(calls 'gh issue edit')"
	rm "$STATE/hs-fail"
	pickup
	expect "hs fail: worktree は作り直さない" 1 "$(calls 'orca worktree create')"
	expect "hs fail: 次の回に開き直す" 2 "$(calls 'hs open -y ochanuco/alpha 4321')"
	expect "hs fail: 開けたら印を付ける" 1 "$(calls 'gh issue edit 7')"
}

t_hs_bad_number() {
	setup
	add_issue ochanuco/alpha 7 '- 作業ブランチ: `dev/feature-a`
- hishaku の番号: `12; rm`'
	pickup
	expect "bad number: hs を呼ばない" 0 "$(calls 'hs ')"
	expect "bad number: 今の動き" 1 "$(calls 'orca worktree create --repo id:repo-a --name handoff-7 ')"
}

t_hs_unconfigured() {
	setup
	add_issue ochanuco/alpha 7 '- 作業ブランチ: `dev/feature-a`
- hishaku の番号: `4321`'
	HISHAKU_URL="" pickup
	expect "unconfigured: hs を呼ばない" 0 "$(calls 'hs ')"
	expect "unconfigured: 今の動き" 1 "$(calls 'orca worktree create --repo id:repo-a --name handoff-7 --base-branch origin/dev/feature-a --branch dev/feature-a --issue 7 --agent claude')"
}

hs_session_issue() {
	add_issue ochanuco/alpha 7 '- 作業ブランチ: `dev/feature-a`
- hishaku の番号: `4321`'
}

t_meta_branch() {
	setup
	hs_session_issue
	echo 0.2.4 >"$STATE/hs-version"
	echo '{"number":4321,"repo":"ochanuco/alpha","branch":"dev/feature-a"}' >"$STATE/meta.json"
	pickup
	expect "meta: meta を読む" 1 "$(calls 'curl -fsS --max-time 20 -H @- https://hishaku.example.com/v1/sessions/4321')"
	expect "meta: secret を引数に載せない" 0 "$(calls 'secret-example')"
	expect "meta: ヘッダーは標準入力" 1 "$(grep -c -F 'CF-Access-Client-Secret: secret-example' "$STATE/curl-stdin")"
	expect "meta: hs open だけ" 1 "$(calls 'hs open -y 4321')"
	expect "meta: worktree を先に作らない" 0 "$(calls 'orca worktree create')"
	expect "meta: fetch しない" 0 "$(calls 'git ')"
	expect "meta: label" 1 "$(calls 'gh issue edit 7 --repo ochanuco/alpha --add-label working-handoff-picked')"
}

t_meta_branch_old_hs() {
	setup
	hs_session_issue
	echo v0.2.3 >"$STATE/hs-version"
	echo '{"number":4321,"repo":"ochanuco/alpha","branch":"dev/feature-a"}' >"$STATE/meta.json"
	pickup
	expect "old hs: worktree を先に作る" 1 "$(calls 'orca worktree create --repo id:repo-a --name hs-4321 --base-branch origin/dev/feature-a')"
	expect "old hs: 今の hs open" 1 "$(calls 'hs open -y ochanuco/alpha 4321')"
}

t_meta_no_branch() {
	setup
	hs_session_issue
	echo 0.3.0 >"$STATE/hs-version"
	echo '{"number":4321,"repo":"ochanuco/alpha","branch":null}' >"$STATE/meta.json"
	pickup
	expect "no branch: worktree を先に作る" 1 "$(calls 'orca worktree create --repo id:repo-a --name hs-4321 --base-branch origin/dev/feature-a')"
	expect "no branch: 今の hs open" 1 "$(calls 'hs open -y ochanuco/alpha 4321')"
}

t_hs_dev_version() {
	setup
	hs_session_issue
	echo dev >"$STATE/hs-version"
	echo '{"number":4321,"repo":"ochanuco/alpha","branch":"dev/feature-a"}' >"$STATE/meta.json"
	pickup
	expect "dev hs: 版が読めなければ先に作る" 1 "$(calls 'orca worktree create --repo id:repo-a --name hs-4321 --base-branch origin/dev/feature-a')"
}

t_meta_unreadable() {
	setup
	hs_session_issue
	echo 0.2.4 >"$STATE/hs-version"
	pickup
	expect "unreadable: meta が読めなければ先に作る" 1 "$(calls 'orca worktree create --repo id:repo-a --name hs-4321 --base-branch origin/dev/feature-a')"
	expect "unreadable: 今の hs open" 1 "$(calls 'hs open -y ochanuco/alpha 4321')"
}

t_meta_bad_branch() {
	setup
	hs_session_issue
	echo 0.2.4 >"$STATE/hs-version"
	echo '{"number":4321,"branch":"--upload-pack=evil"}' >"$STATE/meta.json"
	pickup
	expect "meta bad branch: 今の動き" 1 "$(calls 'orca worktree create --repo id:repo-a --name hs-4321 --base-branch origin/dev/feature-a')"
}

for t in t_meta_branch t_meta_branch_old_hs t_meta_no_branch t_hs_dev_version t_meta_unreadable t_meta_bad_branch t_orca_down t_pick t_idempotent t_already_picked t_worktree_exists t_repo_missing t_bad_branch t_dry_run t_hs_open t_hs_open_fail t_hs_bad_number t_hs_unconfigured; do
	"$t"
	rm -rf "$STATE"
done

if [ "$failures" -gt 0 ]; then
	echo "$failures failure(s)"
	exit 1
fi
echo "ok"
