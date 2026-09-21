#!/usr/bin/env python3
"""モデルの実際の入出力名・shapeを表示し、CPUでの推論時間を実測する。
デプロイ前に必ずこれを走らせて features.py の前提と一致するか確認すること。"""
import sys, time, numpy as np, onnxruntime as ort

path = sys.argv[1] if len(sys.argv) > 1 else "models/model.onnx"
threads = int(sys.argv[2]) if len(sys.argv) > 2 else 2

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
    shape = [1 if (isinstance(d, str) or d is None) else d for d in i.shape]
    feeds[i.name] = np.zeros(shape, dtype=np.float32)

print("\n== outputs ==")
for o in s.get_outputs():
    print(f"  {o.name:16s} {o.type:24s} {o.shape}")

s.run(None, feeds)  # warmup
N = 10
t = time.perf_counter()
for _ in range(N):
    outs = s.run(None, feeds)
ms = (time.perf_counter() - t) / N * 1000
print(f"\n== benchmark ==\n  {ms:.0f} ms / position  ({1000/ms:.1f} evals/sec, {threads} threads)")
print("\n== output shapes (actual) ==")
for o, v in zip(s.get_outputs(), outs):
    print(f"  {o.name:16s} {np.asarray(v).shape}")
