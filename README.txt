マインスイーパー（Google サイト埋め込み向け Web 版）
==================================================

元の2ファイル:
  minesweeper_2.py     … Tkinter GUI（Webではそのまま動かない）
  minesweeper_2_ai.py  … AIの解析エンジン（内容は変更していません）

Web版ファイル:
  index.html           … Web画面
  style.css            … デザイン
  game.js              … 操作とゲームルール、リプレイ
  ai-worker.js         … Pyodideを使ってAI.pyをブラウザの別スレッドで実行
  minesweeper_2_ai.py  … 元のAI処理（そのままコピー）

【公開方法 / GitHub Pages】
1. GitHub.com にログインし、新しい public リポジトリ（例: minesweeper-web）を作成。
2. Web版の5ファイル（index.html, style.css, game.js, ai-worker.js, minesweeper_2_ai.py）を
   リポジトリの最上位フォルダにアップロード。
3. GitHubのリポジトリ Settings → Pages → Build and deployment で
   Source = Deploy from a branch、Branch = main / (root)、Save を選択。
4. 公開URL例: https://ユーザー名.github.io/minesweeper-web/
5. Google サイトの編集画面 → 挿入 → 埋め込む → URL に上のURLを指定して「公開」。
   ゲームを広く表示したい場合は「ページ」→「ページ全体の埋め込み」も便利です。

【注意】
* Google ドライブの共有リンクから .py を直接開いてもゲームは起動しません。
* ゲーム本体は GitHub Pages に、Google サイトではその公開URLを埋め込みます。
* AIエンジンは初回に外部CDNのPyodideをダウンロードするため、ネット接続が必要です。
* ブラウザは新しい Chrome / Edge / Firefox を推奨します。
* AIの計算には Web Worker を使い、画面を固めないようにしています。
* リプレイは各端末のブラウザ localStorage に保存されます（Googleドライブではありません）。
* 元の Tkinter 版と比べ、一部の見た目・操作方法・リプレイの保存場所が異なります。
* AI は Python ファイルを公開配信するので、そのソースは閲覧可能になります。
* ローカルで開く場合も、index.html を file:// で直接開くのではなく
  `python -m http.server 8000` として http://localhost:8000/ へアクセスしてください。
