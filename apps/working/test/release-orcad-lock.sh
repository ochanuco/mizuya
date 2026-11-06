#!/usr/bin/env bash
# release-orcad-lock.sh を、一時ディレクトリを XDG_CONFIG_HOME にして確かめる。
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
release="$here/../release-orcad-lock.sh"
failures=0
DIR=""
LOCK=""

setup() {
	DIR="$(mktemp -d)"
	mkdir -p "$DIR/orca"
	LOCK="$DIR/orca/orcad.lock"
}

write_lock() {
	printf '{"pid":%s,"bootId":"b","nonce":"n"}' "$1" >"$LOCK"
}

run() {
	XDG_CONFIG_HOME="$DIR" bash "$release" "$@" 2>"$DIR/log"
}

exists() { [ -f "$LOCK" ] && echo yes || echo no; }

expect() {
	local name="$1" want="$2" got="$3"
	if [ "$want" != "$got" ]; then
		echo "FAIL $name: want [$want] got [$got]"
		cat "$DIR/log" 2>/dev/null || true
		failures=$((failures + 1))
	fi
}

dead_pid() {
	bash -c 'exit 0' &
	local pid=$!
	wait "$pid"
	echo "$pid"
}

t_no_lock() {
	setup
	run orca-ide serve --port 6768
	expect "lock なし: 何もしない" no "$(exists)"
	expect "lock なし: ログなし" 0 "$(wc -l <"$DIR/log" | tr -d ' ')"
}

t_stale_lock() {
	setup
	write_lock "$(dead_pid)"
	run orca-ide serve --port 6768
	expect "前の lock: 消す" no "$(exists)"
	expect "前の lock: ログ 1 行" 1 "$(grep -c 'orcad.lock を消した' "$DIR/log")"
}

t_live_pid() {
	setup
	bash -c 'exec -a /opt/Orca/orca-ide sleep 30' &
	local pid=$!
	write_lock "$pid"
	run orca-ide serve --port 6768
	kill "$pid" 2>/dev/null || true
	wait "$pid" 2>/dev/null || true
	expect "生きている pid: 残す" yes "$(exists)"
}

t_reused_pid() {
	setup
	sleep 30 &
	local pid=$!
	write_lock "$pid"
	run /usr/bin/orca-ide serve
	kill "$pid" 2>/dev/null || true
	wait "$pid" 2>/dev/null || true
	expect "orcad でない pid: 消す" no "$(exists)"
}

t_other_command() {
	setup
	write_lock "$(dead_pid)"
	run sleep 1
	expect "orca-ide serve 以外: 残す" yes "$(exists)"
	run
	expect "引数なし: 残す" yes "$(exists)"
}

t_no_lock
t_stale_lock
t_live_pid
t_reused_pid
t_other_command

if [ "$failures" -gt 0 ]; then
	echo "$failures 件失敗"
	exit 1
fi
echo "ok"
