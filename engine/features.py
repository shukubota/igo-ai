"""
KataGo ONNX (kaya-go/kaya) の入力テンソルを組み立てる。

モデルI/O（kaya-go/kaya のREADME記載）:
    入力  bin_input     float32 [B, 22, H, W]
          global_input  float32 [B, 19]
    出力  policy        [B, 2, H*W+1]   ch0=通常, ch1=パス考慮版, 末尾index=パス
          value         [B, 3]          win / loss / noresult
          ownership     [B, 1, H, W]
          scoring, futurepos, seki, miscvalue, moremiscvalue, scorebelief

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚠️ 要検証ポイント（ここだけは必ずKataGo本家で突き合わせること）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
22chの「どのindexが何を表すか」の正確な割り当ては KataGo の
    cpp/neuralnet/nninputs.cpp の NNInputs::fillRowV7()
    （およびPython側 python/features.py）
が唯一の正解。下の CHANNELS は一般に知られている V7 のレイアウトに沿って
実装しているが、index順が1つでもズレると出力は意味を成さない（「少し弱くなる」
ではなく「デタラメになる」）。

デプロイ前に scripts/verify_features.py を必ず走らせて、KataGo本家の
fillRowV7 出力とバイト一致することを確認すること。
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
"""
from __future__ import annotations
import numpy as np
from goban import Board, EMPTY, BLACK, WHITE, PASS, opponent

NUM_BIN = 22
NUM_GLOBAL = 19

# V7 バイナリ平面の割り当て（※上記の通り要検証）
CHANNELS = {
    0:  "on_board",          # 盤上なら1（可変盤サイズのためのマスク）
    1:  "own_stone",
    2:  "opp_stone",
    3:  "lib1",              # 呼吸点がちょうど1の連に属する石
    4:  "lib2",
    5:  "lib3",
    6:  "ko_ban",            # 単純コウで着手禁止
    7:  "encore_ko_ban",     # 日本ルール系の追加禁止点（通常対局では0）
    8:  "encore_phase",      # エンコア中かどうか（通常対局では0）
    9:  "move_prev1",        # 直前の着手
    10: "move_prev2",
    11: "move_prev3",
    12: "move_prev4",
    13: "move_prev5",
    14: "ladder_capturable", # シチョウで取られる石
    15: "ladder_atari",
    16: "ladder_escape",
    17: "ladder_working",
    18: "area_own",          # pass-alive（確定地）own
    19: "area_opp",          # pass-alive（確定地）opp
    20: "second_encore_a",
    21: "second_encore_b",
}


def _liberty_planes(board: Board, out: np.ndarray) -> None:
    """ch3/4/5（呼吸点1/2/3）を埋める。連ごとに1回だけ計算する。"""
    seen = np.zeros(board.n, dtype=bool)
    for p in range(board.n):
        if seen[p] or board.stones[p] == EMPTY:
            continue
        grp, libs = board.group_and_liberties(p)
        nlib = len(libs)
        for q in grp:
            seen[q] = True
        if nlib in (1, 2, 3):
            ch = 2 + nlib  # 1->3, 2->4, 3->5
            for q in grp:
                out[ch, q] = 1.0


def encode(board: Board, *, komi: float = 7.5, rules: str = "chinese") -> tuple[np.ndarray, np.ndarray]:
    """盤面を (bin_input[1,22,H,W], global_input[1,19]) に変換する。"""
    s = board.size
    flat = np.zeros((NUM_BIN, board.n), dtype=np.float32)
    me = board.to_move
    opp = opponent(me)

    flat[0, :] = 1.0
    flat[1, :] = (board.stones == me)
    flat[2, :] = (board.stones == opp)
    _liberty_planes(board, flat)
    if board.ko >= 0:
        flat[6, board.ko] = 1.0

    # 直近5手（パスは平面を立てない）
    real = [m for m in board.history[-5:]]
    for i, mv in enumerate(reversed(real)):
        if mv is not None and mv != PASS and 0 <= mv < board.n:
            flat[9 + i, mv] = 1.0

    # ch14-17（シチョウ）とch18-19（pass-alive）は未実装＝0のまま。
    # 序中盤の打ち筋への影響は限定的だが、終盤の精度は落ちる。
    # 本番前に KataGo の実装を移植すること。

    bin_input = flat.reshape(1, NUM_BIN, s, s)

    g = np.zeros((1, NUM_GLOBAL), dtype=np.float32)
    # global もKataGo本家の並びに合わせる必要あり。最低限コミだけ入れる。
    # KataGoではコミは (komi / 15.0) を手番視点で符号反転して渡す。
    signed_komi = komi if me == WHITE else -komi
    g[0, 5] = signed_komi / 15.0
    return bin_input, g


def softmax_masked(logits: np.ndarray, legal: np.ndarray) -> np.ndarray:
    """非合法手を除外したsoftmax。logits/legal はともに長さ n+1。"""
    x = np.where(legal, logits, -np.inf)
    x = x - np.max(x[legal])
    e = np.where(legal, np.exp(x), 0.0)
    total = e.sum()
    return e / total if total > 0 else legal.astype(np.float64) / legal.sum()
