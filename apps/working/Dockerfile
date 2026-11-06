# Working のコンテナ。orca serve と Claude CLI・Codex CLI と Working 受付を同じコンテナで動かす。
# ビルドコンテキストはリポジトリルート: docker build -f apps/working/Dockerfile .
FROM node:24.22.1-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @mizuya/working... \
 && pnpm --filter @mizuya/working deploy --prod --legacy /out

FROM node:24.22.1-slim AS node

# TAKT の claude-sdk provider の SDK。~/.takt の下に入り、イメージに焼き込む。版は mise/config.toml の takt と揃える。
FROM node:24.22.1-slim AS takt
ENV TAKT_CONFIG_DIR=/home/worker/.takt
RUN npx -y takt@0.74.0 install claude-sdk

# 人格の元ファイル。正本は yunomi の partners にあり、版をコミット SHA で固定して取り込む。YUNOMI_REF は Renovate が yunomi の main に追従して上げる。
FROM node:24.22.1-slim AS persona
# renovate: datasource=git-refs depName=https://github.com/ochanuco/yunomi currentValue=main
ARG YUNOMI_REF=d64cba80a59fc0ee675f7da789e4404e994a31e8
ADD https://github.com/ochanuco/yunomi.git#${YUNOMI_REF}:partners /partners
RUN for p in yukarin akarin; do \
		mkdir -p "/persona/$p" \
		&& cp -R "/partners/$p/identity" "/partners/$p/profile.yaml" "/partners/$p/examples.yaml" "/persona/$p/"; \
	done

FROM debian:bookworm-slim

