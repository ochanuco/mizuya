# mizuya リポジトリ規約

mizuya は仕事と運用の窓口。pnpm workspace で、`apps/worker` が GitHub Actions のデプロイ承認を Discord のボタンで行う Cloudflare Worker、`apps/working` が仕事フォーラムの依頼を席で `hs turn` を使って作業させる docker01 のコンテナ、`apps/budget` が Cloudflare の従量課金の額を毎日 Discord に知らせてダッシュボードに出す Worker。役割、動き、secret は README と `apps/working/README.md` にある。webhook・Environment・DNS・docker01 の stack は `ochanuco/chabatake` が持つ。記憶と人格の正本は `ochanuco/yunomi` にあり、Working はそれを記憶の口と image の build で使う。

## コマンド

- `pnpm install`（`apps/worker` の postinstall で `wrangler types`）
- `pnpm run typecheck && pnpm run lint && pnpm test && pnpm run build`: PR 前に必ず通す
- `pnpm format`: Biome で整形（lint も Biome）

## 規約

- public repo なので、メールアドレス・Discord の user ID や channel ID などの実値をコード・テスト・docs に書かない。テストは example.com と架空の ID を使う
- 署名検証（GitHub の HMAC、Discord の Ed25519）を通さずに外部入力を処理しない
- Valibot は境界（webhook と interaction の入力、外部 API の応答）でのみ使う。内部の型は TypeScript の型で表す
- 想定内の失敗は例外を投げず `{ ok: false, error }` で返す
- Worker のデプロイは main への push で `deploy` workflow が行う。`wrangler deploy` の手打ちはしない
- Working の image は main への push で `working-image` workflow が作り、承認の後に chabatake の `docker01-app` で docker01 に出す
- コメントは日本語で、コードから読み取れない理由だけを書く
