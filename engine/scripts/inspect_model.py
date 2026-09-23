#!/usr/bin/env python3
"""モデルの実際の入出力名・shapeを表示し、CPUでの推論時間を実測する。
デプロイ前に必ずこれを走らせて features.py の前提と一致するか確認すること。"""
import sys
import time

import numpy as np
import onnxruntime as ort

path = sys.argv[1] if len(sys.argv) > 1 else "models/model.onnx"
threads = int(sys.argv[2]) if len(sys.argv) > 2 else 2
board = int(sys.argv[3]) if len(sys.argv) > 3 else 19

# fp16 版のモデルは入出力そのものが float16。float32 を渡すと
# InvalidArgument で落ちるので、モデルが申告する型に合わせる。
NP_DTYPE = {
    "tensor(float)": np.float32,
    "tensor(float16)": np.float16,
    "tensor(double)": np.float64,
    "tensor(int64)": np.int64,
    "tensor(int32)": np.int32,
    "tensor(bool)": np.bool_,
}


def concrete(dim: object) -> int:
    """動的次元を実寸に置き換える。

    height/width を 1 のまま測ると 1x1 盤の推論時間になり、
    レイテンシの数字が桁で狂う。盤サイズを入れる。
    """
    if isinstance(dim, int):
        return dim
    name = str(dim or "").lower()
    if "height" in name or "width" in name:
        return board
    return 1  # batch など

so = ort.SessionOptions()
so.intra_op_num_threads = threads
so.inter_op_num_threads = 1
t = time.perf_counter()
s = ort.InferenceSession(path, sess_options=so, providers=["CPUExecutionProvider"])
print(f"load: {time.perf_counter()-t:.2f}s  (threads={threads})\n")

print("== inputs ==")
feeds = {}
for i in s.get_inputs():
    print(f"  {i.name:16s} {i.type:24s} {i.shape}")
    shape = [concrete(d) for d in i.shape]
    dtype = NP_DTYPE.get(i.type, np.float32)
    print(f"    -> feed {shape} as {np.dtype(dtype).name}")
    feeds[i.name] = np.zeros(shape, dtype=dtype)

print("\n== outputs ==")
for o in s.get_outputs():
    print(f"  {o.name:16s} {o.type:24s} {o.shape}")

s.run(None, feeds)  # warmup
N = 10
t = time.perf_counter()
for _ in range(N):
    outs = s.run(None, feeds)
ms = (time.perf_counter() - t) / N * 1000
print(f"\n== benchmark ==\n  {ms:.0f} ms / position  ({1000/ms:.1f} evals/sec, {threads} threads, {board}x{board})")
print("\n== output shapes (actual) ==")
for o, v in zip(s.get_outputs(), outs, strict=True):
    print(f"  {o.name:16s} {np.asarray(v).shape}")
