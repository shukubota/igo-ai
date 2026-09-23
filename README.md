# igo-ai

KataGo のニューラルネット（ONNX）を使った囲碁の対局・解析アプリ。

- `engine/` — Python の推論サーバー。FastAPI + ONNX Runtime + 自前の MCTS
- `web/` — Vite + React + TypeScript の対局 UI
- `docs/` — 実装仕様書

## クイックスタート

```bash
# 1. モデルを取得（約147MB / fp16。Mac なら CoreML 用に fp16 を使う）
cd engine && ./scripts/fetch_model.sh && cd ..

# 2. エンジン起動（Docker）。healthy になるまで待つ
docker compose up -d --wait

# 3. UI 起動（別ターミナル）。UI は Docker に載せずホストで動かす
cd web && npm install && npm run dev
```

http://localhost:5173 を開く。既定は13路。

```bash
docker compose logs -f engine   # エンジンのログ
docker compose down             # 停止

# 実機のレイテンシを実測（features.py の前提と合っているかも確認できる）
docker compose exec engine python scripts/inspect_model.py /models/model.onnx 4
```

### エンジンをホストで直接動かす場合

macOS では Docker が VM を挟むぶん遅い（**実測でコンテナ 299ms / ホスト 62ms**、
1手あたり）。エンジンを触りながら強さを見るときはこちらが快適。

```bash
cd engine
python3.12 -m venv .venv          # onnxruntime は 3.14 の wheel が無い
.venv/bin/pip install -r requirements.txt
MODEL_PATH=$PWD/models/model.onnx ORT_THREADS=8 \
  .venv/bin/python -m uvicorn main:app --port 8080 --reload \
  --reload-exclude '.venv/*' --reload-exclude 'models/*'
```

## モデルファイルについて

`engine/models/model.onnx` は **ディスク上に必須**（無いとエンジンが起動しない）。
`.gitignore` しているのは「git で追跡しない」という意味だけで、置かなくていい
わけではない。GitHub の1ファイル100MB上限に引っかかるため追跡しないだけ。

```bash
cd engine
./scripts/fetch_model.sh          # fp16（Mac / CoreML 向け・既定）
./scripts/fetch_model.sh fp32     # Cloud Run / CPU 向け
```

clone しただけでは動かない。必ずこれを実行する。

## 棋譜を取り込んで検討する

対局後の振り返り用に、外部の棋譜を読み込める。読み込むと検討モードに入り、
盤の下のシークバーで手を戻したり、任意の局面をエンジンに解析させたりできる。

**囲碁クエスト** — UI 左上に棋譜の URL か対局 ID を貼る。

```
https://kifu.questgames.net/go/ud6x5f3mvi0m
```

先方が CORS を許可していないのでブラウザからは直接取れず、エンジンが中継する
（`POST /kifu`）。渡した URL をそのまま取りに行くと SSRF の入口になるため、
ID だけ抜いてサーバー側で URL を組み立て直している（`engine/kifu.py`）。

**ローカルの JSON** — 同じパネルのファイル選択から読む。下の LLM 対局の出力が
そのまま入る。

検討モードでできること:

- **全手を解析** — 全局面を評価して勝率の折れ線を作る。visits=1 固定（探索は
  要らず、130手を探索つきで回すと分単位になるため）
- **AI候補** — 各局面での候補手を盤に重ねる。実戦の手は赤い輪で示すので、
  推奨手と実際に打った手を見比べられる
- **自分の視点** — 対局者を選ぶと、その色の手だけを失点の大きい順に並べる

## Claude と KataGo を対局させる

`engine/scripts/llm_vs_katago.py` が、Claude に盤面をテキストで渡して1手ずつ
打たせ、KataGo と対局させる。棋譜は上の検討モードにそのまま読み込める形で出る。

```bash
cd engine
.venv/bin/python scripts/llm_vs_katago.py --size 13 --visits 8 --llm-color black
```

