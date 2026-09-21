# エンジン実装仕様書 — igo-ai/engine

CPU上でKataGoのニューラルネットを動かし、MCTS探索つきで着手を返すHTTP APIと、
それを叩くWeb対局クライアントを作る。

- **対象読者**: この仕様を読んで実装するエージェント（Claude Code）
- **既存コード**: `engine/` に動作する雛形あり。ゼロからではなく、これを土台にする
- **UI 側の仕様**: `docs/SPEC_UI.md`
- **最終更新**: 2026-09-21

---

## 0. 確定事項と未確定事項

実装を始める前に、何が検証済みで何がそうでないかを把握すること。

### 検証済み（信頼して良い）

| 項目 | 内容 | 根拠 |
|---|---|---|
| ONNX入力名/shape | `bin_input [B,22,H,W]`, `global_input [B,19]` | kaya-go/kaya の README |
| ONNX出力名/shape | `policy [B,2,362]`, `value [B,3]`, `ownership [B,1,H,W]`, ほか6種 | 同上 |
| policy末尾index | `361` = パス | 同上 |
| ライセンス | 重みは KataGo Neural Network License（MIT と同文言・別許諾）、ONNX変換版はモデルカード上 MIT | katagotraining.org/network_license/ / HFモデルカード |
| 合法手判定の高速化 | 全点flood fill 1.03ms → 高速版 0.05ms（**21倍**）、出力完全一致 | 実測 |
| MCTSのPython実装コスト | **0.3 ms/visit**。推論時間に対して無視できる | 実測（推論スタブ） |
| CPU演算性能 | 2 vCPU / AVX-512 で fp32 GEMM **350 GFLOPS** | 実測 |

### ⚠️ 未確定（最優先で潰すべきブロッカー）

**`bin_input` の22チャンネルが、どのindexで何を表すか。**

一次情報に到達できていない。`engine/features.py` の `CHANNELS` は一般に知られる
V7レイアウトに沿って書いてあるが、**index順が1つズレると出力は「少し弱くなる」のではなく
完全に無意味になる**。Phase 0 で必ず確定させる。

加えて現状 **ch14-17（シチョウ）と ch18-19（pass-alive）は未実装で0埋め**。
`global_input` も komi（index 5 と仮定）以外は0埋め。

---

## 1. アーキテクチャ

```
ブラウザ（web/index.html）
   │  POST /genmove  { stones, to_move, history, ko, visits, ... }
   ▼
Cloud Run  2 vCPU / 4GiB / min-instances=0 / timeout 60s
   ├─ main.py      FastAPI。visits>1 なら MCTS、1 なら生policy
   ├─ mcts.py      PUCT探索。バッチ評価 + virtual loss + top-K枝刈り + 時間予算
   ├─ features.py  盤面 → bin_input / global_input   ← ⚠️ Phase 0 の対象
   ├─ goban.py     囲碁のルール（連・呼吸点・取り・コウ・自殺手）
   └─ ONNX Runtime CPUExecutionProvider
```

**設計方針**

- **ステートレス**。対局状態はクライアントが持ち、毎リクエストで盤面全体を送る。
  サーバー側にセッションを持たない（スケールとコールドスタートの単純さを優先）
- **モデルはイメージに焼き込む**。GCSマウントでも動くがコールドスタートが伸びる
- **探索木は再利用しない**。ステートレスを崩さないため。将来の最適化ポイント（§8）

---

## 2. リポジトリ構成

```
igo-ai/
├── AGENTS.md                  Claude Code 向けのプロジェクト指示
├── docs/
│   ├── SPEC_ENGINE.md         このファイル
│   └── SPEC_UI.md             UI 側の仕様
├── engine/
│   ├── main.py                FastAPI
│   ├── mcts.py                PUCT 探索
│   ├── features.py            特徴量エンコード  ← ⚠️ Phase 0 の対象
│   ├── goban.py               ルールエンジン
│   ├── requirements.txt
│   ├── Dockerfile             ビルドコンテキストは engine/
│   ├── deploy.sh
│   ├── models/
│   │   └── model.onnx         ← .gitignore 済み
│   ├── scripts/
│   │   ├── fetch_model.sh
│   │   ├── inspect_model.py
│   │   └── verify_features.py  ★Phase 0 で新規作成
│   └── tests/                  ★Phase 1〜3 で作成
└── web/                        Vite + React + TypeScript
```

