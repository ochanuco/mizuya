#!/usr/bin/env bash
# Mac の Orca の席の状態（worktree と agent の一覧）を要約し、Working の受付の /mac-state に送る。
# 朝会は最後に届いた 1 件を読むので、Mac が寝ている間は送らなくてよい。
set -euo pipefail

URL="${MAC_STATE_URL:-}"
TOKEN_FILE="${MAC_STATE_TOKEN_FILE:-}"
LIMIT="${MAC_STATE_LIMIT:-200}"

log() {
	printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2
}

if [ -z "$URL" ] || [ -z "$TOKEN_FILE" ]; then
	log "MAC_STATE_URL と MAC_STATE_TOKEN_FILE を設定する"
	exit 2
fi

status=$(orca status --json 2>/dev/null) || status=""
if ! printf '%s' "$status" | jq -e '.result.runtime.reachable == true' >/dev/null 2>&1; then
	log "Orca が起動していないので送らない"
	exit 0
fi

ps=$(orca worktree ps --json --limit "$LIMIT") || {
	log "orca worktree ps に失敗した"
	exit 1
}

# 受付は形を検査するので、型が違う値は null にする。パス・端末の出力・prompt は送らない。
body=$(printf '%s' "$ps" | jq -c --argjson now "$(($(date +%s) * 1000))" '
	def str: if type == "string" then . else null end;
	def bool: if type == "boolean" then . else null end;
	def ms: if type == "number" and . >= 0 then floor else null end;
	{
		sent_at: $now,
		worktrees: [
			(.result.worktrees // [])[]
			| select(.isArchived != true)
			| {
				repo: (.repo | str),
				branch: (.branch | str | if . == null then null else sub("^refs/heads/"; "") end),
				name: (.displayName | str),
				status: ((.workspaceStatus // .status) | str),
				active: (.isActive | bool),
				unread: (.unread | bool),
				last_activity_at: (.lastActivityAt | ms),
				pr: (.linkedPR | if type == "object" and (.number | type) == "number"
					then {number: .number, state: (.state | str), checks: (.checksStatus | str)}
					else null end),
				agents: [
					(.agents // [])[]
					| {
						type: (.agentType | str),
						state: (.state | str),
						title: (.taskTitle | str),
						updated_at: (.updatedAt | ms)
					}
				]
			}
		]
	}') || {
	log "orca worktree ps の出力を読めない"
	exit 1
}

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
printf '%s' "$body" >"$tmp"

# トークンを argv に載せないよう、ヘッダーは標準入力から渡す。
token=$(cat "$TOKEN_FILE")
printf 'Authorization: Bearer %s\n' "$token" |
	curl -fsS --max-time 20 -X POST -H @- -H 'content-type: application/json' \
		--data-binary @"$tmp" "$URL" >/dev/null || {
	log "送れなかった"
	exit 1
}
log "送った: $(printf '%s' "$body" | jq '.worktrees | length') worktrees"
