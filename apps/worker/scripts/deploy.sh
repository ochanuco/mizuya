#!/usr/bin/env bash
# 使い方: apps/worker/scripts/deploy.sh production
# CLOUDFLARE_API_TOKEN と Worker の secret は呼び出し側（deploy workflow の op run）が環境変数で渡す。
# secret は毎回すべて反映する。argv に載せないよう --secrets-file で渡す。
set -euo pipefail

if [ "${1:-}" != "production" ]; then
  echo "usage: apps/worker/scripts/deploy.sh production" >&2
  exit 2
fi

cd "$(dirname "$0")/.."

host=mizuya.chanu.co
secrets=(
  GITHUB_WEBHOOK_SECRET
  GITHUB_APPROVER_TOKEN
  DISCORD_PUBLIC_KEY
  DISCORD_BOT_TOKEN
  DISCORD_APPROVER_USER_ID
  DISCORD_APPROVAL_CHANNEL_ID
)

# /health は secret が無くても応答するので、欠けたまま出すと署名検証が壊れても気づけない。足りないものを一度に示して止める
missing=()
for name in CLOUDFLARE_API_TOKEN "${secrets[@]}"; do
  if [ -z "${!name:-}" ]; then
    missing+=("$name")
  fi
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "error: 未設定: ${missing[*]}（.github/deploy/production.env.op の参照先を確かめる）" >&2
  exit 1
fi

secrets_file=$(mktemp)
trap 'rm -f "$secrets_file"' EXIT
chmod 600 "$secrets_file"
for name in "${secrets[@]}"; do
  printf '%s=%s\n' "$name" "${!name}" >> "$secrets_file"
done

pnpm exec wrangler deploy --secrets-file "$secrets_file"

for attempt in $(seq 1 10); do
  if curl -fsS --max-time 10 "https://$host/health" > /dev/null; then
    echo "mizuya: https://$host/health OK"
    exit 0
  fi
  echo "health check 再試行 ($attempt/10)" >&2
  sleep 6
done
echo "error: https://$host/health が応答しない" >&2
exit 1