## 3. 実装フェーズ

順序に意味がある。Phase 0 を飛ばすと以降の検証が全て無意味になる。

### Phase 0 — 特徴量マップの確定 【ブロッカー】

**これが終わるまで他のフェーズの「正しさ」は判定できない。**

1. KataGo本家を取得し、`cpp/neuralnet/nninputs.cpp` の `NNInputs::fillRowV7()`
   および `python/features.py` を読む
2. 22個のバイナリ平面と19個のglobal特徴について、index → 意味 の対応表を作る
3. `engine/features.py` の `CHANNELS` 辞書と `encode()` を、その対応表に合わせて修正
4. `engine/scripts/verify_features.py` を作る:
   - 既知の局面（空盤・単純なコウ・アタリ・シチョウを含む3〜5局面）を用意
   - KataGo本家のPython実装で `bin_input` / `global_input` を生成
   - 自前の `encode()` の出力と **`np.array_equal` でバイト一致**を確認
5. ch14-17（シチョウ）と ch18-19（pass-alive）を実装する
   - pass-alive判定は Benson's algorithm。KataGoの実装を移植するのが確実
   - シチョウ判定は読み切りが必要。KataGo の `Board::searchIsLadderCaptured` を参照

**完了条件**: `verify_features.py` が全テスト局面でバイト一致を報告する。

**部分的に進める場合**: ch0-13 だけでも一致が取れれば、ch14-19 を0埋めのまま
序中盤は妥当な手を打つ。ただし終盤の精度は落ちるので、最終的には全ch実装する。

---

### Phase 1 — ルールエンジンの強化

`engine/goban.py` は実装済み。以下を追加する。

**追加する機能**

| 機能 | 理由 |
|---|---|
| 超コウ（superko）判定 | 現状は単純コウのみ。同一局面反復を盤面ハッシュ履歴で検出する |
| 終局判定 | 両者連続パス → 対局終了。現状は無限にパスできる |
| 地の計算（中国ルール） | 終局時のスコア表示。`ownership` 出力でも近似できるが正確な値が要る |
| Zobristハッシュ | 超コウ判定と、将来の置換表に使う |

**テスト（`tests/test_goban.py`）**

- 取り: 1子・複数子・複数連の同時取り
- 自殺手の禁止、ただし相手を取れる場合は合法
- 単純コウ: 取り返し禁止 → 1手他所に打てば解除
- 超コウ: 三コウ・長生で同一局面反復を検出
- `legal_mask()` と素朴な `legal_moves()` の出力一致（ランダム自己対局200局面で）

---

### Phase 2 — 推論サーバー（探索なし）

`engine/main.py` に `/health` `/genmove` `/analyze` が実装済み。`visits=1` の経路を固める。

**やること**

1. `scripts/inspect_model.py` を実行し、実機のレイテンシを実測して README の推定値を実測値に置き換える
2. モデルロードの失敗（ファイル欠損・shape不一致）を起動時に検出して明示的に落とす
   — 初回リクエストまで気づかないのは避ける
3. `policy` の長さと `board.n + 1` の不一致をエラーにする（盤サイズ違いの検出）

**完了条件**: 空盤に対して `/genmove` が妥当な初手（星・小目・三々のいずれか）を返す。
天元や1線が返ったら Phase 0 が未完了か、エンコードにバグがある。

---

### Phase 3 — MCTS

`engine/mcts.py` に実装済み。以下を検証・拡張する。

**実装済みの内容**

- PUCT: `Q + c_puct * P * sqrt(ΣN) / (1 + N)`
- 価値のバックアップは `[-1, 1]` スケール。葉の勝率 `w` を `z = 2w - 1` に変換し、
  親に遡るごとに符号反転する