棋譜は `engine/games/<日時>_<盤>路.json` に**毎手保存**される（途中で落ちても
そこまでが残る）。`--out ~/Desktop/game.json` で保存先を変えられる。

### 認証

Anthropic SDK ではなく `claude -p`（Claude Code のヘッドレス実行）を毎手起動する。
**Claude Code のログインをそのまま使うので API キーは要らない**。逆に SDK 直叩きは
`ANTHROPIC_API_KEY` 等を別途要求するので、この経路にしている。
使用量はログイン中のアカウントに乗る。

### 主なオプション

| | |
|---|---|
| `--size 9/13/19` | 盤サイズ |
| `--llm-color black/white` | Claude の手番 |
| `--visits N` | KataGo の強さ。`1` で探索なし（ハンデ） |
| `--model` | 既定 `claude-opus-5`。`claude-sonnet-5` で速く・安く |
| `--max-moves N` | 既定は盤の広さ×1.2手。**実質の使用量上限** |
| `--resign-after 0.6` | 盤の広さに対して何割進んだら投了を許すか。`1.0` で実質無効 |
| `--resign-at 0.98` | KataGo の勝率がこれを超え続けたら相手を投了させる |

### 実測値（Opus 5 / 13路）

| | 起動 | API | 出力 |
|---|---|---|---|
| 空盤 | 1.1s | 1.2s | 4 tok |
| 中盤の競り合い | 1.1s | **32〜49s** | 2168〜3455 tok |

**遅いのは思考しているから**で、出力の98%が thinking トークン。囲碁はテキストから
連・呼吸点・アタリを毎回数え直す必要があり、LLM には重い。プロセス起動は1秒強で
一定、MCP を空にしても変わらない。

13路を最終盤まで打たせると Claude の手番が100手前後になるので、**1局 50〜80分 /
$20〜30 相当**を見込むこと。短く済ませるなら `--max-moves` を切るか
`--model claude-sonnet-5` に落とす。

### 期待値

**KataGo にはまるで歯が立たない。** 13路の実測では12手目で KataGo の勝率が 0.984、
22手目で 1.000 に達した。一方で Claude の着手理由は最後までもっともらしく読める。

> 白の F3・G3 二子をアタリにして、下辺の白全体を眼のないまま追い込む先手の好点です。

強さを競わせるより、**この「自信と実際の評価のズレ」を検討モードで観察する**のが
このスクリプトの用途。棋譜には各手の `by`（誰が打ったか）と `note`（Claude 本人の
説明）が入るので、検討パネルで評価値と並べて読める。

## ⚠️ 最初にやること

`engine/features.py` の 22ch の対応が未検証。ここがズレていると
**出力は「少し弱い」ではなく無意味になる**。
`docs/SPEC_ENGINE.md` の Phase 0 を最優先で終わらせること。

初手が天元や1線に来たら、まずこれを疑う。

## ドキュメント

| ファイル | 内容 |
|---|---|
| [docs/SPEC_ENGINE.md](docs/SPEC_ENGINE.md) | エンジン側の仕様・実装フェーズ・API 仕様・性能目標 |
| [docs/SPEC_UI.md](docs/SPEC_UI.md) | UI 側の仕様・画面構成・状態設計・実装フェーズ |
| [AGENTS.md](AGENTS.md) | Claude Code 向けのプロジェクト指示 |

## ライセンス

コードは MIT（[LICENSE](LICENSE)）。

利用している第三者の成果物:

| 対象 | ライセンス |
|---|---|
| [KataGo](https://github.com/lightvector/KataGo)（David J. Wu / lightvector） | MIT |
| KataGo の学習済みネット（kata1 run） | [KataGo Neural Network License](https://katagotraining.org/network_license/) |
| [kaya-go/kaya](https://huggingface.co/kaya-go/kaya)（ONNX 変換版） | MIT |

重みは KataGo 本体のコードとは別のライセンスで提供されている点に注意
（本家リポジトリの LICENSE は "content in this repo" が対象で、重みは含まれない）。
