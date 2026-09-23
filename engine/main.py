"""KataGo ONNX 推論サーバー（Cloud Run / CPU 向け）。

探索（MCTS）は行わない。1リクエスト = 1推論。
"""
from __future__ import annotations

import logging
import os
import threading
import time

import numpy as np
import onnxruntime as ort
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

import features as F
import kifu
from goban import PASS, Board
from mcts import MCTS

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("goai")

MODEL_PATH = os.environ.get("MODEL_PATH", "/models/model.onnx")
# Cloud Run の vCPU 数に合わせる。過剰なスレッドはむしろ遅くなる。
THREADS = int(os.environ.get("ORT_THREADS", os.cpu_count() or 2))
ALLOW_ORIGINS = os.environ.get("ALLOW_ORIGINS", "*").split(",")

_session: ort.InferenceSession | None = None
_lock = threading.Lock()


def get_session() -> ort.InferenceSession:
    """初回リクエスト時にロード（コールドスタートをログに残す）。"""
    global _session
    if _session is None:
        with _lock:
            if _session is None:
                t = time.perf_counter()
                so = ort.SessionOptions()
                so.intra_op_num_threads = THREADS
                so.inter_op_num_threads = 1
                so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
                _session = ort.InferenceSession(
                    MODEL_PATH, sess_options=so, providers=["CPUExecutionProvider"]
                )
                log.info("model loaded in %.2fs (threads=%d)", time.perf_counter() - t, THREADS)
    return _session


app = FastAPI(title="Go AI (KataGo ONNX)", version="1.0")
app.add_middleware(
    CORSMiddleware, allow_origins=ALLOW_ORIGINS,
    allow_methods=["POST", "GET"], allow_headers=["*"],
)


class Position(BaseModel):
    size: int = 19
    stones: list[int] = Field(..., description="0=空 1=黒 2=白、長さ size*size")
    to_move: int = Field(1, description="1=黒 2=白")
    history: list[int] = Field(default_factory=list, description="直近の着手（-1=パス）")
    ko: int = -1
    komi: float = 7.5
    temperature: float = Field(0.0, ge=0.0, le=2.0,
                               description="0=最善手、大きいほどばらけて弱くなる")
    top_k: int = Field(0, ge=0, description="候補手を上位k件返す（0なら返さない）")

    # --- 探索パラメータ ---
    visits: int = Field(1, ge=1, le=2000,
                        description="MCTSの探索回数。1なら探索なし（生policy）")
    max_time_ms: int = Field(10000, ge=100, le=55000,
                             description="探索の打ち切り時間。Cloud Runのtimeoutより 短く設定すること")
    c_puct: float = Field(1.4, gt=0.0, le=8.0, description="探索の広さ。大きいほど広く浅く")
    search_top_k: int = Field(24, ge=2, le=100,
                              description="各ノードで候補にする手の数。CPUでは絞った方が強い")
    batch_size: int = Field(8, ge=1, le=32,
                            description="1回の推論でまとめて評価する葉の数")


def _run(board: Board, komi: float):
    sess = get_session()
    bin_in, glob_in = F.encode(board, komi=komi)
    dt = F.input_dtype(sess)
    t = time.perf_counter()
    out = sess.run(None, {"bin_input": bin_in.astype(dt, copy=False),
                          "global_input": glob_in.astype(dt, copy=False)})
    ms = (time.perf_counter() - t) * 1000.0
    names = [o.name for o in sess.get_outputs()]
    return dict(zip(names, out, strict=True)), ms


@app.get("/health")
def health():
    return {"ok": True, "threads": THREADS, "model": os.path.basename(MODEL_PATH)}