- virtual loss: 選択時に `N += 1, W -= 1.0`。バックアップ時に `W += 1.0 + v` で戻す
- バッチ評価: `batch_size` 個の葉を集めてから1回の `session.run()`
- top-K枝刈り: 各ノードで policy 上位 `search_top_k` 手のみ子にする
- 時間予算: `max_time_ms` で visits 未達でも打ち切る
- 降下の深さ上限 80（無限降下よけ）

**追加でやること**

1. 終局ノードの扱い: 両者パスに到達したら推論せず、確定スコアから価値を与える
2. 超コウで着手禁止の手を候補から除く（Phase 1 の実装に依存）
3. `tests/test_mcts.py`:
   - 推論をスタブ化し、非合法手を返さないことを確認（30試行で0件）
   - `visits` 指定が守られること
   - `max_time_ms` で打ち切られること
   - **詰みの局面で正解手を選ぶこと**（1手で取れる石がある局面など。
     探索が機能していれば生policyより確実に当てる）

**完了条件**: 上記テストが通り、`visits=30` が `nn_calls ≈ 5` 回の推論で完了する
（バッチ化が効いていることの確認）。

---

### Phase 4 — Web クライアント

`web/` に Vite + React + TypeScript のスケルトンあり。
**詳細は `docs/SPEC_UI.md`** に分けてある。エンジン側から見た契約だけ再掲:

- UI は毎リクエストで盤面を丸ごと送る（サーバーはステートレス）
- 座標は一次元 index で統一。`-1` がパス
- `web/src/types.ts` の型は `engine/main.py` の Pydantic モデルと手で同期させる

### Phase 4.5 — ローカル（Mac）での実行

**開発とプレイはローカルで完結する。Cloud Run は共有したくなった時だけ。**

Mac は Apple Silicon（arm64）。ONNX Runtime には **CoreMLExecutionProvider** があり、
Neural Engine / GPU にオフloadできる。

```python
ort.InferenceSession(path, providers=["CoreMLExecutionProvider", "CPUExecutionProvider"])
```

これが効けば Cloud Run の CPU より大幅に速くなる可能性があり、そうなると
**b18c384 への変換が不要になり、visits も 100 以上が射程に入る**。
ただし CoreML EP は全オペレーターをサポートしておらず、未対応opは CPU に
フォールバックする。**実測してから既定値を決めること。**

**やること**: `inspect_model.py` の providers を差し替えて、
CPU fp32 / CoreML fp32 / CoreML fp16 の3通りを測り、最速の組み合わせを既定にする。
その結果次第で visits の上限とネット変換の必要性が変わる。

> ユニファイドメモリなので、GPU/ANE に回しても VRAM への別コピーは発生しない。

---

### Phase 5 — Cloud Runデプロイ

`deploy.sh` に実装済み。

**設定値と根拠**

| 設定 | 値 | 根拠 |
|---|---|---|
| `--cpu` | 2 | ORT_THREADS=2 と揃える。過剰なスレッドは競合で遅くなる |
| `--memory` | 4Gi | モデル数百MB + ORTのワークスペース |
| `--concurrency` | 4 | 推論はCPUを使い切るので詰め込まない |
| `--min-instances` | 0 | アイドル課金を避ける。コールドスタートは許容 |
| `--timeout` | 60s | `max_time_ms` の上限55秒より長く取る |
| `--cpu-boost` | 有効 | コールドスタート時のモデルロードを速くする |

**やること**

1. `ALLOW_ORIGINS` を `*` から実際のフロントのオリジンに絞る
2. コールドスタートの実測。許容できなければ `--min-instances 1` か uint8量子化版を検討
3. 認証。公開するなら最低限のレート制限を入れる（1推論が数百ms CPUを使うので、
   無防備だと簡単に課金が膨らむ）

---

## 3.5 モデルの置き場所

### Cloud Run — イメージに焼き込む（推奨）

**10GB未満のモデルはイメージに入れるのが Google の推奨構成**で、妥協案ではない。
Cloud Run が**ブロック単位のイメージストリーミング**を使い、必要なブロックだけ
遅延ロードするため、イメージが大きくてもコールドスタートが線形に悪化しない。

