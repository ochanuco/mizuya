# apps/budget

Cloudflare の利用額を毎日取り、予算に対する累計と月末の予測を Discord に報告する Cloudflare Worker `mizuya-budget`。日ごと・製品ごとの額を D1 に置き、`https://budget.chanu.co/` で見せる。画面は Cloudflare Access の後ろにあり（chabatake が管理する）、Worker は認証をしない。

## 動き

1. 毎日 10:00（JST、cron `0 1 * * *`）に、`billable-usage/info` の有効な subscription の起点の日（`billing_cycle_anchor_timestamp` の日）から今の請求期間を決める。起点が 29〜31 日で、その日が無い月は月末から始まる。
2. `billable-usage` で、今期の初日（期間の初日は前日）から今日までの分を取り、日・製品ごとに合計して D1 の `usage` に入れ直す。請求の数字は後から直ることがあるので、毎日期間全体を取り直す。
3. 前日の額、今期の累計、月末の予測（累計 ÷ 経過日数 × 期間の日数）、製品群別の額を、`DISCORD_BUDGET_CHANNEL_ID` のチャンネルに投稿する。普段の投稿は誰にもメンションしない。
4. 累計が `BUDGET_THRESHOLDS_PERCENT` のどれかに初めて達した日と、予測が予算を初めて超えた日は、`DISCORD_APPROVER_USER_ID` にメンションし、どの閾値かを書く。知らせたものは D1 の `notified` に期間ごとに記録し、同じ期間には 2 度知らせない。投稿に失敗した日は記録せず、次の日にもう一度知らせる。
5. 設定や Cloudflare API、D1 で失敗した日は、メンションなしで失敗をチャンネルに書く。

| エンドポイント | 用途                                                       |
| -------------- | ---------------------------------------------------------- |
| `GET /`        | 今期の累計と予算、予測、日ごとの額、製品別の表、取得の日時 |
| `GET /health`  | 疎通確認                                                   |

## 設定

`wrangler.jsonc` の `vars` に置く。

| 名前                        | 中身                                                      |
| --------------------------- | --------------------------------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID`     | 利用額を読む account                                      |
| `BUDGET_MONTHLY_USD`        | 1 か月（請求期間）の予算（USD）                           |
| `BUDGET_THRESHOLDS_PERCENT` | 知らせる累計の閾値（%、カンマ区切り）。予測は 100% で固定 |

## secret

1Password の vault `gh-deploy` に置き、デプロイのたびに反映する（`.github/deploy/budget.env.op`）。

| 名前                        | 1Password の参照                                    | 中身                                      |
| --------------------------- | --------------------------------------------------- | ----------------------------------------- |
| `CLOUDFLARE_API_TOKEN`      | `gh-deploy/cloudflare-workers/credential`           | デプロイ用（Worker には入れない）         |
| `CLOUDFLARE_BILLING_TOKEN`  | `gh-deploy/mizuya-budget/cloudflare_billing_token`  | 請求を読む API token（Billing: Read）     |
| `DISCORD_BOT_TOKEN`         | `gh-deploy/mizuya-worker/discord_bot_token`         | mizuya bot の token（apps/worker と共用） |
| `DISCORD_APPROVER_USER_ID`  | `gh-deploy/mizuya-worker/discord_approver_user_id`  | 閾値を越えたときにメンションする user ID  |
| `DISCORD_BUDGET_CHANNEL_ID` | `gh-deploy/mizuya-budget/discord_budget_channel_id` | 予算のチャンネルの ID                     |

mizuya bot には、予算のチャンネルで View Channel・Send Messages・Embed Links を許す。

## D1 の migration

デプロイでは migration を当てない（デプロイ用の token に D1 の書き込み権限があるとは限らない）。`migrations/` を足したら、デプロイの前に手で当てる。`deploy-budget` workflow は `migrations/` が変わると承認で止まる。

```sh
cd apps/budget
pnpm exec wrangler d1 migrations apply mizuya-budget --remote
```

## デプロイ

main への push で `apps/budget` などが変わると、`deploy-budget` workflow が出す。仕組みは root の README の「デプロイ」と同じで、`apps/budget/scripts/deploy.sh` が secret がそろっていることを確かめ、`wrangler deploy` してから `/health` を確かめる。