def _genmove_search(board: Board, pos: Position):
    """MCTSで着手を決める。"""
    engine = MCTS(get_session(), c_puct=pos.c_puct, top_k=pos.search_top_k,
                  batch_size=pos.batch_size, komi=pos.komi)
    root, stats = engine.search(board, visits=pos.visits, max_time_ms=pos.max_time_ms)
    a, dist = MCTS.pick(root, pos.temperature)
    mv = int(root.moves[a])
    q = float(root.W[a] / root.N[a]) if root.N[a] > 0 else 0.0

    body = {
        "move": PASS if mv == board.n else mv,
        "gtp": board.to_gtp(mv),
        "winrate": (q + 1.0) / 2.0,          # [-1,1] を勝率に戻す
        "confidence": float(dist[a]),
        "visits": stats["visits"],
        "nn_calls": stats["nn_calls"],
        "inference_ms": stats["elapsed_ms"],
        "search": True,
    }
    if pos.top_k:
        order = np.argsort(-root.N)[: pos.top_k]
        body["candidates"] = [
            {"move": int(root.moves[i]) if int(root.moves[i]) != board.n else PASS,
             "gtp": board.to_gtp(int(root.moves[i])),
             "visits": int(root.N[i]),
             "winrate": float((root.W[i] / root.N[i] + 1) / 2) if root.N[i] > 0 else None}
            for i in order if root.N[i] > 0
        ]
    return body


@app.post("/genmove")
def genmove(pos: Position):
    """次の一手を返す。visits>1 ならMCTS、1なら生policy。"""
    try:
        board = Board.from_dict(pos.model_dump())
    except ValueError as e:
        raise HTTPException(400, str(e)) from e

    if pos.visits > 1:
        return _genmove_search(board, pos)

    res, ms = _run(board, pos.komi)
    policy = np.asarray(res["policy"])[0, 0].astype(np.float64)  # [n+1]
    legal = board.legal_mask()
    if policy.shape[0] != legal.shape[0]:
        raise HTTPException(500, f"policy len {policy.shape[0]} != {legal.shape[0]}")

    probs = F.softmax_masked(policy, legal)
    if pos.temperature <= 1e-6:
        move = int(np.argmax(probs))
    else:
        p = probs ** (1.0 / pos.temperature)
        p /= p.sum()
        move = int(np.random.choice(len(p), p=p))

    value = np.asarray(res["value"])[0].astype(np.float64)
    ev = np.exp(value - value.max()); wld = ev / ev.sum()

    body = {
        "move": PASS if move == board.n else move,
        "gtp": board.to_gtp(move),
        "winrate": float(wld[0]),           # 手番側の勝率
        "confidence": float(probs[move]),
        "visits": 1,
        "nn_calls": 1,
        "inference_ms": round(ms, 1),
        "search": False,
    }
    if pos.top_k:
        idx = np.argsort(-probs)[: pos.top_k]
        body["candidates"] = [
            {"move": int(i) if i != board.n else PASS,
             "gtp": board.to_gtp(int(i)),
             "prob": float(probs[i])}
            for i in idx if probs[i] > 0
        ]
    return body


class KifuImport(BaseModel):
    url: str = Field(..., max_length=500,
                     description="囲碁クエストの棋譜 URL、または対局 ID")


@app.post("/kifu")
def import_kifu(body: KifuImport):
    """外部サービスの棋譜を取り込む。

    ブラウザから直接叩けない（先方が CORS を許可していない）ので中継する。
    URL はそのまま使わず ID だけ抜いて組み立て直す（kifu.py 参照）。
    """
    try:
        return kifu.import_goquest(body.url)
    except kifu.KifuError as e:
        # 入力が悪いのか先方が落ちているのか区別できないので 400 に寄せる。
        # どちらにせよユーザーに見せるのは同じ文言になる。
        raise HTTPException(400, str(e)) from e


@app.post("/analyze")
def analyze(pos: Position):
    """勝率・地の所有権を返す（解説機能用）。"""
    board = Board.from_dict(pos.model_dump())
    res, ms = _run(board, pos.komi)
    value = np.asarray(res["value"])[0].astype(np.float64)
    ev = np.exp(value - value.max()); wld = ev / ev.sum()
    body = {
        "winrate": float(wld[0]),
        "loss": float(wld[1]),
        "inference_ms": round(ms, 1),
    }
    if "ownership" in res:
        body["ownership"] = (np.asarray(res["ownership"])[0, 0]
                             .astype(np.float64).reshape(-1).round(3).tolist())
    return body
