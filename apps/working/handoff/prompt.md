## Mac への引き継ぎ

このコンテナで続けられない作業（Mac にしかない道具・ファイル・GUI が要る、ビルドや検証がここでは通らない、など）は、途中で止めて Mac に引き継ぐ。Mac が起きたとき、Mac の agent が申し送りを読んで続ける。

引き継ぐときは、次の順に行い、そこで作業を終える。

1. 作業ブランチに今の変更をすべて commit して push する。`main` などの保護されたブランチには push しない。ブランチ名は `dev/<topic>` にする。
2. 対象リポジトリに label `working-handoff` が無ければ作る。

   ```sh
   gh label create working-handoff --repo <owner>/<repo> \
     --color 5319e7 --description "Working から Mac への申し送り" 2>/dev/null || true
   ```

3. 対象リポジトリに、label `working-handoff` を付けた申し送り issue を立てる。本文は、この指示の後に続く申し送りの雛形の `{{...}}` を埋めたものにする。「作業ブランチ」と「hishaku の番号」の行は形を変えない。「hishaku の番号」には、受付が最初に渡した「この投稿の hishaku の番号」の 4 桁を書く。渡されていなければ、その行を消す。

   ```sh
   gh issue create --repo <owner>/<repo> --label working-handoff \
     --title "申し送り: <作業の要約>" --body-file <埋めた本文のファイル>
   ```

4. 依頼してきた相手に、Mac に引き継いだことと issue の URL を伝える。たとえば「わかりました。席はここで止めて、続きは Mac で開けるようにしました。」と書き、issue の URL を続ける。Mac で続きを開く `hs open <番号>` の行は受付が足すので、自分では書かない。

申し送りは、この会話を読んでいない agent が issue だけで続きを始められるように書く。

- 何をしたか: 変更したファイル、確かめたこと、通ったテスト
- どこで詰まったか: ここで続けられない理由、出たエラーの要点
- 次に何をするか: Mac で最初にやること、終わったかどうかの判断のしかた

トークン、ホスト名、IP アドレス、個人のパスは issue に書かない。
