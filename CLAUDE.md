# mizuya リポジトリ規約

mizuya は仕事と運用の窓口。いまの機能は GitHub Actions のデプロイ承認を Discord のボタンで行うことだけ。役割、動き、secret は README にある。webhook・Environment・DNS は `ochanuco/chabatake` が持つ。

## コマンド

- `pnpm install`（postinstall で `wrangler types`）
- `pnpm run typecheck && pnpm run lint && pnpm test && pnpm run build`: PR 前に必ず通す
- `pnpm format`: Biome で整形（lint も Biome）

## 規約

- public repo なので、メールアドレス・Discord の user ID や channel ID などの実値をコード・テスト・docs に書かない。テストは example.com と架空の ID を使う
- 署名検証（GitHub の HMAC、Discord の Ed25519）を通さずに外部入力を処理しない
- Valibot は境界（webhook と interaction の入力、外部 API の応答）でのみ使う。内部の型は TypeScript の型で表す
- 想定内の失敗は例外を投げず `{ ok: false, error }` で返す
- デプロイは main への push で `deploy` workflow が行う。`wrangler deploy` の手打ちはしない
- コメントは日本語で、コードから読み取れない理由だけを書く
