#!/usr/bin/env bash
# init-seats-repo.sh が空の git リポジトリを作り、2 回目は何もしないことを確かめる。
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
dir="$(mktemp -d)"
trap 'rm -rf "$dir"' EXIT
repo="$dir/work/seats"
SEATS_REPO="$repo" "$here/../init-seats-repo.sh"
head="$(git -C "$repo" rev-parse HEAD)"
[ "$(git -C "$repo" ls-files)" = ".gitignore" ] || { echo "FAIL: .gitignore だけを commit していない" >&2; exit 1; }
mkdir "$repo/cloned"
[ -z "$(git -C "$repo" status --porcelain)" ] || { echo "FAIL: 席の中の clone が無視されない" >&2; exit 1; }
SEATS_REPO="$repo" "$here/../init-seats-repo.sh"
[ "$(git -C "$repo" rev-parse HEAD)" = "$head" ] || { echo "FAIL: 2 回目で作り直した" >&2; exit 1; }
echo "init-seats-repo: ok"
