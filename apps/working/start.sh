#!/usr/bin/env bash
# Working 受付を動かす。受付が落ちたらコンテナごと終わらせ、再起動は Docker に任せる。
set -euo pipefail
cd /home/worker/app
mkdir -p /home/worker/work/.tokeneconomizer
/home/worker/bin/init-seats-repo.sh
# managed settings が marketplace を宣言しても、CLI に入れさせないと plugin は入らない。何度呼んでも同じ結果になる。
# plugin は /opt/tokeneconomizer をその場で読むので、image の版を上げればそのまま新しい版になる。
# 入らなくても席は動くので、失敗では止めない。
if ! { claude plugin marketplace add /opt/tokeneconomizer && claude plugin install tokeneconomizer@tokeneconomizer; } >/dev/null 2>&1; then
	echo "start.sh: Claude CLI に TokenEconomizer を入れられなかった" >&2
fi
# Codex は plugin を CODEX_HOME に写して使うので、image の版を上げたら入れ直す必要がある。毎回入れ直せば済む。
# Codex の席の hook は requirements.toml が持ち、plugin から来るのは skill（$tokeneconomizer:status など）だけ。
if ! { codex plugin marketplace add /opt/tokeneconomizer && codex plugin add tokeneconomizer@tokeneconomizer; } >/dev/null 2>&1; then
	echo "start.sh: Codex CLI に TokenEconomizer を入れられなかった" >&2
fi
exec node_modules/.bin/tsx src/main.ts
