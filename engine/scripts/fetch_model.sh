#!/usr/bin/env bash
# KataGo の ONNX モデルを engine/models/model.onnx に配置する。
#
# .gitignore しているのは「git で追跡しない」という意味だけで、
# このファイル自体はディスク上に必須。無いとエンジンは起動しない。
#
# 使い方:
#   ./scripts/fetch_model.sh            # fp16（Mac / CoreML 向け・既定）
#   ./scripts/fetch_model.sh fp32       # Cloud Run / CPU 向け
#   ./scripts/fetch_model.sh uint8      # メモリ制約が厳しい場合
set -euo pipefail

REPO="kaya-go/kaya"
PREC="${1:-fp16}"
DEST_DIR="$(cd "$(dirname "$0")/.." && pwd)/models"
DEST="$DEST_DIR/model.onnx"

case "$PREC" in
  fp16)  echo "→ fp16（約147MB）: Mac の CoreML / ANE・GPU 向け" ;;
  fp32)  echo "→ fp32（約294MB）: Cloud Run / CPU 向け。CPU では fp16 より速い" ;;
  uint8) echo "→ uint8（約74MB）: 軽いが棋力がわずかに落ちる" ;;
  *) echo "精度は fp16 / fp32 / uint8 のいずれか（指定: $PREC）" >&2; exit 1 ;;
esac

mkdir -p "$DEST_DIR"

if ! command -v hf >/dev/null 2>&1 && ! command -v huggingface-cli >/dev/null 2>&1; then
  echo "huggingface_hub を入れます..."
  pip install -q -U "huggingface_hub[cli]"
fi
HF=$(command -v hf || command -v huggingface-cli)

# ── ファイル名はハードコードせず、リポジトリの実ファイル一覧から探す ──
# モデル名（チェックポイント）や拡張子の付け方が変わっても壊れないようにする。
echo "リポジトリのファイル一覧を取得..."
FILE=$(python3 - "$REPO" "$PREC" <<'PY'
import json, sys, urllib.request
repo, prec = sys.argv[1], sys.argv[2]
url = f"https://huggingface.co/api/models/{repo}"
with urllib.request.urlopen(url, timeout=30) as r:
    data = json.load(r)
names = [s["rfilename"] for s in data.get("siblings", [])]
cands = [n for n in names if n.endswith(".onnx") and prec in n.lower()]
if not cands:
    onnx = [n for n in names if n.endswith(".onnx")]
    print(f"NOTFOUND\t{prec} の .onnx が見つかりません。候補:\n  " + "\n  ".join(onnx or ["(なし)"]),
          file=sys.stderr)
    sys.exit(1)
# 同じ精度が複数あればファイル名が新しそうな方（辞書順で最後）を採る
print(sorted(cands)[-1])
PY
)
echo "対象: $FILE"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
"$HF" download "$REPO" "$FILE" --local-dir "$TMP"

# hf のバージョンによってはキャッシュへのシンボリックリンクになるので実体をコピーする
# （そのままだと ~/.cache/huggingface を消した時に壊れる）
cp -L "$TMP/$FILE" "$DEST"
echo
ls -lh "$DEST"

# ── 配置できたら即座に検証する ──────────────────────────────────
# features.py が前提にしている入出力名と一致しているかを、ここで確かめる。
# ここがズレていたら SPEC_ENGINE.md の Phase 0 の前提そのものが違う。
echo
echo "=== 入出力の確認 ==="
python3 - "$DEST" <<'PY' || echo "(onnxruntime が未インストール。pip install -r requirements.txt 後に scripts/inspect_model.py で確認)"
import sys
import onnxruntime as ort
s = ort.InferenceSession(sys.argv[1], providers=["CPUExecutionProvider"])
ins = {i.name: i.shape for i in s.get_inputs()}
outs = {o.name: o.shape for o in s.get_outputs()}
for n, sh in ins.items():  print(f"  in   {n:14s} {sh}")
for n, sh in outs.items(): print(f"  out  {n:14s} {sh}")
expected = {"bin_input", "global_input"}
if set(ins) != expected:
    print(f"\n  ⚠️  入力名が features.py の前提と違います: {set(ins)} != {expected}")
    print("      engine/features.py の encode() の返し方を合わせること。")
    sys.exit(1)
b = ins["bin_input"]
if len(b) == 4 and isinstance(b[1], int) and b[1] != 22:
    print(f"\n  ⚠️  bin_input のチャンネル数が {b[1]} です（22 を前提にしています）")
    sys.exit(1)
print("\n  ✓ features.py の前提（bin_input[B,22,H,W] / global_input[B,19]）と一致")
PY

echo
echo "次: python3 scripts/inspect_model.py models/model.onnx 8   # レイテンシ実測"
