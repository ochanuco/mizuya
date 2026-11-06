#!/usr/bin/env bash
# orca-ide serve の前に、前のコンテナの orcad が残した lock を消す。
# volume はこのコンテナ専用なので、この中で lock の pid が orcad として生きていなければ持ち主はもういない。
# 作り直したコンテナはホスト名が変わり、orcad は持ち主を確かめられずに起動を拒む。
# --reclaim-stale-lock は同じホスト名と前回の boot を求めるため、同じホストでの作り直しには使えない。
set -euo pipefail

if [ "$#" -lt 2 ] || [ "$(basename "$1")" != orca-ide ] || [ "$2" != serve ]; then
	exit 0
fi

lock="${XDG_CONFIG_HOME:-$HOME/.config}/orca/orcad.lock"
[ -f "$lock" ] || exit 0

pid="$(jq -r '.pid // empty' "$lock" 2>/dev/null || true)"
# pid はコンテナごとに振り直されるので、番号が残っているだけでは orcad と限らない。
if [[ "$pid" =~ ^[0-9]+$ ]] && ps -o args= -p "$pid" 2>/dev/null | grep -qi orca; then
	exit 0
fi

rm -f "$lock"
echo "orcad.lock を消した（pid ${pid:-なし} はこのコンテナで動いていない）" >&2
