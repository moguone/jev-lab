# Maze Runner

迷路でペレットを集めながらゴーストから逃げる、古典的な迷路チェイス系のブラウザゲーム。
プレイヤー（ランナー）の進行方向を TypeSafe AI の System One モデル **Jev** に裁定させ、自動クリアを目指す。

![Maze Runner の画面](docs/screenshot.jpg)

*MOCK モード（API キーなし・回答はランダム）での画面。表示されているレイテンシや confidence はダミー値で、Jev の実測値ではない。*

「制御フローとルールはコード、意味的な判断だけ Jev」という公式の設計方針（Harness Engineering / Real-time applications）を、
レイテンシ・トークン量・confidence を計測しながら確かめるための検証アプリ。

## 起動

Node.js 22.9 以上。依存パッケージはない。

```sh
# リポジトリのルートで（初回のみ）
cp .env.example .env   # TYPESAFE_API_KEY を記入

cd apps/maze-runner
npm start              # http://localhost:8787
```

API キーが無い場合は **MOCK モード**（回答はランダム）で起動し、画面の動作だけ確認できる。
API キーはサーバ (`server.mjs`) だけが持ち、ブラウザには渡らない。

## 戦略

| 戦略 | 内容 | 検証の狙い |
|---|---|---|
| Jev: Choice × 特徴量ラベル | BFS で求めた距離を `deadly / high / near …` のラベルにして渡し、Choice 1 問で方向を選ばせる | 公式推奨の使い方。数値はコード、判断は Jev |
| Jev: Noul+Score fan-out | 方向ごとに「危険か (Noul)」「旨味 (Score)」を 1 リクエストで並列に聞き、コードで `value − 1.5 × danger` に合成 | Speculative fan-out / Composite scoring パターン |
| Jev: Choice × ASCII 盤面 | 盤面をそのままテキストで渡す | 空間把握を丸投げした場合の限界確認 |
| ヒューリスティック / ランダム | API を使わないベースライン | 比較対象 |

どの戦略でも選択肢には**合法手しか入れない**ため、壁に向かう手は型として返ってこない（「不正手」カウンタで確認できる）。

## 進行モード

- **同期**: 1 手ごとに Jev の回答を待つ。判断の質だけを見たいとき用。ゲーム速度はレイテンシで決まる。
- **リアルタイム**: tick は固定間隔で進み、回答が届くまでランナーは直進する。届いた手がその時点で打てなければ `stale` として破棄。
  tick 間隔を縮めていくと、レイテンシが成績に効き始める境界が見える。

`confidence` がしきい値未満の裁定をヒューリスティックに差し替える Confidence-gated routing も切り替えられる。
fan-out 戦略は Jev の confidence を持たないため、合成スコアの 1 位と 2 位の差で代用している。

## 計測

エピソードごとに 結果 / クリア率 / 裁定数 / レイテンシ (平均・p95) / 入力トークン / フォールバック数 / stale 数 を記録し、CSV でコピーできる。
画面の「入力単価」に自分の契約単価を入れると推定コストも表示する（値はブラウザにだけ保存され、リポジトリには含まれない）。
乱数はシード付きなので、同じシード・ゴースト数なら戦略間で同じ条件の比較になる（リアルタイム進行は回答タイミングに依存するため厳密には再現しない）。

> **計測結果の扱い**: TypeSafe AI の利用規約は、サービスのベンチマークや性能情報の公開を禁じている。
> このアプリで得た数値は手元の検証にとどめ、公開する場合は事前に TypeSafe AI の許可を得ること。

## 構成

```
server.mjs         静的配信 + /api/decide (Jev へのプロキシ、429/529 はリトライ)
public/game.js     ゲームエンジン（DOM 非依存、シード付き乱数）
public/agent.js    盤面 → state/questions 変換、回答の解釈、ヒューリスティック
public/main.js     描画、実行ループ、計測
scripts/sim.mjs    ベースラインをヘッドレスで回す:   npm run sim -- 30 4
scripts/bench.mjs  Jev 戦略をヘッドレスで回す (要サーバ起動): npm run bench -- 3 4
```

プロンプト（instructions / criteria / ラベルの閾値）を調整する場所は `public/agent.js`。