| 方式 | 評価 |
|---|---|
| **イメージに焼き込む** | 10GB未満はこれ |
| GCS から起動時に並列ダウンロード | 10GB超向け。今回は過剰 |
| Cloud Storage FUSE マウント | 楽だが初回DLが並列化されず遅い |
| 起動時に HF からダウンロード | 避ける。最も遅く予測不能 |

**レイヤー順が重要。** モデルをコードより先に COPY する（`Dockerfile` に明記済み）。
逆順だとコードを1行直すたびに294MBが再pushされる。

**ビルドコンテキストの罠。** `gcloud builds submit` はレイヤーキャッシュとは別に、
コンテキスト全体（models/ 含む）を毎回アップロードする。
煩わしければローカルで `docker build` → `docker push`。

**コールドスタートの内訳**（要実測）: イメージ pull はストリーミングで1〜2秒。
支配的なのは ONNX Runtime のセッション初期化と294MBのメモリ読み込みで、
おそらく5秒前後。`so.optimized_model_filepath` で最適化済みグラフを
ビルド時に書き出せば起動時の最適化をスキップできる。

### 精度はターゲットで変える

| 環境 | 精度 | サイズ | 理由 |
|---|---|---|---|
| Cloud Run（CPU） | **fp32** | 約294MB | CPU では fp16 は都度変換が入って逆に遅い |
| Mac（CoreML / ANE・GPU） | **fp16** | 約147MB | ANE/GPU は fp16 がネイティブ |
| メモリ制約が厳しい場合 | uint8 | 約74MB | 棋力がわずかに落ちる |

### git には入れない

GitHub は1ファイル100MBがハードリミットで294MBは push が弾かれる。
`.gitignore` 済み。取得は `scripts/fetch_model.sh`。

---

## 4. API仕様

### `POST /genmove`

**リクエスト**

| フィールド | 型 | 既定 | 説明 |
|---|---|---|---|
| `size` | int | 19 | 盤サイズ |
| `stones` | int[] | 必須 | 長さ `size²`。0=空 1=黒 2=白 |
| `to_move` | int | 1 | 1=黒 2=白 |
| `history` | int[] | `[]` | 直近の着手。-1=パス。直近5手が特徴量に入る |
| `ko` | int | -1 | 単純コウで着手禁止の点 |
| `komi` | float | 7.5 | |
| `visits` | int | 1 | MCTS探索回数。**1なら探索なし** |
| `max_time_ms` | int | 10000 | 探索の打ち切り時間（100〜55000） |
| `c_puct` | float | 1.4 | 大きいほど広く浅く探索 |
| `search_top_k` | int | 24 | 各ノードの候補手数 |
| `batch_size` | int | 8 | 1回の推論でまとめる葉の数 |
| `temperature` | float | 0.0 | 0=最善手。大きいほどばらけて弱くなる |
| `top_k` | int | 0 | 候補手を上位k件返す |

**レスポンス**

```json
{
  "move": 72,            // 盤上index。-1 = パス
  "gtp": "D16",
  "winrate": 0.534,      // 手番側の勝率
  "confidence": 0.31,    // 訪問割合（探索時）/ policy確率（探索なし）
  "visits": 30,
  "nn_calls": 5,         // 実際の推論回数。バッチ化の効きを確認できる
  "inference_ms": 3312.0,
  "search": true,
  "candidates": [{"move": 72, "gtp": "D16", "visits": 13, "winrate": 0.55}]
}
```

### `POST /analyze`

リクエストは `/genmove` と同じ。勝率と `ownership`（地の所有権, 長さ `size²`）を返す。
解説・形勢グラフ用。

### `GET /health`

`{"ok": true, "threads": 2, "model": "model.onnx"}`

---

## 5. 性能目標

### 実測根拠

2 vCPU / AVX-512 環境で fp32 GEMM **350 GFLOPS** を実測。
ネットの演算量から算出した1局面あたりのレイテンシ:

| ネット | 演算量 | 推定レイテンシ |
|---|---|---|
| b18c384nbt | 19.2 GFLOP | 100〜160 ms |
| b28c512nbt | 53.0 GFLOP | 280〜430 ms |

