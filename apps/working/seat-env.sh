#!/usr/bin/env bash
# 引数のコマンドを、席の Claude に渡してよい環境変数だけで動かす。
# MIZUYA_* は hook（src/guard）が席と許可の記録を探すのに使う。
# 受付の秘密（Discord のトークン、記憶の口・chimera・chakai の service token）は keep に足さない。
set -euo pipefail
keep=(HOME LANG LC_ALL TZ USER CLAUDE_CONFIG_DIR CODEX_HOME XDG_CONFIG_HOME GH_TOKEN
	GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL
	MISE_DATA_DIR MISE_CACHE_DIR MISE_STATE_DIR MISE_TRUSTED_CONFIG_PATHS
	UV_CACHE_DIR UV_PYTHON_INSTALL_DIR npm_config_store_dir)
args=()
for k in "${keep[@]}"; do
	if [ -n "${!k:-}" ]; then args+=("$k=${!k}"); fi
done
# shims は席の中だけで通す。受付の node（tsx の #!/usr/bin/env node）が mise の node に替わらないように。
args+=("PATH=${MISE_DATA_DIR:-$HOME/.local/share/mise}/shims:$PATH")
args+=("MIZUYA_STATE_DIR=${STATE_DIR:-$HOME/state}")
args+=("MIZUYA_SEATS_DIR=${SEATS_DIR:-$HOME/work/orca/workspaces/seats}")
exec env -i "${args[@]}" "$@"
