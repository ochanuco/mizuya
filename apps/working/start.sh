#!/usr/bin/env bash
# Working 受付と、引数で渡したコマンド（orca-ide serve など）を並べて動かす。
# どちらかが終わったらコンテナごと終わらせ、再起動は Docker に任せる。
set -euo pipefail
cd /home/worker/app
/home/worker/bin/release-orcad-lock.sh "$@"
# ~/orca は work の volume への symlink。空の volume では行き先が無く、Orca が席を作れない。
mkdir -p /home/worker/work/orca /home/worker/work/.tokeneconomizer
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
node_modules/.bin/tsx src/main.ts &
# hs turn で席を回すときは orca serve を起こさない。席の agent は受付が要るものだけの環境で起こす
if [ "$#" -gt 0 ] && [ "${SEAT_ENGINE:-orca}" != "hishaku" ]; then
	# 席の Claude は orca serve の環境変数を受け継ぐ。受付の秘密（Discord のトークンなど）を渡さないよう、要るものだけにする。
	/home/worker/bin/seat-env.sh "$@" &
fi
set +e
wait -n
status=$?
kill $(jobs -p) 2>/dev/null
exit "$status"
