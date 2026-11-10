#!/usr/bin/env bash
# 席の worktree の元にする空の git リポジトリを用意する。席の中で clone したものは .gitignore で無視する。
set -euo pipefail
repo="${SEATS_REPO:-$HOME/work/seats}"
[ -d "$repo/.git" ] && exit 0
mkdir -p "$repo"
cd "$repo"
git init -q -b main
printf '/*\n!/.gitignore\n' >.gitignore
git add .gitignore
git -c user.name=mizuya-working -c user.email=mizuya-working@localhost commit -qm "席の元"
