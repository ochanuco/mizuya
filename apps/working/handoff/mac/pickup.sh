#!/usr/bin/env bash
# Working が残した申し送り issue を集め、Mac の Orca に worktree と agent を立てる。
# issue に hishaku の番号があれば、hs open で席の会話の続きを開く。
# macOS 標準の bash 3.2 で動かすため、連想配列や mapfile は使わない。
set -euo pipefail

OWNER="${HANDOFF_OWNER:-ochanuco}"
LABEL="${HANDOFF_LABEL:-working-handoff}"
PICKED_LABEL="${HANDOFF_PICKED_LABEL:-working-handoff-picked}"
AGENT="${HANDOFF_AGENT:-claude}"
DRY_RUN="${HANDOFF_DRY_RUN:-0}"

usage() {
	cat <<'EOF'
Usage: pickup.sh [--dry-run]

open な working-handoff issue ごとに、Orca に worktree を作って agent を起動し、
issue に working-handoff-picked の label とコメントを付ける。
issue に hishaku の番号があれば、作業ブランチの worktree hs-<番号> を作り、
hs open で Working の席の会話の続きを開く。

  --dry-run  読み取りだけ行い、作成・書き込みの操作は実行せずに表示する
EOF
}

for arg in "$@"; do
	case "$arg" in
	--dry-run) DRY_RUN=1 ;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		usage >&2
		exit 2
		;;
	esac
done

log() {
	printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2
}

# 書き込みを伴う操作はすべてここを通し、dry-run では表示だけにする。
run() {
	if [ "$DRY_RUN" = 1 ]; then
		local quoted
		quoted=$(printf '%q ' "$@")
		log "dry-run: ${quoted% }"
	else
		"$@"
	fi
}

orca_ready() {
	local status
	status=$(orca status --json 2>/dev/null) || return 1
	printf '%s' "$status" | jq -e '.result.runtime.reachable == true' >/dev/null 2>&1
}

mark_picked() {
	local repo="$1" number="$2" worktree="$3"
	# label の作成は既にあれば失敗するだけなので、結果を見ない。
	run gh label create "$PICKED_LABEL" --repo "$repo" \
		--color 0e8a16 --description "Mac の Orca が引き継いだ申し送り" >/dev/null 2>&1 || true
	run gh issue edit "$number" --repo "$repo" --add-label "$PICKED_LABEL" >/dev/null || return 1
	run gh issue comment "$number" --repo "$repo" \
		--body "Mac の Orca で引き継いだ。worktree: \`$worktree\`" >/dev/null || return 1
}