### visits別の所要時間

**CPUはバッチ1で既にコアが飽和するため、バッチ化の利得は1.3倍程度**
（GPUのように8倍にはならない）という前提で算出。

| visits | b28c512 | b18c384 |
|---|---|---|
| 1 | 0.3秒 | 0.1秒 |
| 10 | 2.8秒 | 1.2秒 |
| 30 | 7.5秒 | **3.3秒** |
| 60 | 14.7秒 | 6.4秒 |
| 100 | 24.3秒 | 10.6秒 |

### 目標

- **1手あたり5秒以内**
- → **b18c384nbt に変換し、visits=30 を既定とする**

`kaya-go/kaya` に置いてあるのは b28c512nbt のみ。
[kaya-go/katago-onnx](https://github.com/kaya-go/katago-onnx) で b18c384nbt を自分で変換する。

> 探索を入れないなら b28c512 のままで良い（0.3秒で収まり、棋力差は体感できない）。
> ネットサイズが効くのは探索を入れた時だけ。

---

## 6. 受け入条件

実装完了と判定する条件。

- [ ] `verify_features.py` が全テスト局面で KataGo本家とバイト一致
- [ ] `tests/` が全て通る
- [ ] 空盤への `/genmove` が星・小目・三々のいずれかを返す
- [ ] `visits=30` が5秒以内に完了し、`nn_calls` が10回未満（バッチ化が効いている）
- [ ] 1手で石を取れる局面で、探索ありが確実にその手を選ぶ
- [ ] ランダム自己対局100局で非合法手・例外が0件
- [ ] Cloud Runにデプロイ後、ブラウザから19路を1局完走できる
- [ ] コールドスタート時間を実測し、READMEに記録

---

## 7. やらないこと

意図的にスコープ外とするもの。

- **GPU対応**。数百visits以上が必要になった時点で検討する
- **探索木の再利用**。ステートレスAPIを崩すため（§8で再検討）
- **Dirichletノイズ**。自己対話の多様性用。人間と打つだけなら不要
- **自己対局による学習**。学習済み重みを使うだけ
- **9路・13路対応**。`size` は受けるが検証は19路のみ
- **Gemini連携の解説機能**。対局が安定してから別途

---

## 8. 将来の拡張

優先度順。

1. **探索木の再利用** — 対局セッションを持たせ、前手の探索結果を引き継ぐ。
   実質2倍の visits が稼げる。ステートレスを崩すトレードオフ
2. **置換表** — 同一局面の推論結果をキャッシュ。Zobristハッシュ（Phase 1）が前提
3. **Cloud Run GPU (L4)** — b28c512 で数百visitsが現実的になる。常時課金とのトレードオフ
4. **AI解説** — `/analyze` の勝率と `ownership` を Gemini に渡して日本語化。
   Agent Platform の Agent Engine でツールとして `/analyze` を叩く構成が素直
5. **棋譜のSGF入出力** — 検討機能の前提

---

## 9. 参照

| 対象 | URL |
|---|---|
| モデル（ONNX） | https://huggingface.co/kaya-go/kaya |
| 重みのライセンス原文 | https://katagotraining.org/network_license/ |
| ONNX変換ツール | https://github.com/kaya-go/katago-onnx |
| KataGo本家（特徴量の一次情報） | https://github.com/lightvector/KataGo |
| KataGo論文 | https://arxiv.org/abs/1902.10565 |
| Cloud Run カスタムコンテナ | https://cloud.google.com/run/docs/deploying |

**ライセンス**: 重みは KataGo の **Neural Network License**（本文は MIT と同一だが、コードの
LICENSE とは別の許諾。本家 LICENSE は "content in this repo" が対象で、重みは含まれない）。
ONNX変換版はモデルカード上 MIT。

変換ツール `kaya-go/katago-onnx` 自体は AGPL-3.0 で、モデルカードの MIT 表記と食い違う
（2026-09-22 確認）。本プロジェクトは .onnx 成果物のみを使いツールのソースは取り込まない。
