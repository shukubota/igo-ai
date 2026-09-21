# igo-ai — プロジェクト指示

KataGo のニューラルネット（ONNX）を使った囲碁の対局・解析アプリ。
`engine/`（Python / FastAPI / ONNX Runtime / 自前MCTS）と
`web/`（Vite + React + TypeScript）のモノレポ。

## 最重要：着手前に読むこと

`engine/features.py` の **22ch の index → 意味の対応が未検証**。
これがズレていると、他の全コードが正しくても出力は無意味になる。

- 正解は KataGo 本家の `cpp/neuralnet/nninputs.cpp` の `NNInputs::fillRowV7()` のみ
- `docs/SPEC_ENGINE.md` の Phase 0 を他のどのフェーズより先に終わらせる
- 「動いているように見えるが実は乱数」という状態になりうる。
  初手が天元や1線なら、まずここを疑う

## モデルファイル

`engine/models/model.onnx` は `.gitignore` 済みだが **ディスク上には必須**。
「git で追跡しない」と「置かなくていい」を混同しないこと。
GitHub の1ファイル100MB上限に引っかかるため追跡しないだけ。

取得は `engine/scripts/fetch_model.sh`（精度を引数で選ぶ。既定 fp16）。
clone 直後はこのファイルが無い。エンジンが起動しない場合はまずこれを疑う。

## 確定していること（再調査不要）

| 項目 | 値 |
|---|---|
| ONNX 入力 | `bin_input [B,22,H,W]`, `global_input [B,19]`（ともに float32） |
| ONNX 出力 | `policy [B,2,362]`, `value [B,3]`, `ownership [B,1,H,W]` ほか |
| policy の末尾 index | `361` = パス |
| パラメータ数 | 約 73M（b28c512nbt） |
| ファイルサイズ | fp32 294MB / fp16 147MB / uint8 74MB |
| ライセンス | コードは MIT。**重みは KataGo Neural Network License**（MIT と同文言だがコードとは別の許諾）。詳細は README のライセンス節 |

## 測ってある数値（推測で置き換えないこと）

- 合法手マスク: `legal_mask()` 0.05ms、素朴な全点flood fill 1.03ms（**21倍差**）
- MCTS の Python 実装コスト: **0.3 ms/visit**。ボトルネックは推論であって Python ではない
- CPU 演算性能: 2 vCPU / AVX-512 で fp32 GEMM 350 GFLOPS
- **CPU はバッチ1でコアが飽和する**ので、バッチ化の利得は 1.3 倍程度。
  GPU のように 8 倍にはならない

## 設計上の決定と理由

- **エンジンはステートレス**。盤面は毎リクエストで丸ごと送る。
  → Cloud Run で `min-instances=0` にできる。代償として探索木を再利用できない
- **探索は `visits` パラメータで可変**。`visits=1` は探索なし（生policy）で別経路
- **モデルはイメージに焼き込む**。10GB未満は Google の推奨構成。
  Cloud Run のブロック単位イメージストリーミングが効くため
- **精度はターゲットで変える**。Cloud Run(CPU)=fp32 / Mac(CoreML)=fp16。
  CPU で fp16 を使うと都度変換が入って逆に遅い
- **UI 側にもルール実装を持つ**（`web/src/goban/rules.ts`）。
  着手の即時反映のため。サーバー側が正（`engine/goban.py`）で、
  食い違ったらサーバーに合わせる

## コーディング規約

- Python: 型ヒントを付ける。コメントは「なぜ」を書く（「何を」はコードが語る）
- TypeScript: `strict: true`。API の型は `web/src/types.ts` に集約し、
  `engine/main.py` の Pydantic モデルと手で同期させる（片方だけ直さない）
- 盤上の座標は**一次元 index**（`0..size*size-1`）で統一。`-1` がパス。
  engine と web で同じ規約を使う
- 数値を文書やコードコメントに書くときは、実測値と推定値を区別して書く

## やらないこと

GPU 対応、探索木の再利用、Dirichlet ノイズ、自己対局学習、
9路・13路の検証、Gemini 連携の解説機能。
必要になったら `docs/SPEC_ENGINE.md` の「将来の拡張」から拾う。

## コミット

- 1フェーズ = 1コミット以上。フェーズ跨ぎの巨大コミットは避ける
- テストが落ちている状態でコミットしない