handle() {
	local item="$1" repo number url body branch session repo_line repo_id repo_path name existing
	repo=$(printf '%s' "$item" | jq -r '.repository.nameWithOwner')
	number=$(printf '%s' "$item" | jq -r '.number')
	url=$(printf '%s' "$item" | jq -r '.url')
	body=$(printf '%s' "$item" | jq -r '.body // ""')

	branch=$(printf '%s\n' "$body" | sed -n 's/^- 作業ブランチ: `\([^`]*\)`.*$/\1/p' | head -n 1)
	# branch は issue 本文から来るので、git と orca に渡す前に形を絞る。
	if ! printf '%s' "$branch" | grep -Eq '^[A-Za-z0-9._][A-Za-z0-9._/-]*$'; then
		log "skip $repo#$number: 作業ブランチの行が読めない"
		return 0
	fi

	# 番号も issue 本文から来るので、4 桁の数字だけを通す。形が違えば番号なしとして今の動きにする。
	session=$(printf '%s\n' "$body" | sed -n 's/^- hishaku の番号: `\([0-9]\{4\}\)`.*$/\1/p' | head -n 1)
	# hs か Manager の接続情報が無い Mac では、番号があっても今の動き（agent に issue を読ませる）にする。
	if [ -n "$session" ] && { ! command -v hs >/dev/null 2>&1 || [ -z "${HISHAKU_URL:-}" ]; }; then
		log "$repo#$number: hs か HISHAKU_URL が無いので、番号 $session を使わずに引き継ぐ"
		session=""
	fi

	repo_line=$(printf '%s' "$REPOS" | jq -r --arg key "github.com/$repo" '
		[.result.repos[]
		 | select((.gitRemoteIdentity.canonicalKey // "" | ascii_downcase) == ($key | ascii_downcase))
		][0] // empty
		| "\(.id)\t\(.path)"')
	if [ -z "$repo_line" ]; then
		log "skip $repo#$number: Orca に $repo が登録されていない"
		return 0
	fi
	repo_id="${repo_line%%$'\t'*}"
	repo_path="${repo_line#*$'\t'}"
	name="handoff-$number"
	# hs open は worktree hs-<番号> があればそれを使う。meta にはブランチが無いので、作業ブランチの worktree を先に作っておく。
	[ -z "$session" ] || name="hs-$session"

	# 前回 worktree を作った後に印を付け損ねた場合も、二重に作らない。
	existing=$(orca worktree list --repo "id:$repo_id" --json | jq -r \
		--argjson n "$number" --arg ref "refs/heads/$branch" '
		[.result.worktrees[]
		 | select(((.linkedIssue | if type == "object" then .number else . end) == $n)
		          or .branch == $ref)
		][0].path // empty') || {
		log "fail $repo#$number: Orca の worktree 一覧が取れない"
		return 1
	}
	if [ -n "$existing" ]; then
		if [ -n "$session" ]; then
			# 前回 hs open で開けなかった場合に備えて開き直す。hs open は worktree hs-<番号> をそのまま使う。
			log "already $repo#$number: worktree がある。hs open $session で開いてから印を付ける"
			run hs open -y "$repo" "$session" >/dev/null || {
				log "fail $repo#$number: hs open $session で開けない"
				return 1
			}
		else
			log "already $repo#$number: worktree がある。印だけ付ける"
		fi
		mark_picked "$repo" "$number" "$name" || {
			log "fail $repo#$number: 印を付けられない"
			return 1
		}
		return 0
	fi

	run git -C "$repo_path" fetch --quiet origin "$branch" || {
		log "fail $repo#$number: origin/$branch を fetch できない"
		return 1
	}
	if [ -n "$session" ]; then
		run orca worktree create --repo "id:$repo_id" --name "$name" \
			--base-branch "origin/$branch" --branch "$branch" --issue "$number" \
			--no-parent --json >/dev/null || {
			log "fail $repo#$number: worktree を作れない"
			return 1
		}
		run hs open -y "$repo" "$session" >/dev/null || {
			log "fail $repo#$number: worktree は作ったが hs open $session で開けない。次回は開き直す"
			return 1
		}
	else
		run orca worktree create --repo "id:$repo_id" --name "$name" \
			--base-branch "origin/$branch" --branch "$branch" --issue "$number" \
			--agent "$AGENT" --prompt "申し送り issue $url を読んで続きをやって" \
			--no-parent --json >/dev/null || {
			log "fail $repo#$number: worktree を作れない"
			return 1
		}
	fi
	mark_picked "$repo" "$number" "$name" || {
		log "fail $repo#$number: worktree は作ったが印を付けられない。次回は印だけ付ける"
		return 1
	}
	log "picked $repo#$number: $name ($branch)"
}

if ! orca_ready; then
	log "Orca が起動していないので何もしない"
	exit 0
fi

issues=$(gh search issues --owner "$OWNER" --label "$LABEL" --state open --limit 100 \
	--json number,repository,labels,body,url)
REPOS=$(orca repo list --json)

pending=$(printf '%s' "$issues" | jq --arg picked "$PICKED_LABEL" '[.[] | select([.labels[].name] | index($picked) | not)] | length')
log "未処理の申し送り: $pending 件"

failed=0
# 中の gh・orca・git が標準入力を読んでも一覧を食わないよう、fd 3 で回す。
while IFS= read -r item <&3; do
	[ -n "$item" ] || continue
	handle "$item" || failed=1
done 3< <(printf '%s' "$issues" | jq -c --arg picked "$PICKED_LABEL" '
	.[] | select([.labels[].name] | index($picked) | not)')

exit "$failed"
