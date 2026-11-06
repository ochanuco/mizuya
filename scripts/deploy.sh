#!/usr/bin/env bash
# 使い方: scripts/deploy.sh production
# CLOUDFLARE_API_TOKEN と Worker の secret は呼び出し側（deploy workflow の op run）が環境変数で渡す。
# secret は設定されているものだけ反映し、argv に載せないよう --secrets-file で渡す。
set -euo pipefail

if [ "${1:-}" != "production" ]; then
  echo "usage: scripts/deploy.sh production" >&2
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

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "error: CLOUDFLARE_API_TOKEN が未設定" >&2
  exit 1
fi

secrets_file=$(mktemp)
trap 'rm -f "$secrets_file"' EXIT
chmod 600 "$secrets_file"
for name in "${secrets[@]}"; do
  if [ -n "${!name:-}" ]; then
    printf '%s=%s\n' "$name" "${!name}" >> "$secrets_file"
  else
    # 前回のデプロイで反映済みのことがあるので止めない
    echo "warning: $name が未設定。Worker secret に無ければ動かない" >&2
  fi
done

deploy_args=()
if [ -s "$secrets_file" ]; then
  deploy_args+=(--secrets-file "$secrets_file")
fi
pnpm exec wrangler deploy "${deploy_args[@]+"${deploy_args[@]}"}"

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