ARG ORCA_VERSION=1.4.248
ARG MISE_VERSION=2026.11.2
ARG MISE_SHA256_AMD64=62cad463c1413f05398ca339168a8f655120b6f0b0b8adce3bc6758bafaf0602
ARG MISE_SHA256_ARM64=18bf3ac02033c2a50b772b411e35528cd1888386b4316895fcae626db6ad96f3
ARG CODEX_VERSION=0.167.0
ARG CODEX_SHA256_AMD64=3bbf75e83de6b58aed28f2cf6e33ad423ec31fd4700a1457b94be557ea5a7c6e
ARG CODEX_SHA256_ARM64=0de261ecf1e7f3028a7952f03fca2093f749277d38590b78bb32f8567756bbb7
# build-essential・python3・pkg-config は席で clone したリポジトリの依存のビルド（node-gyp、Python の C 拡張）に使う。
# libgl1・libglib2.0-0 は opencv-python を import するのに要る。
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl git jq bash procps \
		build-essential python3 pkg-config xz-utils unzip libgl1 libglib2.0-0 \
	&& rm -rf /var/lib/apt/lists/*

# 席の Claude がリポジトリの mise.toml の道具を入れるのに使う。
RUN arch="$(dpkg --print-architecture)" \
	&& case "$arch" in \
		amd64) asset=x64; sha="$MISE_SHA256_AMD64" ;; \
		arm64) asset=arm64; sha="$MISE_SHA256_ARM64" ;; \
		*) echo "unsupported arch: $arch" >&2; exit 1 ;; \
	esac \
	&& curl -fsSL -o /usr/local/bin/mise \
		"https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/mise-v${MISE_VERSION}-linux-${asset}" \
	&& echo "$sha  /usr/local/bin/mise" | sha256sum -c - \
	&& chmod 755 /usr/local/bin/mise
# mise.toml を持たないリポジトリ（uv だけで回すものなど）でも、席で同じ道具が使えるようにする。
COPY apps/working/mise/config.toml /etc/mise/config.toml

# Claude CLI が clone・issue・PR に使う。認証は環境変数 GH_TOKEN で渡す。
RUN curl -fsSL -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
		https://cli.github.com/packages/githubcli-archive-keyring.gpg \
	&& echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
		> /etc/apt/sources.list.d/github-cli.list \
	&& apt-get update \
	&& apt-get install -y --no-install-recommends gh \
	&& rm -rf /var/lib/apt/lists/*

# orca-ide の deb は Electron アプリ一式で、GUI 用ライブラリを依存に持つ。apt に解決させる。
RUN arch="$(dpkg --print-architecture)" \
	&& curl -fsSL -o /tmp/orca.deb \
		"https://github.com/stablyai/orca/releases/download/v${ORCA_VERSION}/orca-ide_${ORCA_VERSION}_${arch}.deb" \
	&& apt-get update \
	&& apt-get install -y --no-install-recommends /tmp/orca.deb \
	&& rm -rf /var/lib/apt/lists/* /tmp/orca.deb

# Akarin の席で動かす Codex CLI。codex はコマンドを横に置いた codex-code-mode-host と codex-exec-server で動かすので、
# 本体だけでなく配布の一式（codex-package）を /opt/codex に展開する。codex は自分の実体の場所から一式を探すので、PATH には symlink で出す。
RUN arch="$(dpkg --print-architecture)" \
	&& case "$arch" in \
		amd64) triple=x86_64-unknown-linux-musl; sha="$CODEX_SHA256_AMD64" ;; \
		arm64) triple=aarch64-unknown-linux-musl; sha="$CODEX_SHA256_ARM64" ;; \
		*) echo "unsupported arch: $arch" >&2; exit 1 ;; \
	esac \
	&& curl -fsSL -o /tmp/codex.tar.gz \
		"https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}/codex-package-${triple}.tar.gz" \
	&& echo "$sha  /tmp/codex.tar.gz" | sha256sum -c - \
	&& mkdir -p /opt/codex \
	&& tar -xzf /tmp/codex.tar.gz -C /opt/codex \
	&& ln -s /opt/codex/bin/codex /usr/local/bin/codex \
	&& rm -f /tmp/codex.tar.gz

# 席の Claude の手順書（orchestration の preamble）はコマンドを orca と書く。
RUN ln -s /usr/bin/orca-ide /usr/local/bin/orca

# 取り消せない操作を止める PreToolUse hook。managed settings も hook も root の持ち物にし、
# Claude CLI（worker で動く）が書き換えて止めるのをやめさせられないようにする。
COPY apps/working/guard/managed-settings.json /etc/claude-code/managed-settings.json
COPY apps/working/guard/codex-requirements.toml /etc/codex/requirements.toml
COPY apps/working/src/guard/hook.ts apps/working/src/guard/decide.ts \
	apps/working/src/guard/env.ts apps/working/src/guard/ledger.ts \
	apps/working/src/guard/bash.ts apps/working/src/guard/shell.ts \
	apps/working/src/guard/operation.ts /opt/mizuya-guard/
# 席の Claude の SessionStart で、作業中のリポジトリを含むセットを repo-map の写しから出す。
COPY apps/working/src/repo-map/hook.ts apps/working/src/repo-map/render.ts /opt/mizuya-repo-map/

# Working の記憶の口を呼ぶ CLI。接続情報は受付が STATE_DIR に書き、この CLI の中でだけ読む。
COPY apps/working/src/memory-cli/cli.ts apps/working/src/memory-cli/bin.ts /opt/yunomi-memory/
RUN printf '#!/bin/sh\nexec /usr/local/bin/node /opt/yunomi-memory/bin.ts "$@"\n' > /usr/local/bin/yunomi-memory \
	&& chmod 755 /usr/local/bin/yunomi-memory

RUN useradd -m -s /bin/bash worker
USER worker
WORKDIR /home/worker
# named volume は空のときマウント先の所有者を引き継ぐ。先に worker 所有で作っておかないと root 所有になり書けない。
RUN mkdir -p /home/worker/.claude /home/worker/.codex /home/worker/.config /home/worker/state /home/worker/work
# Orca は席の worktree を ~/orca/workspaces に作る。作り直しても席が残るよう work の volume に置く。
RUN ln -s /home/worker/work/orca /home/worker/orca

RUN curl -fsSL https://claude.ai/install.sh | bash
RUN git config --global credential.helper '!gh auth git-credential'
ENV PATH=/home/worker/.local/bin:$PATH
# .claude.json（ログインの付随情報）も volume に入れるため、設定の置き場所を 1 か所にまとめる。
ENV CLAUDE_CONFIG_DIR=/home/worker/.claude
# Codex CLI のログイン情報（auth.json）・設定・会話を volume に置く。
ENV CODEX_HOME=/home/worker/.codex
# mise が入れた道具とダウンロードのキャッシュを work の volume に置き、コンテナを作り直しても入れ直さない。
# pnpm の store と uv のキャッシュも同じ volume に置くと、席の node_modules と .venv に hardlink で入る。
ENV MISE_DATA_DIR=/home/worker/work/.mise \
	MISE_CACHE_DIR=/home/worker/work/.mise/cache \
	MISE_STATE_DIR=/home/worker/work/.mise/state \
	MISE_TRUSTED_CONFIG_PATHS=/home/worker/work \
	UV_CACHE_DIR=/home/worker/work/.cache/uv \
	UV_PYTHON_INSTALL_DIR=/home/worker/work/.uv/python \
	npm_config_store_dir=/home/worker/work/.pnpm-store

# 人格の元ファイルをそのまま連結して席の Claude に渡す。
COPY --from=persona --chown=worker:worker /persona/ /home/worker/persona/
COPY --chown=worker:worker apps/working/persona.sh /home/worker/bin/persona.sh
# Mac への引き継ぎの手順と申し送りの雛形。受付が席の Claude に渡す前置きに足す。
COPY apps/working/handoff/prompt.md apps/working/handoff/issue-template.md /home/worker/handoff/
# TAKT のグローバル設定。~/.takt は volume に入れていないので、イメージに焼き込む。
COPY --from=takt --chown=worker:worker /home/worker/.takt/ /home/worker/.takt/
COPY --chown=worker:worker apps/working/takt/ /home/worker/.takt/

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=build --chown=worker:worker /out /home/worker/app
COPY --chown=worker:worker apps/working/start.sh apps/working/seat-env.sh apps/working/init-seats-repo.sh apps/working/release-orcad-lock.sh /home/worker/bin/

# 8080 は gateway からの受付、8090 は Mac からの席の状態
EXPOSE 8080 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
	CMD ["curl", "-fsS", "http://127.0.0.1:8080/healthz"]
# 引数（orca-ide serve …）を受付と並べて動かす。引数がなければ受付だけを動かす。
ENTRYPOINT ["/home/worker/bin/start.sh"]
