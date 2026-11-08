# apps/working/handoff

Working のコンテナで続けられない作業を、Mac が起きたときに Mac の agent が引き継ぐ。

## 流れ

1. Working の agent が作業ブランチを push し、対象リポジトリに label `working-handoff` の申し送り issue を立てて終える。
2. Mac の launchd が `mac/pickup.sh` を走らせる。ログイン時と、その後 10 分おきに走る。スリープ中に過ぎた回は起きた直後にまとめて 1 回走る。
3. `pickup.sh` は、未処理の申し送り issue ごとに Orca に worktree を作って agent を起動し、issue に label `working-handoff-picked` とコメントを付ける。issue に hishaku の番号があれば、agent に issue を読ませる代わりに `hs open` で Working の席の会話の続きを開く。

## 中身

| ファイル                                 | 役割                                                                                                                                           |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `prompt.md`                              | Working の CLI に渡す指示文の断片。引き継ぐときの手順（push、label の作成、issue の作成）を書く。渡すときは後ろに `issue-template.md` を続ける |
| `issue-template.md`                      | 申し送り issue の本文の雛形。対象リポジトリ、作業ブランチ、hishaku の番号、何をしたか、どこで詰まったか、次に何をするか                        |
| `mac/pickup.sh`                          | Mac 側で申し送りを集めて Orca に引き継ぐスクリプト                                                                                             |
| `mac/local.mizuya.working-handoff.plist` | launchd の plist の雛形                                                                                                                        |
| `mac/test/run.sh`                        | `gh`・`orca`・`git`・`hs` をモックにした `pickup.sh` のテスト（`pnpm --filter @mizuya/working-handoff test`）                                  |

## 引き継ぎの約束

申し送り issue は次を満たす。

- label `working-handoff` が付いている。label を付けられるのはリポジトリに書き込める人だけなので、これを引き継ぐ対象の印にする。
- 本文に `` - 作業ブランチ: `<branch>` `` の行がある（`issue-template.md` のまま）。ブランチは push 済みで、英数字と `._/-` だけの名前にする。
- issue は対象リポジトリに立てる。`pickup.sh` は issue のあるリポジトリを対象として扱う。
- Working の受付が hishaku の番号を取れた投稿では、本文に `` - hishaku の番号: `<4 桁>` `` の行がある。4 桁の数字でなければ番号なしとして扱う。

## pickup.sh の振る舞い

| 状況                                                                | 振る舞い                                                                                                    |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Orca が起動していない（`orca status` で runtime に届かない）        | 何もせず終える                                                                                              |
| issue に `working-handoff-picked` が付いている                      | 何もしない                                                                                                  |
| issue のリポジトリが Orca に登録されていない                        | 作らずにスキップし、ログに残す。登録すれば次の回で拾う                                                      |
| 作業ブランチの行が読めない                                          | 作らずにスキップし、ログに残す                                                                              |
| 同じ issue に紐づく worktree か、作業ブランチの worktree が既にある | 作らずに、印だけ付ける                                                                                      |
| issue に hishaku の番号があり、作業ブランチの worktree が既にある   | 作らずに `hs open` で開き直してから印を付ける。開けなければ印を付けず、次の回にまた開く                     |
| issue に hishaku の番号がある                                       | `origin/<branch>` を fetch し、agent を起こさずに worktree `hs-<番号>` を作り、`hs open` で開いて印を付ける |
| それ以外                                                            | `origin/<branch>` を fetch し、`orca worktree create` で worktree を作って agent を起動し、印を付ける       |

worktree は次の形で作る。名前は `handoff-<issue 番号>`、ブランチは作業ブランチと同じ名前にする。

```sh
orca worktree create --repo id:<Orca の repo id> --name handoff-<番号> \
  --base-branch origin/<作業ブランチ> --branch <作業ブランチ> --issue <番号> \
  --agent claude --prompt "申し送り issue <URL> を読んで続きをやって" --no-parent
```

hishaku の番号がある issue は次の形で開く。`hs open` は meta にブランチを持たないので、作業ブランチの worktree `hs-<番号>` を先に作っておき、`hs open` がそれを使って `hs resume <番号>` の端末を立てる。

```sh
orca worktree create --repo id:<Orca の repo id> --name hs-<hishaku の番号> \
  --base-branch origin/<作業ブランチ> --branch <作業ブランチ> --issue <番号> --no-parent
hs open -y <owner>/<repo> <hishaku の番号>
```

`hs` が PATH に無いか `HISHAKU_URL` が空なら、番号があっても agent に issue を読ませる今の動きにする。

Orca の repo は、`orca repo list` の `gitRemoteIdentity.canonicalKey`（`github.com/<owner>/<repo>`）で対応を取る。

環境変数で既定を変えられる。

| 変数              | 既定                                            |
| ----------------- | ----------------------------------------------- |
| `HANDOFF_OWNER`   | `ochanuco`（`gh search issues --owner` に渡す） |
| `HANDOFF_AGENT`   | `claude`                                        |
| `HANDOFF_DRY_RUN` | `0`（`1` で `--dry-run` と同じ）                |

`--dry-run` は、issue と Orca の一覧の読み取りだけを行い、fetch・worktree の作成・label とコメントの書き込みは実行せずにログへ表示する。

## Mac へのインストール

前提は、`gh` がログイン済みであること（`gh auth status`）、Orca の CLI `orca` が入っていること、`jq` があること（macOS 15 以降は `/usr/bin/jq`）。hishaku の番号で開くには `hs` も入れ、launchd の環境に `HISHAKU_URL`・`HISHAKU_ACCESS_CLIENT_ID`・`HISHAKU_ACCESS_CLIENT_SECRET`・`HISHAKU_HOLDER` を渡す（plist の `EnvironmentVariables` に足す）。

1. 一度 dry-run で走らせて、拾う issue と作る worktree を確かめる。

   ```sh
   apps/working/handoff/mac/pickup.sh --dry-run
   ```

2. plist の雛形のプレースホルダを埋めて `~/Library/LaunchAgents/` に置く。

   | プレースホルダ | 入れるもの                                                                                                               |
   | -------------- | ------------------------------------------------------------------------------------------------------------------------ |
   | `__REPO__`     | このリポジトリの checkout の絶対パス                                                                                     |
   | `__PATH__`     | `gh`・`orca`・`jq`・`git`・`hs` が見つかる PATH（`dirname "$(command -v gh)"` などで確かめる）。`/usr/bin:/bin` も含める |
   | `__LOG__`      | ログの出力先の絶対パス（例: `~/Library/Logs/` の下を絶対パスで）                                                         |

   ```sh
   sed -e "s|__REPO__|<checkout のパス>|" \
       -e "s|__PATH__|<PATH>|" \
       -e "s|__LOG__|<ログのパス>|g" \
       apps/working/handoff/mac/local.mizuya.working-handoff.plist \
       > ~/Library/LaunchAgents/local.mizuya.working-handoff.plist
   plutil -lint ~/Library/LaunchAgents/local.mizuya.working-handoff.plist
   ```

3. 読み込む。読み込んだ時点で 1 回走る。

   ```sh
   launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/local.mizuya.working-handoff.plist
   launchctl print "gui/$(id -u)/local.mizuya.working-handoff" | grep -E 'state|last exit'
   ```

すぐに走らせ直すときは `launchctl kickstart "gui/$(id -u)/local.mizuya.working-handoff"`、外すときは `launchctl bootout "gui/$(id -u)/local.mizuya.working-handoff"` を使う。
