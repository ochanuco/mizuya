#!/usr/bin/env bash
# Working 受付と、引数で渡したコマンド（orca-ide serve など）を並べて動かす。
# どちらかが終わったらコンテナごと終わらせ、再起動は Docker に任せる。
set -euo pipefail
cd /home/worker/app
/home/worker/bin/release-orcad-lock.sh "$@"
# ~/orca は work の volume への symlink。空の volume では行き先が無く、Orca が席を作れない。
mkdir -p /home/worker/work/orca
/home/worker/bin/init-seats-repo.sh
node_modules/.bin/tsx src/main.ts &
if [ "$#" -gt 0 ]; then
	# 席の Claude は orca serve の環境変数を受け継ぐ。受付の秘密（Discord のトークンなど）を渡さないよう、要るものだけにする。
	/home/worker/bin/seat-env.sh "$@" &
fi
set +e
wait -n
status=$?
kill $(jobs -p) 2>/dev/null
exit "$status"
