#!/usr/bin/env bash
# send.sh を、orca・curl をモックに差し替えて確かめる。
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
send="$here/../send.sh"
failures=0
STATE=""

setup() {
	STATE="$(mktemp -d)"
	export STATE
	: >"$STATE/calls"
	printf 'mac-token' >"$STATE/token"
	cat >"$STATE/ps.json" <<'JSON'
{"ok":true,"result":{"worktrees":[
  {"repo":"yunomi","branch":"refs/heads/dev/x","displayName":"x","path":"/secret/path","preview":"terminal output",
   "workspaceStatus":"in-progress","isActive":true,"unread":false,"isArchived":false,"lastActivityAt":1793871454808,
   "linkedPR":{"number":12,"state":"open","title":"t","url":"u","checksStatus":"failure"},
   "agents":[{"agentType":"claude","state":"working","taskTitle":null,"prompt":"secret prompt","updatedAt":1793871454000}]},
  {"repo":"old","branch":"refs/heads/main","isArchived":true,"agents":[]}
]}}
JSON
}

send() {
	PATH="$here/mock:$PATH" MAC_STATE_URL="http://receiver/mac-state" MAC_STATE_TOKEN_FILE="$STATE/token" \
		"${SEND_BASH:-bash}" "$send" 2>"$STATE/log"
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
	touch "$STATE/orca-down"
	send
	expect "orca down: curl を呼ばない" 0 "$(calls 'curl ')"
	expect "orca down: log" 1 "$(grep -c 'Orca が起動していない' "$STATE/log")"
}

t_sends_summary() {
	setup
	send
	expect "送る: curl は 1 回" 1 "$(calls 'curl ')"
	expect "送る: トークンは標準入力のヘッダー" "Authorization: Bearer mac-token" "$(cat "$STATE/headers")"
	expect "送る: トークンを argv に載せない" 0 "$(calls 'mac-token')"
	expect "送る: archive は除く" 1 "$(jq '.worktrees | length' "$STATE/body")"
	expect "送る: branch" "dev/x" "$(jq -r '.worktrees[0].branch' "$STATE/body")"
	expect "送る: pr" "failure" "$(jq -r '.worktrees[0].pr.checks' "$STATE/body")"
	expect "送る: agent" "working" "$(jq -r '.worktrees[0].agents[0].state' "$STATE/body")"
	expect "送る: パスと出力と prompt は送らない" 0 "$(grep -c -E 'secret|terminal output' "$STATE/body" || true)"
	expect "送る: sent_at は数値" "number" "$(jq -r '.sent_at | type' "$STATE/body")"
}

t_curl_fails() {
	setup
	touch "$STATE/curl-fail"
	local code=0
	send || code=$?
	expect "送れない: exit 1" 1 "$code"
}

t_orca_down
t_sends_summary
t_curl_fails

if [ "$failures" -gt 0 ]; then
	echo "$failures 件失敗"
	exit 1
fi
echo "ok"
