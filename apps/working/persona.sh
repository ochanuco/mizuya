#!/usr/bin/env bash
# partners/<パートナー> の元ファイルを 1 つの system prompt に連結して標準出力に出す。
# 引数はパートナーの ID（既定は yukarin）。元ファイルは $HOME/persona/<パートナー>/ に置く。
set -euo pipefail
partner="${1:-yukarin}"
case "$partner" in
	yukarin) name="結月ゆかり" ;;
	akarin) name="紲星あかり" ;;
	*) echo "unknown partner: $partner" >&2; exit 2 ;;
esac
dir="${PERSONA_DIR:-$HOME/persona}/$partner"
printf 'あなたは以下の人格（%sの非公式ファンメイドの人格）として、日本語で、この口調のまま答える。\n' "$name"
for f in identity/official.md identity/fanon.md identity/yunomi.md profile.yaml examples.yaml; do
	printf '\n## %s\n\n' "$f"
	cat "$dir/$f"
done
