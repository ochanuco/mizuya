#!/usr/bin/env bash
# seat-env.sh が席の Claude に渡す環境変数を絞ることを確かめる。
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
out="$(HOME=/home/w PATH="$PATH" GH_TOKEN=gh DISCORD_TOKEN=secret WORKING_TOKEN=secret \
	CF_ACCESS_CLIENT_SECRET=secret CHIMERA_ACCESS_CLIENT_ID=cid \
	CHIMERA_ACCESS_CLIENT_SECRET=secret STATE_DIR=/s "$here/../seat-env.sh" env)"
failures=0
expect() {
	if ! grep -qx "$1" <<<"$out"; then
		echo "FAIL: $1 が無い" >&2
		failures=$((failures + 1))
	fi
}
reject() {
	if grep -q "^$1=" <<<"$out"; then
		echo "FAIL: $1 が渡っている" >&2
		failures=$((failures + 1))
	fi
}
expect "HOME=/home/w"
expect "GH_TOKEN=gh"
expect "YUNOMI_STATE_DIR=/s"
expect "YUNOMI_SEATS_DIR=/home/w/work/orca/workspaces/seats"
reject DISCORD_TOKEN
reject WORKING_TOKEN
reject CF_ACCESS_CLIENT_SECRET
reject CHIMERA_ACCESS_CLIENT_ID
reject CHIMERA_ACCESS_CLIENT_SECRET
[ "$failures" -eq 0 ] && echo "seat-env: ok"
exit "$failures"
