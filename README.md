# igo-ai

KataGo のニューラルネット（ONNX / MIT）を使った囲碁の対局・解析アプリ。

- `engine/` — Python の推論サーバー。FastAPI + ONNX Runtime + 自前の MCTS
- `web/` — Vite + React + TypeScript の対局 UI
- `docs/` — 実装仕様書

## クイックスタート

```bash
# 1. モデルを取得（約147MB / fp16。Mac なら CoreML 用に fp16 を使う）
cd engine && ./scripts/fetch_model.sh

# 2. 実機のレイテンシを実測（features.py の前提と合っているかも確認できる）
python3 scripts/inspect_model.py models/model.onnx 8

# 3. エンジン起動
pip install -r requirements.txt
MODEL_PATH=$PWD/models/model.onnx uvicorn main:app --port 8080

# 4. UI 起動（別ターミナル）
cd web && npm install && npm run dev
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

コードは MIT。KataGo の重みおよび
[kaya-go/kaya](https://huggingface.co/kaya-go/kaya) の ONNX 変換版も MIT。
