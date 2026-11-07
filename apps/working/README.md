# apps/working

Working（仕事）を受け持つコンテナ。`orca serve`、Claude CLI、Codex CLI、Working 受付を 1 つの Linux コンテナで動かす。仕事フォーラムの投稿 1 件に Orca の席（worktree と、そこに居続ける CLI agent）を 1 つ付け、Yukarin の人格の Claude CLI か、Akarin の人格の Codex CLI で作業させる（「Akarin の席」の節）。受付は agent を自分で動かさず、Discord と Orca（`orca-ide orchestration`）の間で言葉を運ぶ。

記憶と人格の正本は yunomi（`ochanuco/yunomi`）にある。Working は yunomi の Worker の記憶の口（`/v1/partners/:partnerId/working/memory`）を HTTP で使い、人格の元ファイルは image の build で yunomi の `partners/` から取り込む（「人格」の節）。

## 中身

| ファイル                        | 役割                                                                                                                                                                                                                         |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Dockerfile`                    | Debian に Orca の Linux 版（`orca-ide`）、Claude CLI、Codex CLI（`CODEX_VERSION` で固定）、`gh`、mise と依存のビルドに要る OS のパッケージを入れる。人格の元ファイル、引き継ぎの指示、取り消せない操作を止める hook も入れる |
| `mise/config.toml`              | 席の既定の道具（node、pnpm、uv、jq）。`/etc/mise/config.toml` に置く                                                                                                                                                         |
| `persona.sh`                    | image に入れた人格の元ファイル `~/persona/<パートナー>`（引数、既定は `yukarin`）の `identity/*.md`・`profile.yaml`・`examples.yaml` を連結し、席の agent に渡す人格として標準出力に出す                                     |
| `compose.example.yaml`          | 常駐させるときの compose の雛形                                                                                                                                                                                              |
| `src/`                          | Working 受付（`@mizuya/working`）。mizuya の bot で Gateway から仕事チャンネルを読み、Worker の受け箱からボタンを受け、Discord REST と Orca の席で作業する                                                                   |
| `src/memory-cli/`               | 記憶の道具 `yunomi-memory`。Worker の Working の記憶の口を読み書きする。node の組み込みだけで書き、`/opt/yunomi-memory/` に置いて node で直接動かす                                                                          |
| `mac-state/`                    | Mac から Orca の席の状態を送るスクリプトと launchd の plist の雛形（[mac-state/README.md](mac-state/README.md)）                                                                                                             |
| `src/guard/`                    | Claude CLI の PreToolUse hook。道具を使う前に、聞かずに実行してよいかを決める。node の組み込みだけで書き、`/opt/mizuya-guard/` に置いて node で直接動かす                                                                    |
| `src/repo-map/`                 | 受付が chabatake の `repo-map.yaml` を取って `STATE_DIR` に写しを置く処理と、席の Claude の SessionStart hook。hook は node の組み込みだけで書き、`/opt/mizuya-repo-map/` に置いて node で直接動かす                         |
| `guard/managed-settings.json`   | hook を登録する Claude CLI の managed settings。`/etc/claude-code/` に置く                                                                                                                                                   |
| `guard/codex-requirements.toml` | 同じ hook を登録する Codex CLI の managed な要件。`/etc/codex/requirements.toml` に置く                                                                                                                                      |
| `start.sh`                      | コンテナの entrypoint。受付と、引数で渡したコマンド（`orca-ide serve …`）を並べて動かし、どちらかが終わればコンテナを終わらせる                                                                                              |
| `seat-env.sh`                   | start.sh が `orca-ide serve` をこれ越しに起動する。席の Claude は orca serve の環境変数を受け継ぐので、渡してよい変数だけに絞る                                                                                              |
| `release-orcad-lock.sh`         | `orca-ide serve` の前に start.sh が呼ぶ。前のコンテナの orcad が volume に残した `orcad.lock` を消す                                                                                                                         |

Orca の Linux 版は GitHub Releases（`stablyai/orca`）の `orca-ide_<版>_<arch>.deb` を使う。CLI の名前は `orca-ide` で、席の Claude が読む手順書が `orca` と書くので `/usr/local/bin/orca` を同じものに向けてある。版は `ORCA_VERSION` で Mac の Orca と揃える。

## volume

| volume                  | マウント先             | 残るもの                                                                                                                                                                                                                                                                                                              |
| ----------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mizuya-working-claude` | `/home/worker/.claude` | Claude CLI のログイン情報（`.credentials.json`）、設定（`.claude.json`）、セッション（`projects/`）                                                                                                                                                                                                                   |
| `mizuya-working-codex`  | `/home/worker/.codex`  | Codex CLI のログイン情報（`auth.json`）、設定（`config.toml`）、会話（`sessions/`）                                                                                                                                                                                                                                   |
| `mizuya-working-orca`   | `/home/worker/.config` | orcad の本体と状態、pairing 済みの端末                                                                                                                                                                                                                                                                                |
| `mizuya-working-state`  | `/home/worker/state`   | フォーラム投稿と席の対応、Orca の Run と受付の端末（`seats.json`）、許可を待っている操作（`approvals.json`）、止めた操作と許可の記録（`guard/`）、最後に届いた Mac の席の状態（`mac-state.json`）、活動ログの記録（`activity-log.jsonl`・`activity-log-state.json`）、記憶の口の接続情報（`memory-credentials.json`） |
| `mizuya-working-work`   | `/home/worker/work`    | 席の元にする空の git リポジトリ（`seats/`）と、席の worktree（`orca/workspaces/seats/seat-<投稿の ID>/`）。席の Claude はその中に clone する。mise が入れた道具（`.mise/`）、pnpm の store（`.pnpm-store/`）、uv のキャッシュと Python（`.cache/uv/`・`.uv/`）                                                        |

`CLAUDE_CONFIG_DIR` を `~/.claude` に向けているので、通常は `~/.claude.json` に置かれる設定も volume に入る。Orca は worktree を `~/orca/workspaces` に作るので、`~/orca` は `~/work/orca` への symlink にしてある。

## Working 受付

受付は mizuya の bot（`DISCORD_TOKEN`）で Discord の Gateway につなぎ、仕事テキストチャンネルと仕事フォーラムの投稿に書かれたメッセージを読む（Message Content intent）。人格の bot（`YUKARIN_DISCORD_TOKEN` / `AKARIN_DISCORD_TOKEN`）は REST だけで使い、Gateway にはつながない。webhook の発言は読まない。

席のメッセージに付けたボタンは、mizuya の application の Interactions Endpoint URL、つまり mizuya の Worker に届く。Worker はそれを受け箱に置き、受付は `MIZUYA_INBOX_URL`（`wss://mizuya.chanu.co/working/inbox`）に外向きの WebSocket でつないで受け取る。接続には Access の service token（`MIZUYA_ACCESS_CLIENT_ID` / `MIZUYA_ACCESS_CLIENT_SECRET`）と `Authorization: Bearer <MIZUYA_INBOX_TOKEN>` を付け、30 秒ごとに `ping` を送る。受け取った行は ack する。切れたら 1 秒から 60 秒まで間をのばしながらつなぎ直し、その間に置かれたボタンは次の接続で届く（押してから 15 分まで）。

`PORT`（既定は `8080`）の `GET /healthz` は生存確認用で、image の HEALTHCHECK が読む。

### 流れ

| 投稿で起きること                                                              | 受付がやること                                                                                       |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 新しい投稿（仕事チャンネルの依頼から立てたものも）                            | 席を作り（`worker-start`）、依頼を渡す。タグは `作業中`                                              |
| 投稿への返事                                                                  | その席に渡す（`send`）。作業中なら席のターンの終わりに届く                                           |
| 席の質問（`ask`）、取り消せない操作で止まったとき                             | 投稿に書いてタグを `決めてほしい` にし、返事を答えとして返す（`reply`）                              |
| 席の途中経過（`send --type status`）                                          | そのまま投稿に書く。状態とタグは変えない                                                             |
| 席が裏の作業を待っている間に投稿に書く                                        | すぐ「作業中です。（最後の途中経過）」と返し、書き込みは席に渡す                                     |
| 席の返事（`ask`・`worker_done`・`status`）に `添付:` や `chimera:` の行がある | 行を本文から外し、席のファイルや chimera の元の画像を投稿に付ける                                    |
| 投稿に「起動し直して」と書く                                                  | 席の Claude を止め、同じ worktree で `--continue` で起こす（コネクタの認証を足したあとなどに使う）   |
| 席の完了報告（`worker_done`）                                                 | 投稿に書いてタグを `完了` にし、記憶に 1 行残し、席を閉じる                                          |
| 完了のあとにまた書く                                                          | 同じ投稿に新しい席を作り、これまでのやりとり（最大 100 件）を渡す                                    |
| Mac でやる必要がある                                                          | 席が申し送り issue を書いて報告する。タグを `引き継ぎ` にし、席を閉じる                              |
| 見張りを頼まれた                                                              | 席が見張りを登録して報告する。タグを `見張り中` にし、席を閉じる。新着は朝会と見回りがこの投稿に書く |

- 仕事テキストチャンネルで Yukarin か Akarin 宛て（「Akarin の席」の節）の依頼が来たら、仕事フォーラムに投稿を立てる。件名は依頼の要約（Claude CLI の haiku で作る。前置きやメタ発言、複数行、40 字超の出力は使わず、依頼の 1 行目にする）、本文は元の依頼と元メッセージへのリンク。テキストチャンネルには投稿へのリンクを返信で返す。
- 同じ投稿への発言と席からのメッセージは、1 件ずつ順に処理する。
- Discord REST が 2xx 以外を返したときは、経路・ステータス・Discord のエラーコードとメッセージを warn で残す。bot の権限不足（403 の Missing Access / Missing Permissions）は `PermissionDenied` として扱う。
- `WORKING_OWNER_DISCORD_USER_IDS` に入っている人の発言だけを扱う。mizuya の bot と人格の bot、ほかの人、ほかの bot の発言は、依頼・フォーラムの投稿・投稿内の返事のどれでも無視する。

### 席

- 受付は起動時に、`SEATS_REPO`（既定は `~/work/seats`）に空の git リポジトリを用意して Orca に登録し、その root に受付の端末（`受付`、中身は `sleep infinity`）を作る。orchestration の送り手と受け手はこの端末になる。Run は `seats.json` に残し、作り直した端末で引き継ぐ（`run-use`）。
- 席は投稿ごとに作る。`worktree create` で `seat-<投稿の ID>` の worktree を作り、その realpath を Claude CLI の信頼済みの場所（`.claude.json` の `projects[<realpath>].hasTrustDialogAccepted`）に登録してから、その worktree に `claude --permission-mode auto` の端末を作り、15 秒待ってから `worker-start --terminal` で依頼を渡す。待つのは、claude.ai のコネクタ（chimera など）が Claude の起動から遅れて読み込まれ、すぐに渡すと最初のターンに間に合わないため。信頼していない場所の Claude は確認の画面で止まり、Orca は席を始めない。登録は Claude CLI と同じ `.claude.json.lock` のロックを取って書くので、動いている席の Claude の書き込みと混ざらない。10 秒より古いロック（落ちたプロセスの残り）は外して進む。hook は worktree の名前から投稿を引く。Mac の Orca から接続すると、同じ席と Claude の画面が見える。
- 席を始められなかったときは、止まった所（作業場所の確認、Claude の起動、Orca の席の作成など）を短く投稿に書く。
- 受付は `orchestration check --wait` で席からのメッセージを待ち続ける。受付が落ちている間に届いたものも、次に起動したときに受け取る。
- 席の Claude が `worker_done` を送らずにターンを終えたとき、Orca の知らせ（escalation）に付く端末の末尾に裏で動いている shell やタスク（「1 shell still running」など）が出ていれば、待っているだけとみなして投稿に書かない。それ以外は「作業が途中で止まりました」と書いて `決めてほしい` にする。
- 裏の作業を待っている席の投稿に持ち主が書くと、受付はすぐ「作業中です。（いまやっていること）」と返す。いまやっていることは席の Claude が最後に送った途中経過（`status`）で、改行を詰めて 200 字で切る。無ければ「作業中です。」だけにする。書き込みは、手が空いたら `status` で答えるよう添えて席に渡す。席が質問か報告を送るか、裏の作業なしでターンを終えるまで、この即答を続ける。
- 「起動し直して」「再起動して」（全角・末尾の句点は許す）だけの返事は、席の Claude への返事にせず起動し直す。席が無ければふつうの返事として扱う。
- 同時に Claude を動かしておく席は `SEAT_LIMIT`（既定は 6）まで。上限を超えた投稿には「順番待ち」と書き、空いたら古い順に始める。止めた席と順番待ちの席は数えない。
- `決めてほしい` のまま `SEAT_SLEEP_AFTER_MINUTES`（既定は 120 分）たった席は、Claude だけ止める（worktree と会話は残す）。返事が来たら、その worktree で `claude --permission-mode auto --continue` の端末を作って `worker-start --terminal` で渡し、前の会話のまま起こす。worktree が無くなっていたら、その席は忘れ、投稿のやりとりを読ませた新しい席で始める。
- 席を閉じるときは、席の Claude を止め、worktree を消す。席の Claude には、完了にする前に commit と push を済ませるよう指示してある。
- 起動時に `seats.json` と Orca の席を突き合わせる。対応表に無い席の端末と worktree（前回の残り）は片付け、対応表にある席は残す。Claude がいなくなっていた席は止めた扱いにし、作業中だったなら投稿で知らせて `決めてほしい` にする。

### Akarin の席

受付は Akarin 宛ての依頼に Akarin の席を作る。Discord には mizuya の bot 1 つで出るので、宛先は role で決める。

- 依頼（仕事テキストチャンネルの発言、フォーラムの新しい投稿）で role `あかり`（`AKARIN_ROLE_ID`）か、あかりんの bot がメンションされていれば Akarin の席を作る。フォーラムの新しい投稿は、それ以外なら Yukarin の席。
- 仕事テキストチャンネルでは、role `ゆかり`（`YUKARIN_ROLE_ID`）、ゆかりんの bot、mizuya の bot のどれかへのメンションで Yukarin 宛てになる。`あかり` と両方なら Akarin。メンションが無ければ、返信した先が人格の bot の発言ならその席宛て。それ以外は依頼とみなさない。
- 投稿の担当は席を作るときに決めて `seats.json` の `partners` に残す。投稿への返事、止めた席を起こすとき、完了のあとにまた書いたときも、同じ担当が受ける。
- 人格の作業は担当の席の人格の bot（ゆかりん・あかりん）、システムの介入は mizuya の bot で書く。人格の bot が書くのは、席の返事、投稿（朝会・見回り・GitHub の出来事・活動ログを含む）、タグ、リアクション、入力中の表示。mizuya の bot が書くのは、状態の欄と、許可・却下・不要のボタンが付いたメッセージ。ボタンは、それを求める人格の発言のすぐ後に、押し方を添えて出す。ボタンの custom_id には `working:` を頭に付け、mizuya の Worker がこれで受け箱に回す。
- 投稿の最初の人格の発言では、依頼者にメンションして通知する。仕事テキストチャンネルの依頼から立てた投稿は「<依頼者> さんからの依頼」の発言、フォーラムに直接立てた投稿は席の最初の返事、朝会・見回り・GitHub の出来事の投稿は最初の発言で持ち主（`WORKING_OWNER_DISCORD_USER_IDS` の先頭）にメンションする。通知するのはその人だけ。
- タグ・リアクション・入力中の表示・読み取りは mizuya の bot で行う。
- Akarin の席は Codex CLI で動き、前置きの人格は `persona.sh akarin`、記憶の読み書きは Akarin の記憶（`/v1/partners/akarin/working/memory`）にする。
- Codex は `codex -a never -s danger-full-access` で起動する。止めた席は同じ worktree で `codex resume --last` で起こす。Codex の `resume --last` は作業ディレクトリの最新の会話を選ぶので、投稿ごとの worktree で前の会話のまま続く。
- Codex は worktree の信頼を元のリポジトリで引く。受付は起動時に、席の元のリポジトリ（`SEATS_REPO` の realpath）を `CODEX_HOME/config.toml` の `[projects."<path>"]` に `trust_level = "trusted"` で足す（表が無いときだけ）。
- 朝会は Yukarin だけが行う。

### タグ

フォーラムに `決めてほしい`・`作業中`・`引き継ぎ`・`完了`・`見張り中` のタグを作っておく。受付は名前で ID を引く。席を作るときと席に返事を渡すときに `作業中` を付け、席の質問で `決めてほしい` にする。完了報告では本文の最後の行（`状態: …`、投稿には出さない）に合わせて付け替え、書かれていなければ `決めてほしい` にする。人が付けたほかのタグは残す。

### 作業中かの見せ方

- 席の Claude が動いている間（席の状態が `working`）、投稿に入力中の表示を約 8 秒おきに送る。止まったら送らない。
- 持ち主の依頼メッセージ（仕事チャンネルの依頼、投稿の最初のメッセージ、投稿への返事）に bot のリアクションを付ける。受付 👀、作業中 ⏳、完了 ✅、決めてほしい・引き継ぎ ❓。状態が変わると前の絵文字を外して付け替え、持ち主が新しく書くとそのメッセージに移す。
- 席を作るとき投稿に bot のメッセージを 1 件置き、状態の欄にする。状態、作業中なら経過時間（いまの状態になってから）といまやっていること（席の最後の途中経過）を書く。内容が変わったときだけ書き換え、経過時間だけの変化は最短 5 分おき。
- 席ごとの作業中の数と CLI の使用率は、mizuya の bot には出さない。そのパートナーの bot を動かす yunomi の gateway が、席の状態を渡す口から読んで自分のステータスと自己紹介欄に出す。朝会の席は数えない。
- 使用率はパートナーの席で動く CLI のサブスクリプションの使用率で、Yukarin は Claude、Akarin は Codex。
  - 5 分おきに読む。Claude は `~/.claude/.credentials.json`（`CLAUDE_CONFIG_DIR` があればその中）のトークンで `https://api.anthropic.com/api/oauth/usage` を読む。Claude Code の `/usage` と同じ非公開の API。トークンの期限が切れていれば読まず、自分では更新しない（席の Claude が動けば CLI が更新する）。
  - Codex は `codex app-server` を起こして `account/rateLimits/read` を呼ぶ。primary が 5 時間枠、secondary が週枠。Akarin の席が無効なら読まない。
  - 一度読めなくても最後の値を 15 分残し、それより古くなったら載せない。

### 席の Claude に渡すもの

新しい席の spec は、`persona.sh` の出力、仕事のしかた（`src/prompts.ts` の `WORKING_INSTRUCTIONS`）、Mac への引き継ぎの手順（`handoff/prompt.md`）、申し送りの雛形（`handoff/issue-template.md`）を連結した前置きに、投稿で頼まれたこと（完了のあとなら投稿のこれまでのやりとり）を続けたもの。Orca は orchestration の手順書を spec の前に足す。

仕事のしかたには、投稿への返事は `worker_done` の本文に書くこと、途中で聞きたいことは `ask` で聞くこと、本文の最後の行に状態を書くことを入れてある。

### 関連リポジトリセット

席の Claude は、セッションの始まりに、手元のリポジトリを含むセットを chabatake の `repo-map.yaml` から `## 関連リポジトリセット: <セット名> — <説明>` の見出しと 1 リポジトリ 1 行で受け取る。Mac の SessionStart hook と同じ書式で、手元に clone があればその場所を `<…>` で添える。

- 手元のリポジトリは、作業ディレクトリそのものと、その直下の clone。どれも origin の URL の最後の要素を名前にする。
- 受付は起動時と 1 時間ごとに、`GH_TOKEN` で chabatake の main の `repo-map.yaml` を取り、検証して `STATE_DIR/repo-map.json` に置き換える。hook（`src/repo-map/hook.ts`、managed settings の SessionStart）はこの写しだけを読み、席を起動するたびに GitHub へは行かない。
- 取れなかったときや中身が不正なときは、前の写しをそのまま使う。写しが無ければ何も出さない。

### 席の返事の添付

席の Claude が `ask`・`worker_done`・`status` の本文に次の行を書くと、受付は行を本文から外し、ファイルを投稿のメッセージに付ける。コードブロックの中の行は本文のまま残す。`worker_done` の状態の行は、添付の行を外したあとの最後の行として読む。

| 行                       | 付けるもの                                          |
| ------------------------ | --------------------------------------------------- |
| `添付: out/<ファイル名>` | 席の worktree の直下の `out/` にあるファイル        |
| `chimera: <short_id>`    | chimera の `/g/<short_id>/image` から取った元の PNG |

- `out/` の外のパス（絶対パス、`..` で外に出るもの）と、実体が worktree の `out/` の外にあるシンボリックリンクは付けない。
- Discord の上限（1 件に 10 個、1 ファイル 10 MB、1 件の合計 24 MB）を超えるもの、無いファイル、取れなかった画像は付けず、本文の最後に「添付できなかったもの」として理由と一緒に書く。同じ名前のファイルには番号を付ける。
- chimera は Cloudflare Access の後ろにある。受付は `CHIMERA_ACCESS_CLIENT_ID` / `CHIMERA_ACCESS_CLIENT_SECRET` を `CF-Access-Client-Id` / `CF-Access-Client-Secret` に載せ、User-Agent（`mizuya-working/1.0`）を明示して取る。転送（Access のログイン画面）や画像でない応答は失敗として扱う。`CHIMERA_URL` と service token のどれかが欠けていれば、`chimera:` の行は「受付に chimera の設定が無い」と書く。
- 使い方は `WORKING_INSTRUCTIONS` に書いてある（chimera で描いたら short_id を返事に書く）。

### 席の Claude の権限

席の Claude は、持ち主が手元で使うセッションと同じく Claude Code の auto モード（`--permission-mode auto`）で動く。取り消せない操作や外に出る操作を止めるかは、Claude Code の自動の判定が決める。席に話しかけられるのは持ち主だけ（`WORKING_OWNER_DISCORD_USER_IDS`）なので、投稿で明示的に頼んだ操作は持ち主の意思として扱われ、main への push やマージも聞かずに実行される。`main` への push やマージを止めたいときは、GitHub のブランチ保護とトークンの権限で止める。

managed settings（`/etc/claude-code/managed-settings.json`、root の持ち物）で次を決める。作業場所の `.claude/settings.json` や Claude CLI 自身の書き換えでは外せない。

- PreToolUse hook（`src/guard/hook.ts`）: 秘密情報の読み出し（`printenv`、トークンの変数、`gh auth token`、`~/.claude`・`~/.config`・`STATE_DIR`・`.credentials.json` など）と、秘密情報や許可の記録の場所への書き込みを止める。Claude CLI が大きな道具の応答を書き出す `~/.claude/projects/<場所>/<セッション>/tool-results/` は、読むだけなら止めない。持ち主が投稿で許可した操作は、auto モードの判定によらず 1 回だけ通す。それ以外は何も返さず auto モードに任せる。
- PermissionDenied hook（同じ `hook.ts`）: auto モードが止めた操作を、その投稿に紐づけて記録する。受付が質問に書き添える。
- SessionStart hook（`src/repo-map/hook.ts`）: 手元のリポジトリを含む関連リポジトリセットを出す（「関連リポジトリセット」の節）。
- `autoMode.allow`: `ochanuco/*` の PR のマージを、auto モードの既定の「Merge Without Review」の対象から外す。持ち主ひとりで回していて approve する人がいないため。持ち主が頼んだマージか、席が頼まれた作業のために開いた PR に限る。`--admin` での必須チェックの回避は外さない。
- `ENABLE_TOOL_SEARCH=false`: MCP の道具を遅延読み込みせず、最初から読み込む。席の Claude は `ToolSearch` を使わずに chimera などの道具を呼べる。

hook は席の場所（`CLAUDE_PROJECT_DIR`）で、止めた操作の紐づけ先をその投稿にする。

席の Claude は `orca-ide serve` の環境変数を受け継ぐ。start.sh は `seat-env.sh` で、`HOME`・`PATH`・`GH_TOKEN`・`GIT_AUTHOR_*` / `GIT_COMMITTER_*` などと、hook が使う `MIZUYA_STATE_DIR`・`MIZUYA_SEATS_DIR`、mise・uv・pnpm の置き場所だけを渡して起動する。Discord のトークン、受け箱の token と service token、`MAC_STATE_TOKEN`・`SEAT_STATUS_TOKEN`、記憶の口と chimera の service token は渡さない。

### 席の Codex の権限

持ち主の方針（都度許可を求めない、手元と同じものが見える）に合わせ、席の Codex は承認なし（`approval_policy = never`）・sandbox なし（`sandbox_mode = danger-full-access`）で動く。worktree への書き込み、ネットワーク、`git push`、`gh` を聞かずに実行する。コンテナが外側の囲いになる。Codex の sandbox（bubblewrap）は使わない。

- `/etc/codex/requirements.toml`（root の持ち物）で、Claude CLI と同じ PreToolUse hook（`src/guard/hook.ts`）と SessionStart hook（`src/repo-map/hook.ts`）を managed hook として登録し、`allow_managed_hooks_only = true` で作業場所や `CODEX_HOME` の hook を読ませない。managed hook は信頼の確認なしで動く。
- PreToolUse hook は、Claude の席と同じく秘密情報の読み出し（`~/.codex` の `auth.json` を含む）と、秘密情報や許可の記録の場所への書き込み（`apply_patch` でのファイルの書き換えを含む）を止める。止めた操作の許可の流れは Claude の席と同じ。Codex には auto モードの判定が無いので、取り消せない操作の前に聞くのは `WORKING_INSTRUCTIONS` の指示による。
- Codex は CLAUDE_PROJECT_DIR を持たないので、hook は入力の `cwd` から席の投稿を引く。
- 受付は起動のたびに、`CODEX_HOME/config.toml` の MCP サーバー `playwright`（代理操作するブラウザ）を書き直す。席の環境変数には秘密を渡さないので、Access のヘッダーは値のまま書く。`~/.codex` は hook が読み出しを止める。`PLAYWRIGHT_*` が欠けていれば表を消す。
- 環境変数は Claude の席と同じく `seat-env.sh` が絞ったものだけを受け継ぐ（`CODEX_HOME` を足してある）。Codex は既定でコマンドに環境変数をそのまま渡すので、`GH_TOKEN` は `gh` と `git push` に届く。

### 席のビルドとテスト

席の `PATH` の先頭には mise の shims（`~/work/.mise/shims`）がある。clone したリポジトリで `mise install` を実行すると、そのリポジトリの `mise.toml`（または `.tool-versions`）の道具と、`/etc/mise/config.toml` の既定の道具（node 24、pnpm 10、uv、jq、takt）が入る。`mise.toml` を持たないリポジトリでも既定の道具で `pnpm install` や `uv sync` を回せる。

- 道具とダウンロードのキャッシュは work の volume に置くので、コンテナを作り直しても入れ直さない。
- `~/work` の下の `mise.toml` は信頼済みとして扱う（`MISE_TRUSTED_CONFIG_PATHS`）。`mise trust` は要らない。
- C 拡張や node-gyp のビルドに使う `build-essential`・`python3`・`pkg-config` と、opencv-python が読む `libgl1`・`libglib2.0-0` を入れてある。
- 受付（start.sh が起動する node）の `PATH` には shims を足さない。受付はイメージの node 24 で動く。
- TAKT のグローバル設定（`apps/working/takt/` → `~/.takt/`）は provider を `claude-sdk`、model を `sonnet` にしてあり、席の claude のログインで動く。`claude-sdk` の SDK はビルド時に `~/.takt` へ入れる。workflow は、リポジトリの `.takt/workflows/`、`~/.takt/workflows/`、組み込みの順に探される。
- TAKT が起動する claude は Bash の承認に答えられず、テストを実行できない。テストはリポジトリの `.takt/config.yaml` の command gate（`workflow_overrides` の `type: command`）で TAKT に実行させ、落ちれば実装の step に差し戻させる。席の Claude は、ゲートのあるリポジトリでだけ TAKT を使う（`WORKING_INSTRUCTIONS`）。

### 記憶の道具

席の Claude は `yunomi-memory` で、Talking と共有する長い記憶を読み書きする。受付も、席が完了したときと Mac に引き継いだときに 1 行残す。決まったことと終わったことは、そのつど 1 件 1 行ずつ残すよう `WORKING_INSTRUCTIONS` に書いてある。

```sh
yunomi-memory read                                         # 事実・出来事・open loop・目標・見張りを JSON で出す
yunomi-memory write --kind decided --summary "<1行の要約>"  # 決まったこと
yunomi-memory write --kind done --summary "<1行の要約>"     # 終わったこと
yunomi-memory write --kind goal --summary "<1行の目標>"     # 持ち主の目標。id を返す
yunomi-memory close --id <目標の id> --status achieved      # 目標を閉じる（やめたら dropped）
yunomi-memory watch-add --query "<何を>" --source "<どこを>" --interval-hours 6 --until "2026-12-31T23:59:00+09:00"  # 見張りを足す。id と登録した内容を出す
yunomi-memory watch-stop --id <見張りの id>                  # 見張りを止める
yunomi-memory watch-checked --id <見張りの id> --seen "<key>" --partner <パートナー>  # 見張りを調べ終えた。--seen は知らせたもの（0 件以上）。--partner は見張りを持つパートナー（省くと YUNOMI_PARTNER か既定）
```

- 呼ぶ先は yunomi の Worker の `/v1/partners/<パートナー>/working/memory`。パートナーは環境変数 `YUNOMI_PARTNER`（Akarin の席の Codex がコマンドに渡す）、無ければ `yukarin`。受付が完了のときに残す 1 行も、担当のパートナーの記憶に書く。記憶の持ち主は `WORKING_OWNER_DISCORD_USER_IDS` の先頭の人。
- 受付は起動時に `YUNOMI_URL` と `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` を `STATE_DIR/memory-credentials.json`（権限 600）に書き、`yunomi-memory` はそこから読む。service token は席の Claude の環境変数に載せず、標準出力にも標準エラーにも出さない。3 つのどれかが欠けていれば、ファイルを消して記憶の道具を使えなくする。
- `summary` は改行を含まない 200 字以内。
- `watch-add` の項目と検証は Talking の道具 `watch_add` と同じ。`--query` は改行を含まない 200 字以内、`--source` は店やサイトの名前か URL で 1 件 300 字以内・5 件まで（省くと普通の検索）、`--interval-hours` は 2 〜 168 の整数（省くと 24）、`--until` はタイムゾーン付きの ISO 8601（省くと期限なし）。日時の形と過去の期限は Worker が弾き、理由を標準エラーに出す。同じ `--query` の見張りがあるときと、動いている見張りが 10 件あるときは 409 で足さない。

### 席の状態の受け口

Mac の Orca の worktree と agent の一覧を、`MAC_STATE_PORT`（既定は `8090`）の `POST /mac-state` で受ける。`MAC_STATE_TOKEN` を設定したときだけ待ち受ける。

- `Authorization: Bearer <MAC_STATE_TOKEN>` が合わなければ 401。受け箱の `MIZUYA_INBOX_TOKEN` とは別のトークンにする。
- 本文は `mac-state/send.sh` が作る要約（`sent_at` と `worktrees`）。形が違えば 400。
- 受け取った最新の 1 件を、受け取った時刻と一緒に `STATE_DIR/mac-state.json` に置き換えて残す。Mac が寝ていても、朝会は最後に届いたものを読む。

### 席の状態を渡す口

`SEAT_STATUS_PORT`（既定は `8091`）の `GET /seat-status/<yukarin | akarin>` で、その席の作業中の数と使用率を返す。`SEAT_STATUS_TOKEN` を設定したときだけ待ち受ける。

- `Authorization: Bearer <SEAT_STATUS_TOKEN>` が合わなければ 401。ほかの口とは別のトークンにする。
- 本文は `{ "working": 2, "usage": { "five_hour": { "used_percent": 32, "resets_at_ms": <UNIX ミリ秒 | null> }, "weekly": { ... } } }`。使用率が読めていなければ `usage` は `null`。

### 朝会

受付は毎日（曜日も祝日も見ない）の `STANDUP_TIME`（既定は `09:00`、Asia/Tokyo）に朝会をする。`STANDUP_ENABLED=false` で止める。

1. 材料を集める。記憶（`yunomi-memory read`）とその中の持ち主の目標、最後に届いた席の状態と届いた時刻、GitHub（`STANDUP_GITHUB_OWNER` の open な PR、CI が落ちている PR、label `working-handoff` の申し送り、`GH_TOKEN` の人が `dev/` ブランチから出した PR、Renovate の PR と、その CI・コンフリクトの状態）、Claude CLI のログインの期限（`claude auth status` の `loginExpiresAt`）。取れなかったものは、取れなかったと書いて渡す。
2. ログインの期限が 7 日以内なら、席の返事を待たずに 1 件投稿する。
3. 朝会の席（`seat-standup-<ID>`）を作って材料を渡す。席の Claude は取り消せること（調べる、コメントする、`dev/` ブランチで直す、記憶に残す）をその場で済ませ、決めてほしいことだけを `worker_done` の本文に JSON で返す。朝会の席は持ち主に聞かない（`ask` には受付が「聞けない」と答える）。上限の数には入れず、決めてほしいままでも止めない。
4. 決めてほしいこと 1 件ごとに、仕事フォーラムへ投稿を立ててタグ `決めてほしい` を付ける。hook が止めた操作があれば 1 件の投稿にまとめ、その投稿で許可を待つ。朝会の席は報告を受けたら閉じる。
5. 決めてほしいことが無ければ何も投稿しない。

Renovate の PR は持ち主の許しで、朝会と見回りの席が片付ける。CI が通っていてマージできる（`mergeStateStatus` が `CLEAN`）ものはマージし、コンフリクトしているものは rebase のチェックボックスで Renovate に作り直させ、それでも直らなければ同じブランチでコンフリクトを解いて push する（次の回でマージする）。Renovate を入れる最初の PR（`renovate/configure`）と draft は触らない。マージが auto モードに止められたら、ほかの止めた操作と同じく許可を求める投稿になる。

### 見張り

持ち主が会話で頼んだ見張り（yunomi の Worker の README の「見張り」）と、仕事の投稿で頼まれて席が `yunomi-memory watch-add` で足した見張りは、朝会と見回りの席が調べる。

- 記憶の `watches` のうち `due`（前に調べてから間隔が過ぎた、まだ調べていない）のものだけを `due_watches` として席に渡す。見回りは GitHub に変わりが無くても、時間が来た見張りがあれば席を立てる。どちらも無い回は席を立てない。
- 席は持ち主に確認せず、WebSearch と WebFetch で調べる（auto モードが通す読み取り）。URL の場所は検索よりそのページを直接読む。
- 条件に合うもののうち `seen` に無いものだけを新着とし、`worker_done` の JSON の `notices` に見張りの id と 1 行の本文で返す。新着が無ければ何も書かない。
- 受付は新着を書く先ごとにまとめて 1 件のメッセージで書く。席が仕事の投稿で足した見張りは、`yunomi-memory watch-add` が席の作業場所から読んだ投稿（記憶の `notify_thread_id`）に書く。会話で頼まれた見張りと、受付が再起動して書く先を忘れた回は `WORK_TEXT_CHANNEL_ID` のチャンネルに書く。書けなければ 10 秒後と 60 秒後にやり直す。
- 朝会と見回りは Yukarin と Akarin の両方の記憶から時間が来た見張りを読み、見張りごとに持ち主のパートナー（`partner`）を付けて席に渡す。
- 席は見張りを 1 件調べ終えるたびに `yunomi-memory watch-checked --partner <partner>` で知らせたものの key を残す。残さなかった見張りは `due` のままなので、次の回で調べ直す。

朝会と見回りの席には、目標に効く提案があれば決めてほしいこととして出すよう頼んである。材料に根拠があるときだけで、無い回は出さない。

朝会と見回りの投稿に返事をすると、その投稿に新しい席を作り、投稿の本文と返事を渡して続ける。

朝会と見回りの始まり・終わり（決めてほしいことの件数、立てた投稿、投稿に失敗した数）と、材料を取れなかったことはログに残る。

### 見回り

朝会の合間に、受付は `HEARTBEAT_INTERVAL_MINUTES`（既定は 120 分）ごとに見回る。`HEARTBEAT_ENABLED=false` で止め、朝会だけにする。

- 1 回が終わってから次を予約する。Yukarin の profile の `living_rhythm.typical_sleep`（寝ている時間帯）に入る回は、起きる時刻まで飛ばす。朝会の前の間隔の半分以内に入る回は、朝会にまとめる。
- 材料は朝会と同じものを集める。持ち主の目標と GitHub の件（open な PR、CI が落ちている PR、申し送り、`dev/` ブランチの PR、Renovate の PR）を前の回と比べ、新しく出た件と状態が変わった件だけを拾う。目標は新しく足されたものだけを拾い、閉じて消えたものは拾わない。前の回に見たものは `STATE_DIR/patrol-state.json` に残す。朝会も同じものを残すので、朝会で見た件は見回りで拾い直さない。
- 状態として比べるのは draft かどうか、申し送りが拾われたかどうか、Renovate の PR の CI・コンフリクト・マージの状態だけ。コメントで動く更新時刻は比べないので、席が PR にコメントしても次の回で拾い直さない。
- 変わった件が無い回は席を作らず、何も投稿しない。初めての回は前の回が無いので、覚えるだけにする。
- 変わった件があれば、見回りの席（`seat-patrol-<ID>`）に変わった件と記憶、席の状態を渡す。席の扱いと投稿のしかたは朝会と同じで、投稿の最後には見回りの時刻が付く。ログインの期限は朝会だけが投稿する。
- 取れなかった材料は前の回に見たものを残すので、次に取れたときに全部を新しい件とは見ない。

### 活動ログ

`ACTIVITY_LOG_THREAD_ID` を設定すると、受付は毎日 `ACTIVITY_LOG_TIME`（既定は `23:30`、Asia/Tokyo）に、前の回からその時刻までに席がしたことを、そのスレッドへ Yukarin の bot で 1 投稿にまとめる。設定しなければまとめない。

- 席が完了・引き継ぎで閉じたときと、hook が止めた操作の許可を求めたとき（朝会・見回り・GitHub の知らせの席が止められた操作の投稿を含む）に、受付が `STATE_DIR/activity-log.jsonl` に 1 行ずつ残す。行には投稿の件名、担当、止めた道具の名前だけを書き、コマンドの本文や席の出力は残さない。
- 投稿には、終えた仕事、Mac に引き継いだ仕事、止められた操作（投稿ごとに道具の名前と件数）、Working が出した PR（`GH_TOKEN` の人が `STANDUP_GITHUB_OWNER` の repo に `dev/` ブランチから出したもの）のうち、その範囲でマージされたものと新しく出したものを並べる。
- 何もなかった日は投稿しない。まとめ終えた時刻は `STATE_DIR/activity-log-state.json` に残し、それより前の行は消す。初めての回は 24 時間前から見る。受付が落ちていて回を飛ばしたら、次の回に前の回からの分をまとめる。
- 投稿に失敗した回と、PR を取れず席の記録も無かった回は、まとめ終えたと残さず、次の回に同じ範囲を見直す。

### GitHub の出来事

CI の失敗、PR のレビュー、issue と PR のコメントがあると、見回りの時刻を待たずに小さな席を立てる。受付は公開していないので、GitHub の webhook は mizuya の Worker が受けて受け箱に置き（mizuya の README の「Working の受け箱」）、受付はボタンと同じ WebSocket で受け取る。届いてから 30 秒待ち、その間に届いた分をまとめて回す。朝会が有効なときだけ動き、無効なら受け取って捨てる。

- 自分（`GH_TOKEN` の持ち主。起動時に `gh api user` で引く）と bot のコメント・レビューでは席を立てない。
- CI の失敗は、見回りが同じ PR の失敗をもう見ていれば拾わない。拾った失敗は `patrol-state.json` の `failing_prs` に足すので、次の見回りでも拾い直さない。見回りと同じ列で回し、`patrol-state.json` を取り合わない。
- 同じ PR や issue の出来事は 1 つの席（`seat-event-<ID>`）にまとめ、その件の出来事だけを渡す。席の扱いと投稿のしかたは見回りと同じで、判断が要るものだけを仕事フォーラムに投稿する。投稿の最後には「GitHub の知らせ」の時刻が付く。
- 受付が止まっていて 6 時間より古くなった出来事は、Worker が渡さない。その件は見回りが拾う。

### 取り消せない操作の許可

1. hook と auto モードが止めた操作は `STATE_DIR/guard/pending/` に投稿ごとに残る。席の Claude は止められると `ask` で許可を求める。受付は席から質問か報告が届くとそれを取り出し、席の言葉に続けて「決めてほしいこと」としてコマンドそのものを投稿に書き、タグを `決めてほしい` にする。止めた操作が残っていれば、完了の報告でも完了にしない。
2. 「決めてほしいこと」のすぐ後に、mizuya の bot が「許可」と「却下」のボタンの付いたメッセージを出す（朝会と見回りでは投稿の最初のメッセージの後）。持ち主（`WORKING_OWNER_DISCORD_USER_IDS`）が押したときだけ効き、ほかの人が押しても何も起きない。
   - 持ち主がその投稿に `OK`・`許可`・`許可します` のどれか（全角・末尾の句点は許す）だけを返しても許可になる。返信の形で送るときは「決めてほしいこと」かボタンのメッセージへの返信にする。ほかの返事が来たら、待っていた操作は取りやめる。
   - ボタンでも返事でも、片付いた時点で待っていた操作を消し、ボタンのメッセージのボタンを外して頼みの文を「許可済み」か「却下済み」に書き換える。二度押しや、ボタンを押したあとの返事では重ねて許可しない。
   - 却下のボタンでは席を起こさない。続きは返事で頼む。
3. 許可すると、受付はその操作を `STATE_DIR/guard/grants/<投稿の ID>.json` に書き、許可したことを席への答えにする。hook はその投稿の席でだけ、同じ道具・同じ内容（Bash 以外はキーの順によらない引数の JSON）の操作を、auto モードの判定によらず 1 回だけ通す。席から次の質問か報告が届いた時点で、使わなかった許可は失効し、次に同じ操作をするとまた止まる。

止めた・聞いた・許可した・使った・失効した・取りやめたの記録は `STATE_DIR/guard/log.jsonl` に 1 行ずつ残る。

### 環境変数

| 変数                                                              | 必須   | 内容                                                                                                                        |
| ----------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------- |
| `DISCORD_TOKEN`                                                   | はい   | mizuya の bot トークン。Gateway での受信、状態の欄、ボタンに使う                                                            |
| `YUKARIN_DISCORD_TOKEN`                                           | はい   | ゆかりんの bot トークン。Yukarin の席の発言・投稿・リアクション・入力中の表示に REST で使う                                 |
| `AKARIN_DISCORD_TOKEN`                                            | いいえ | あかりんの bot トークン。無ければ Akarin の席を作らず、Akarin 宛ての依頼も Yukarin が受ける                                 |
| `YUKARIN_ROLE_ID` / `AKARIN_ROLE_ID`                              | いいえ | 依頼の宛先の席を決める role（chabatake の `discord/chanuco` の output `working_role_ids`）                                  |
| `MIZUYA_INBOX_URL`                                                | いいえ | mizuya の Worker の受け箱（`wss://mizuya.chanu.co/working/inbox`）。下の 3 つとそろわなければつながず、ボタンを受け取れない |
| `MIZUYA_INBOX_TOKEN`                                              | いいえ | 受け箱の token。Worker の `WORKING_INBOX_TOKEN` と同じ値                                                                    |
| `MIZUYA_ACCESS_CLIENT_ID` / `MIZUYA_ACCESS_CLIENT_SECRET`         | いいえ | 受け箱につなぐ Access の service token（`mizuya-working-inbox`）                                                            |
| `CODEX_HOME`                                                      | いいえ | Codex CLI の設定とログイン情報の置き場所。イメージでは `~/.codex`                                                           |
| `WORK_TEXT_CHANNEL_ID`                                            | はい   | 依頼を受ける仕事テキストチャンネル                                                                                          |
| `WORK_FORUM_CHANNEL_ID`                                           | はい   | 投稿を立てる仕事フォーラム                                                                                                  |
| `WORKING_OWNER_DISCORD_USER_IDS`                                  | はい   | 作業を頼める人の Discord ユーザー ID（カンマ区切り）                                                                        |
| `PORT`                                                            | いいえ | 生存確認（`/healthz`）を待ち受けるポート。既定は `8080`                                                                     |
| `STATE_DIR`                                                       | いいえ | 対応表の置き場所。既定は `~/state`                                                                                          |
| `WORK_DIR`                                                        | いいえ | 受付が動かす CLI（件名の要約、記憶、`gh`）の作業ディレクトリ。既定は `~/work`                                               |
| `PERSONA_SCRIPT`                                                  | いいえ | 人格を出力するスクリプト。既定は `~/bin/persona.sh`                                                                         |
| `PERSONA_DIR`                                                     | いいえ | 人格の元ファイルの置き場。既定は `~/persona`                                                                                |
| `HANDOFF_DIR`                                                     | いいえ | `prompt.md` と `issue-template.md` の置き場所。既定は `~/handoff`                                                           |
| `GH_TOKEN`                                                        | いいえ | 席の Claude の `gh` と `git push` が使う書き込みトークン                                                                    |
| `GIT_AUTHOR_NAME` など                                            | いいえ | 席の Claude の commit の作者。`GIT_AUTHOR_*` と `GIT_COMMITTER_*` を渡す                                                    |
| `YUNOMI_URL`                                                      | いいえ | Worker の URL。`yunomi-memory` が Working の記憶の口（`/v1/partners/:partnerId/working/memory`）を呼ぶ                      |
| `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`                 | いいえ | Working 用の Access service token。yunomi の Worker の `accessCallers` で `working` に引かれる。席の Claude には渡さない    |
| `CHIMERA_URL`                                                     | いいえ | chimera の URL。`chimera:` の行の画像を取る                                                                                 |
| `CHIMERA_ACCESS_CLIENT_ID` / `CHIMERA_ACCESS_CLIENT_SECRET`       | いいえ | chimera の Access service token。受付だけが使い、席の Claude には渡さない                                                   |
| `PLAYWRIGHT_MCP_URL`                                              | いいえ | Playwright MCP の URL（`https://playwright.chanu.co/mcp`）。Akarin の席の Codex に MCP サーバー `playwright` として渡す     |
| `PLAYWRIGHT_ACCESS_CLIENT_ID` / `PLAYWRIGHT_ACCESS_CLIENT_SECRET` | いいえ | Playwright MCP の Cloudflare Access の service token。URL とそろったときだけ渡す                                            |
| `MEMORY_BIN`                                                      | いいえ | 朝会で記憶を読む CLI。既定は `yunomi-memory`                                                                                |
| `MAC_STATE_TOKEN`                                                 | いいえ | Mac と共有するトークン。設定したときだけ席の状態の受け口を開く                                                              |
| `MAC_STATE_PORT`                                                  | いいえ | 席の状態の受け口のポート。既定は `8090`                                                                                     |
| `SEAT_STATUS_TOKEN`                                               | いいえ | yunomi の gateway と共有するトークン。設定したときだけ席の状態を渡す口を開く                                                |
| `SEAT_STATUS_PORT`                                                | いいえ | 席の状態を渡す口のポート。既定は `8091`                                                                                     |
| `STANDUP_ENABLED`                                                 | いいえ | `false` で朝会を止める。既定は `true`                                                                                       |
| `STANDUP_TIME`                                                    | いいえ | 朝会の時刻（`HH:MM`、Asia/Tokyo）。既定は `09:00`                                                                           |
| `STANDUP_GITHUB_OWNER`                                            | いいえ | 朝会で PR と申し送りを探す GitHub の owner。既定は `ochanuco`                                                               |
| `HEARTBEAT_ENABLED`                                               | いいえ | `false` で見回りを止め、朝会だけにする。既定は `true`                                                                       |
| `HEARTBEAT_INTERVAL_MINUTES`                                      | いいえ | 見回りの間隔（分、30 以上）。既定は `120`                                                                                   |
| `ACTIVITY_LOG_THREAD_ID`                                          | いいえ | 活動ログを投稿するスレッドの ID。設定したときだけ活動ログをまとめる                                                         |
| `ACTIVITY_LOG_TIME`                                               | いいえ | 活動ログをまとめる時刻（`HH:MM`、Asia/Tokyo）。既定は `23:30`                                                               |
| `CLAUDE_BIN`                                                      | いいえ | 受付が件名の要約とログインの期限に使う Claude CLI のパス。既定は `claude`                                                   |
| `ORCA_BIN`                                                        | いいえ | Orca の CLI。既定は `orca-ide`                                                                                              |
| `SEATS_REPO`                                                      | いいえ | 席の元にする空の git リポジトリ。既定は `~/work/seats`                                                                      |
| `SEATS_DIR`                                                       | いいえ | Orca が席の worktree を作る場所。既定は `~/work/orca/workspaces/seats`。受付と `seat-env.sh` の両方が読む                   |
| `SEAT_LIMIT`                                                      | いいえ | 同時に Claude を動かしておく席の上限。既定は `6`                                                                            |
| `SEAT_SLEEP_AFTER_MINUTES`                                        | いいえ | `決めてほしい` のままこれだけたった席の Claude を止める。既定は `120`                                                       |
| `LOG_LEVEL`                                                       | いいえ | `debug` / `info` / `warn` / `error`。既定は `info`                                                                          |

mizuya の bot には、仕事チャンネルと仕事フォーラムで、読む・送る・スレッドでの送信・履歴の読み取りの権限が要る。人格の bot には、読む・送る・スレッドでの送信・公開スレッドの作成・スレッドの管理（タグの付け替え）・埋め込み・ファイル・履歴の読み取り・リアクションの権限が要る（どちらも chabatake の `discord/chanuco` の上書き）。mizuya の application では Message Content intent を有効にする。

## 配備

main への push で `.github/workflows/working-image.yml` が `ghcr.io/ochanuco/mizuya-working:main` と `:sha-<short>` を公開する。PR ではビルドだけ確かめる。公開の後、Environment `production-approval` で持ち主が承認すると、`deploy` job が chabatake の `docker01-app` を dispatch して `:sha-<short>` を docker01 に配置する（`.github/actions/docker01-app`）。docker01 の stack は chabatake の `docker01/mizuya-working` にある。作り直すと作業中の席が切れるので、承認は作業の切れ目に出す。

docker01 に、yunomi の gateway とは別の compose project で置く（`compose.example.yaml`）。gateway を更新しても Working の作業は止まらない。

- 受付は外から受ける口を持たない（Discord は Gateway、ボタンと GitHub の出来事は受け箱へ外向きにつなぐ）。生存確認の `8080` は公開しない。
- 席の状態の受け口（コンテナの `8090`）は、Mac から届く LAN の口に公開する。`MAC_STATE_URL` は `http://<host>:<公開したポート>/mac-state` にする。
- 席の状態を渡す口（コンテナの `8091`）も、別の stack の yunomi の gateway から届くよう LAN の口に公開する。
- `restart: unless-stopped` で、ホストの再起動後も受付と `orca serve` が上がる。
- volume は 5 つ（上の表）。コンテナを作り直しても、ログイン・pairing・投稿と席の対応・席の worktree と Claude・Codex の会話が残る。席の Claude はコンテナと一緒に終わるので、受付は起動時に止めた席として扱い、返事で起こす。

### 初回だけ人が行うこと

#### Claude CLI のログイン

```sh
docker exec -it <コンテナ名> claude   # /login で表示された URL を開いて承認し、/exit
docker exec <コンテナ名> claude auth status
```

ログイン情報は `mizuya-working-claude` の volume に残る。期限が切れたら同じ手順でやり直す。

#### Codex CLI のログイン

Akarin の席を使うときだけ行う。

```sh
docker exec -it <コンテナ名> codex login --device-auth   # 表示された URL とコードで承認する
docker exec <コンテナ名> codex login status
```

ログイン情報は `mizuya-working-codex` の volume に残る。

#### Mac の Orca との pairing

`--pairing-address` は Mac から届くホストのアドレスとポートにする。コンテナのログに出る pairing URL を Mac の Orca に渡す。

```sh
code=$(docker logs <コンテナ名> 2>&1 | grep '^Pairing URL:' | tail -1 | sed 's/^Pairing URL: //')
orca environment add --name working --pairing-code "$code"   # Mac で実行する
orca status --environment working   # runtimeConnectionState: connected
```

pairing のコードは端末の認証情報なので、ログや Issue に貼らない。pairing 済みの端末は `mizuya-working-orca` の volume に残る。

## 人格

席の agent に渡す人格は、yunomi の `partners/yukarin` と `partners/akarin` の `identity/`・`profile.yaml`・`examples.yaml` をそのまま使う。Dockerfile の `persona` stage が、`YUNOMI_REF`（yunomi のコミット SHA）の版を git から取り込み、`~/persona/<パートナー>/` に置く。

- `persona.sh` が起動時にそれを連結して席の前置きにする。
- 朝会と見回りを止める時間帯は、Yukarin の `profile.yaml` の `living_rhythm.typical_sleep` から読む。読めなければ受付は起動しない。
- `YUNOMI_REF` は Renovate が yunomi の main に追従して上げる PR を立てる（`renovate.json5` の `yunomi persona`）。人格を直したら、その PR をマージすると image が作り直される。

## 試し方

リポジトリの root で行う。

```sh
docker build -f apps/working/Dockerfile -t mizuya-working:spike .

docker run -d --name working \
  -p 127.0.0.1:16768:6768 \
  --env-file .env.working \
  -v mizuya-working-claude:/home/worker/.claude \
  -v mizuya-working-codex:/home/worker/.codex \
  -v mizuya-working-orca:/home/worker/.config \
  -v mizuya-working-state:/home/worker/state \
  -v mizuya-working-work:/home/worker/work \
  mizuya-working:spike \
  orca-ide serve --port 6768 --pairing-address 127.0.0.1:16768
```

Mac の Orca が 127.0.0.1:6768 を使っているため、ホスト側のポートは 6768 以外にする。6768 のままだと Mac の Orca 自身に繋がり、`4001: Unauthorized` で断られる。`--pairing-address` は Mac から届くアドレスにする。

### 1. Mac の Orca から接続する

```sh
code=$(docker logs working 2>&1 | grep '^Pairing URL:' | tail -1 | sed 's/^Pairing URL: //')
orca environment add --name working --pairing-code "$code"
orca status --environment working   # runtimeConnectionState: connected
```

pairing のコードは端末の認証情報なので、ログや Issue に貼らない。

### 2. Claude CLI にログインする

```sh
docker exec -it working claude   # /login で表示された URL を開いて承認し、/exit
docker exec working claude auth status
```

### 3. 席で作業させる

仕事フォーラムに投稿を立てると、受付がその投稿の席を作る。席は Mac の Orca の `working` 環境に、`seat-<投稿の ID>` の worktree として見える。コンテナの中からは次で確かめる。

```sh
docker exec working orca-ide worktree list --json | jq -r '.result.worktrees[].path'
docker exec working orca-ide terminal list --json | jq -r '.result.terminals[] | "\(.handle) \(.title)"'
```

`docker rm -f working` で作り直しても、ログイン・pairing・投稿と席の対応・席の worktree と会話は volume に残る。

`.env.working` には上の環境変数を書く（commit しない）。受付は起動時に Discord に接続できなければ終了し、コンテナも一緒に終わる。
