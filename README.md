# mizuya

水屋（みずや）は、茶室の裏にある準備の場所。表で話す yunomi に対して、mizuya は裏で仕事と運用を受け持つ窓口で、人が操作し許可する仕組みを置く。

機能は 2 つあり、それぞれ `apps/` の下に置く。

| 場所           | 中身                                                                                                                                                                                                                                                                 |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/worker`  | GitHub Actions のデプロイ承認。Environment の required reviewers で止まった run を Discord に知らせ、ボタンで承認・却下できるようにする Cloudflare Worker。Working 向けのボタン、`/ai` コマンドと GitHub の出来事を受け箱に置いて Working に渡す。この README の以下の節はこれの説明 |
| `apps/working` | Working（仕事）。Discord の仕事フォーラムの依頼を Orca の席で Claude CLI と Codex CLI に作業させる、docker01 のコンテナ。記憶と人格は yunomi のものを使う。説明は [apps/working/README.md](apps/working/README.md)                                                   |

## 動き

1. job が Environment の承認待ちに入ると、GitHub が `workflow_job`（`waiting`）の webhook を `POST /github/webhook` に送る。payload は Environment を持たないので、mizuya はその run の `pending_deployments` から承認待ちの Environment を取る。
2. mizuya は承認用チャンネルに、Environment ごとに repo・workflow（run 名）・Environment・待っている job・起動元のコミット・run へのリンクと「承認」「却下」ボタンの付いたメッセージを、承認者（`DISCORD_APPROVER_USER_ID`）へのメンション付きで投稿する。起動元のコミットは run を起動したコミットで、workflow_dispatch で別の ref を出すときはデプロイする ref と違う（deploy workflow は run 名にデプロイする ref を入れる）。承認者（required reviewers）のいない待ちは投稿しない。同じ承認待ち（run と Environment の組）は 1 回だけ投稿する。投稿したことは Durable Object `ApprovalLedger` に記録し、同時に届いた配信でも投稿は 1 つになる。投稿に失敗したら記録を消し、次の配信で投稿し直す。
3. ボタンを押すと、Discord が `POST /discord/interactions` を呼ぶ。押した人が承認者でなければ本人にだけ見える返事で断る。承認者なら deferred update で応答し、メッセージの run の URL と Environment 欄から対象を読み、同じ run の `pending_deployments` から Environment の ID を取って承認・却下を送る。決着したらタイトルを「承認」「却下」「取り消し」に、本文を「承認しました」「却下しました」「取り消されました」に変え、誰が決めたかを書いてボタンを消す。書き換えでは承認者に再び通知しない。失敗したらエラーを書き、押し直せるようボタンを残す。承認待ちがもう無ければ、押した人にだけそう伝える。
4. GitHub の画面で承認・却下された場合は、待っていた job の `workflow_job` が `in_progress`（承認）か `completed`（却下は `failure`、run の取り消しは `cancelled`）で来る。承認用チャンネルを直近 500 件までさかのぼり、ボタンの残るメッセージを run の URL と job で探して決着済みに書き換える。対応表は持たない。

| エンドポイント               | 用途                                                                                                 |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- |
| `POST /github/webhook`       | `X-Hub-Signature-256` を検証し、`workflow_job` を処理する。席を動かす出来事は Working の受け箱に置く |
| `POST /discord/interactions` | Ed25519 署名を検証し、PING・ボタン・`/ai` コマンドと依頼の modal を処理する。Working 向けのものは Working の受け箱に置く |
| `GET /working/inbox`         | Working が受け箱に WebSocket でつなぐ口。Access の service token と `WORKING_INBOX_TOKEN` で確かめる |
| `GET /health`                | 疎通確認                                                                                             |

## Working の受け箱

Working（docker01）は公開していないので、Worker が受けた仕事向けの出来事は Durable Object `WorkingInbox` に置き、Working が外向きの WebSocket でつないで受け取る。Working は受け取った行を ack し、ack された行だけを消す。つながっていない間に置かれた行は、次につないだときに渡す。承認の処理は受け箱を通らないので、Working が止まっていても承認はできる。

- ボタン: custom_id が `working:` で始まるボタンは、deferred update で応答してから、押された場所・custom_id・押した人を置く。押した人が持ち主かどうかは Working が決める。interaction の token は 15 分で切れるので、それより古いボタンは渡さない。
- `/ai` コマンド: `/ai <claude|codex> <モデル>`（claude は `opus`・`sonnet`・`haiku`、codex は `terra`・`sol`・`luna`）。スレッドの外で打たれたら、依頼を書く modal（複数行の欄 1 つ）を返す。modal が送信されたら本人にだけ見える「受け付けました。投稿を立てています…」で応答し、依頼・相手・モデル・打った人と interaction の token を置く。スレッドの中で打たれたら、本人にだけ見える deferred で応答し、モデルの切り替えとして置く。仕事フォーラムの投稿かどうかは Working が決め、本人にだけ見える返事を token で書き換える。ボタンと同じく 15 分より古いものは渡さない。
- GitHub の出来事: `workflow_run` と `check_suite`（Actions 以外）の失敗、`pull_request_review` の submitted、`issue_comment` の created を、席の材料になる値だけに絞って置く（`src/work-events.ts`）。`X-GitHub-Delivery` で再送を一つにまとめる。6 時間より古いものは渡さない（Working の見回りが拾う）。
- 渡せないまま 1 日たった行は、Durable Object の alarm が消す。

## 構成

- Cloudflare Worker `mizuya`。chabatake が管理する独自ドメインだけで受け、`workers.dev` は閉じている。Discord は HTTP interactions で受ける。常時接続は、Working が受け箱につなぐ WebSocket だけ。
- ストレージは Working の受け箱（Durable Object `WorkingInbox` の SQLite）だけ。
- `apps/worker/src/` の `index.ts` が経路の振り分け、`webhook.ts` が GitHub の webhook、`interactions.ts` が Discord のボタンとコマンド、`commands.ts` が `/ai` の定義と modal、`register-commands.ts` がコマンドの登録、`review.ts` がメッセージの組み立てと、メッセージから対象を読む処理、`signature.ts` が署名検証、`work-events.ts` が GitHub の出来事の絞り込み、`inbox.ts` と `inbox-object.ts` と `inbox-route.ts` が Working の受け箱、`approval-ledger.ts` と `approval-ledger-object.ts` が承認待ちの投稿の記録、`github.ts` と `discord.ts` が外部 API。

## 開発

repo の root で、pnpm workspace の全 app に対して実行する。

```sh
pnpm install          # apps/worker の postinstall で wrangler types を生成する
pnpm run typecheck
pnpm run lint
pnpm test
pnpm run build        # wrangler deploy --dry-run
```

## デプロイ

main への push で `apps/worker` などが変わると、GitHub Actions の `deploy` workflow が出す（ochanuco/.github の `deploy-plan.yml` と `deploy.yml`）。前回の記録がない・ロールバックのときだけ Environment `production-approval` の承認で止まる。手動実行（入力 `ref` は main か main 上の SHA）はロールバック用。

認証情報は Environment `production` の secret `OP_SA_DEPLOY`（1Password の service account）で、`.github/deploy/production.env.op` の参照を `op run` が解決する。`apps/worker/scripts/deploy.sh` が secret がすべてそろっていることを確かめ、Worker に反映して `wrangler deploy` し、`apps/worker/scripts/register-commands.ts` で `/ai` を mizuya の application にグローバル登録（bulk overwrite）してから、`/health` を確かめる。登録は `DISCORD_BOT_TOKEN` だけを使い、application の ID は `GET /applications/@me` で引く。

## secret

Worker の secret はすべて 1Password の vault `gh-deploy` に置き、デプロイのたびに反映する。

| 名前                          | 1Password の参照                                      | 中身                                                                                                                              |
| ----------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`        | `gh-deploy/cloudflare-workers/credential`             | デプロイ用（Worker には入れない）                                                                                                 |
| `GITHUB_WEBHOOK_SECRET`       | `gh-deploy/mizuya-worker/github_webhook_secret`       | webhook の署名鍵。各 repo の webhook と同じ値                                                                                     |
| `GITHUB_APPROVER_TOKEN`       | `gh-deploy/mizuya-worker/github_approver_token`       | required reviewer 本人の fine-grained PAT。対象 repo の Deployments: write と Actions: read                                       |
| `DISCORD_PUBLIC_KEY`          | `gh-deploy/mizuya-worker/discord_public_key`          | Discord application の Public Key                                                                                                 |
| `DISCORD_BOT_TOKEN`           | `gh-deploy/mizuya-worker/discord_bot_token`           | mizuya bot の token                                                                                                               |
| `DISCORD_APPROVER_USER_ID`    | `gh-deploy/mizuya-worker/discord_approver_user_id`    | ボタンを押してよい Discord の user ID                                                                                             |
| `DISCORD_APPROVAL_CHANNEL_ID` | `gh-deploy/mizuya-worker/discord_approval_channel_id` | 承認用チャンネルの ID                                                                                                             |
| `WORKING_INBOX_TOKEN`         | `gh-deploy/mizuya-worker/working_inbox_token`         | Working が受け箱につなぐときの token。Working の `MIZUYA_INBOX_TOKEN` と同じ値。Worker に一度も入れていなければ受け箱の口を閉じる |

## 人がやるセットアップ

1. Discord Developer Portal で application「mizuya」を作り、bot を有効にして token を発行する。General Information の Public Key と合わせて 1Password に登録する。
2. Interactions Endpoint URL に `<Worker のドメイン>/discord/interactions` を設定する。Discord は保存時に PING を送るので、Worker のデプロイ後に行う。
3. bot をサーバーに招待するときは、scope に `bot` と `applications.commands` を入れる。`/ai` はグローバルコマンドなので、`applications.commands` が無いサーバーには出ない。
4. サーバーに承認用チャンネルを作り、mizuya bot を招待して、そのチャンネルで View Channel・Send Messages・Embed Links・Read Message History を許す。Read Message History は、二重投稿の確認と GitHub 側で決着したメッセージを探すのに使う。
5. GitHub で fine-grained PAT を発行する（required reviewer 本人のアカウント。対象 repo の Deployments: write と Actions: read）。
6. 上の secret をすべて 1Password に登録する。

GitHub の webhook（URL `<Worker のドメイン>/github/webhook`、イベント `workflow_job`、content type json）と、デプロイ用の Environment、DNS は `ochanuco/chabatake` が管理する。webhook の secret は `GITHUB_WEBHOOK_SECRET` と同じ値にする。
