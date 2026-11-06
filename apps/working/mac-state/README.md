# apps/working/mac-state

Mac の Orca の席の状態（worktree と agent の一覧）を、Working の受付の `POST /mac-state` に送る。朝会は最後に届いた 1 件を読むので、Mac が寝ている間に送れなくてもよい。

## 中身

| ファイル                               | 役割                                                                                               |
| -------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `send.sh`                              | `orca worktree ps --json` を要約して送る。Orca が起動していなければ何もしない                      |
| `local.yunomi.working-mac-state.plist` | launchd の plist の雛形。ログイン時と、その後 10 分おきに走る                                      |
| `test/run.sh`                          | `orca`・`curl` をモックにした `send.sh` のテスト（`pnpm --filter @mizuya/working-mac-state test`） |

## 送るもの

worktree ごとに、repo、ブランチ、表示名、状態、開いているか、未読か、最後に動いた時刻、紐づく PR（番号・状態・CI）、agent（種類・状態・タスク名・更新時刻）を送る。archive した worktree、パス、端末の出力、agent への prompt は送らない。

トークンは `curl` の引数に載せず、標準入力からヘッダーとして渡す。

| 変数                   | 内容                                              |
| ---------------------- | ------------------------------------------------- |
| `MAC_STATE_URL`        | 受付の `/mac-state` の URL                        |
| `MAC_STATE_TOKEN_FILE` | 受付の `MAC_STATE_TOKEN` と同じ値を書いたファイル |
| `MAC_STATE_LIMIT`      | 送る worktree の上限。既定は `200`                |

## Mac へのインストール

前提は、Orca の CLI `orca` が入っていること、`jq` があること（macOS 15 以降は `/usr/bin/jq`）。

1. トークンをファイルに置く。

   ```sh
   umask 077
   printf '%s' '<MAC_STATE_TOKEN の値>' > <トークンのファイル>
   ```

2. 一度手で走らせて、届くことを確かめる。

   ```sh
   MAC_STATE_URL=<受付の URL> MAC_STATE_TOKEN_FILE=<トークンのファイル> \
     apps/working/mac-state/send.sh
   ```

3. plist の雛形のプレースホルダを埋めて `~/Library/LaunchAgents/` に置く。

   | プレースホルダ   | 入れるもの                                                     |
   | ---------------- | -------------------------------------------------------------- |
   | `__REPO__`       | このリポジトリの checkout の絶対パス                           |
   | `__PATH__`       | `orca`・`jq`・`curl` が見つかる PATH。`/usr/bin:/bin` も含める |
   | `__URL__`        | 受付の `/mac-state` の URL                                     |
   | `__TOKEN_FILE__` | 1 で作ったトークンのファイルの絶対パス                         |
   | `__LOG__`        | ログの出力先の絶対パス                                         |

   ```sh
   sed -e "s|__REPO__|<checkout のパス>|" \
       -e "s|__PATH__|<PATH>|" \
       -e "s|__URL__|<受付の URL>|" \
       -e "s|__TOKEN_FILE__|<トークンのファイル>|" \
       -e "s|__LOG__|<ログのパス>|g" \
       apps/working/mac-state/local.yunomi.working-mac-state.plist \
       > ~/Library/LaunchAgents/local.yunomi.working-mac-state.plist
   plutil -lint ~/Library/LaunchAgents/local.yunomi.working-mac-state.plist
   ```

4. 読み込む。読み込んだ時点で 1 回走る。

   ```sh
   launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/local.yunomi.working-mac-state.plist
   launchctl print "gui/$(id -u)/local.yunomi.working-mac-state" | grep -E 'state|last exit'
   ```

すぐに走らせ直すときは `launchctl kickstart "gui/$(id -u)/local.yunomi.working-mac-state"`、外すときは `launchctl bootout "gui/$(id -u)/local.yunomi.working-mac-state"` を使う。
