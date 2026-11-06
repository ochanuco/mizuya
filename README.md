# mizuya

水屋（みずや）は、茶室の裏にある準備の場所。表で話す yunomi に対して、mizuya は裏で仕事と運用を受け持つ窓口で、人が操作し許可する仕組みを置く。

いまの機能は GitHub Actions のデプロイ承認だけ。Environment の required reviewers で止まった run を Discord に知らせ、ボタンで承認・却下できるようにする。

## 動き

1. Environment の承認待ちが起きると、GitHub が `deployment_review`（`requested`）の webhook を `POST /github/webhook` に送る。
2. mizuya は承認用チャンネルに、repo・workflow・ref と SHA・Environment・run へのリンクと「承認」「却下」ボタンの付いたメッセージを投稿する。同じ承認待ちのメッセージが未決着で残っていれば投稿しない。
3. ボタンを押すと、Discord が `POST /discord/interactions` を呼ぶ。押した人が承認者でなければ本人にだけ見える返事で断る。承認者なら deferred update で応答し、メッセージの run の URL と Environment 欄から対象を読み、同じ run の `pending_deployments` から Environment の ID を取って承認・却下を送る。決着したら誰が決めたかを書いてボタンを消す。失敗したらエラーを書き、押し直せるようボタンを残す。承認待ちがもう無ければ、押した人にだけそう伝える。
4. GitHub の画面で承認・却下された場合は `approved` / `rejected` の webhook が来るので、承認用チャンネルを直近 500 件までさかのぼり、ボタンの残るメッセージを run の URL と Environment で探して決着済みに書き換える。対応表は持たない。

| エンドポイント               | 用途                                                           |
| ---------------------------- | -------------------------------------------------------------- |
| `POST /github/webhook`       | `X-Hub-Signature-256` を検証し、`deployment_review` を処理する |
| `POST /discord/interactions` | Ed25519 署名を検証し、PING とボタンを処理する                  |
| `GET /health`                | 疎通確認                                                       |

## 構成

- Cloudflare Worker `mizuya`。独自ドメイン `mizuya.chanu.co` だけで受け、`workers.dev` は閉じている。常時接続は持たない（Discord は HTTP interactions）。
- ストレージは使わない。
- `src/index.ts` が経路の振り分け、`src/webhook.ts` が GitHub の webhook、`src/interactions.ts` が Discord のボタン、`src/review.ts` がメッセージの組み立てと、メッセージから対象を読む処理、`src/signature.ts` が署名検証、`src/github.ts` と `src/discord.ts` が外部 API。

## 開発

```sh
pnpm install          # postinstall で wrangler types を生成する
pnpm run typecheck
pnpm run lint
pnpm test
pnpm run build        # wrangler deploy --dry-run
```

## デプロイ

main への push で GitHub Actions の `deploy` workflow が出す（ochanuco/.github の `deploy-plan.yml` と `deploy.yml`）。前回の記録がない・ロールバックのときだけ Environment `production-approval` の承認で止まる。手動実行（入力 `ref` は main か main 上の SHA）はロールバック用。

認証情報は Environment `production` の secret `OP_SA_DEPLOY`（1Password の service account）で、`.github/deploy/production.env.op` の参照を `op run` が解決する。`scripts/deploy.sh` が secret がすべてそろっていることを確かめ、Worker に反映して `wrangler deploy` し、`/health` を確かめる。

## secret

Worker の secret はすべて 1Password の vault `gh-deploy` に置き、デプロイのたびに反映する。

| 名前                          | 1Password の参照                                      | 中身                                                                                        |
| ----------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`        | `gh-deploy/cloudflare-workers/credential`             | デプロイ用（Worker には入れない）                                                           |
| `GITHUB_WEBHOOK_SECRET`       | `gh-deploy/mizuya-worker/github_webhook_secret`       | webhook の署名鍵。各 repo の webhook と同じ値                                               |
| `GITHUB_APPROVER_TOKEN`       | `gh-deploy/mizuya-worker/github_approver_token`       | required reviewer 本人の fine-grained PAT。対象 repo の Deployments: write と Actions: read |
| `DISCORD_PUBLIC_KEY`          | `gh-deploy/mizuya-worker/discord_public_key`          | Discord application の Public Key                                                           |
| `DISCORD_BOT_TOKEN`           | `gh-deploy/mizuya-worker/discord_bot_token`           | mizuya bot の token                                                                         |
| `DISCORD_APPROVER_USER_ID`    | `gh-deploy/mizuya-worker/discord_approver_user_id`    | ボタンを押してよい Discord の user ID                                                       |
| `DISCORD_APPROVAL_CHANNEL_ID` | `gh-deploy/mizuya-worker/discord_approval_channel_id` | 承認用チャンネルの ID                                                                       |

## 人がやるセットアップ

1. Discord Developer Portal で application「mizuya」を作り、bot を有効にして token を発行する。General Information の Public Key と合わせて 1Password に登録する。
2. Interactions Endpoint URL に `https://mizuya.chanu.co/discord/interactions` を設定する。Discord は保存時に PING を送るので、Worker のデプロイ後に行う。
3. サーバーに承認用チャンネルを作り、mizuya bot を招待して、そのチャンネルで View Channel・Send Messages・Embed Links・Read Message History を許す。Read Message History は、二重投稿の確認と GitHub 側で決着したメッセージを探すのに使う。
4. GitHub で fine-grained PAT を発行する（required reviewer 本人のアカウント。対象 repo の Deployments: write と Actions: read）。
5. 上の secret をすべて 1Password に登録する。

GitHub の webhook（URL `https://mizuya.chanu.co/github/webhook`、イベント `deployment_review`、content type json）と、デプロイ用の Environment、DNS は `ochanuco/chabatake` が管理する。webhook の secret は `GITHUB_WEBHOOK_SECRET` と同じ値にする。
