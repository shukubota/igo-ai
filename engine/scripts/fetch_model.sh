#!/usr/bin/env bash
# モデルを取得して models/model.onnx に置く。ネットが通る手元のMacで実行すること。
set -euo pipefail
mkdir -p models

# 精度を選ぶ:
#   fp32  … CPU推論はこれが最速かつ最も安定（fp16はCPUだと逆に遅い）
#   uint8 … さらに軽いが棋力がわずかに落ちる。メモリ制約が厳しい時のみ
REPO="kaya-go/kaya"
FILE="kata1-b28c512nbt-adam-s11165M-d5387M/model.fp32.onnx"   # 実際のパスは要確認

pip install -q "huggingface_hub[cli]"
hf download "$REPO" "$FILE" --local-dir ./models
mv "./models/$FILE" ./models/model.onnx
ls -lh models/model.onnx
