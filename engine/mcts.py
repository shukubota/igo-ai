"""PUCT モンテカルロ木探索（CPU向けバッチ評価つき）。

CPUで探索を成立させるための工夫が3つ入っている:

1. **バッチ評価** — 葉を1つ評価するたびにONNXを呼ぶと、推論1回=数百msが
   visit数ぶん直列に積み上がる。virtual loss を使って葉を複数集めてから
   1回の推論でまとめて評価する。CPUでもバッチの方がスループットが出る。
2. **top-K枝刈り** — 数十visitsしか回せないのに362手すべてを候補にしても
   意味がない。policyの上位K手だけを子ノードにする。
3. **時間予算** — Cloud Run のタイムアウトに引っかからないよう、visits に
   到達しなくても max_time_ms で必ず打ち切る。

木の再利用（前の手の探索結果を引き継ぐ）は入れていない。ステートレスAPIの
ままにしたかったため。対局セッションを持たせるなら、ここが次の高速化ポイント。
"""
from __future__ import annotations
import math, time
import numpy as np

from goban import Board, PASS, opponent
import features as F


class Node:
    __slots__ = ("moves", "P", "N", "W", "children", "is_expanded", "n_total")

    def __init__(self, moves: np.ndarray, priors: np.ndarray):
        self.moves = moves                                  # 候補手（盤上index, n=パス）
        self.P = priors.astype(np.float32)                  # 事前確率
        self.N = np.zeros(len(moves), dtype=np.int32)       # 訪問回数
        self.W = np.zeros(len(moves), dtype=np.float32)     # 価値の累計（親手番視点）
        self.children: list["Node | None"] = [None] * len(moves)
        self.is_expanded = True
        self.n_total = 0

    def puct(self, c_puct: float) -> np.ndarray:
        q = np.where(self.N > 0, self.W / np.maximum(self.N, 1), 0.0)
        u = c_puct * self.P * math.sqrt(max(self.n_total, 1)) / (1.0 + self.N)
        return q + u


class MCTS:
    def __init__(self, session, *, c_puct: float = 1.4, top_k: int = 24,
                 batch_size: int = 8, komi: float = 7.5):
        self.sess = session
        self.c_puct = c_puct
        self.top_k = top_k
        self.batch_size = batch_size
        self.komi = komi
        self.nn_calls = 0
        self.nn_positions = 0

    # --- ニューラルネット呼び出し -------------------------------------------
    def _evaluate_batch(self, boards: list[Board]):
        """複数局面をまとめて1回の推論にかける。
        戻り値は各局面の (policy確率[候補手], 候補手index配列, 手番視点の勝率)。"""
        bins, globs = [], []
        for b in boards:
            bi, gi = F.encode(b, komi=self.komi)
            bins.append(bi[0]); globs.append(gi[0])
        bin_in = np.stack(bins).astype(np.float32)
        glob_in = np.stack(globs).astype(np.float32)

        out = self.sess.run(None, {"bin_input": bin_in, "global_input": glob_in})
        names = [o.name for o in self.sess.get_outputs()]
        res = dict(zip(names, out))
        self.nn_calls += 1
        self.nn_positions += len(boards)

        policy_raw = np.asarray(res["policy"])[:, 0, :].astype(np.float64)  # [B, n+1]
        value_raw = np.asarray(res["value"]).astype(np.float64)             # [B, 3]

        results = []
        for i, b in enumerate(boards):
            legal = b.legal_mask()
            probs = F.softmax_masked(policy_raw[i], legal)
            k = min(self.top_k, int(legal.sum()))
            moves = np.argsort(-probs)[:k]
            p = probs[moves]
            p = p / p.sum() if p.sum() > 0 else np.full(k, 1.0 / k)
            e = np.exp(value_raw[i] - value_raw[i].max()); wld = e / e.sum()
            results.append((p, moves, float(wld[0])))   # wld[0] = 手番側の勝率
        return results

    # --- 探索本体 ------------------------------------------------------------
    def search(self, root_board: Board, *, visits: int, max_time_ms: int = 10000):
        t0 = time.perf_counter()
        self.nn_calls = self.nn_positions = 0

        (p, moves, root_value), = self._evaluate_batch([root_board])
        root = Node(moves, p)

        done = 0
        while done < visits:
            if (time.perf_counter() - t0) * 1000 > max_time_ms:
                break

            # --- 葉を batch_size 個まで集める（virtual lossで重複を防ぐ）---
            pending = []   # (path, board)
            want = min(self.batch_size, visits - done)
            for _ in range(want):
                node, board, path = root, root_board.copy(), []
                while len(path) < 80:
                    a = int(np.argmax(node.puct(self.c_puct)))
                    path.append((node, a))
                    # virtual loss: 探索中の枝を一時的に「負け」扱いして
                    # 同じ枝に集中するのを防ぐ
                    node.N[a] += 1; node.W[a] -= 1.0; node.n_total += 1
                    mv = int(node.moves[a])
                    board.play(PASS if mv == board.n else mv)
                    child = node.children[a]
                    if child is None:
                        pending.append((path, board))
                        break
                    node = child
                if len(pending) >= want:
                    break
            if not pending:
                break

            # --- まとめて評価して展開・バックアップ ---
            evals = self._evaluate_batch([b for _, b in pending])
            for (path, _board), (cp, cmoves, cvalue) in zip(pending, evals):
                leaf_parent, a = path[-1]
                if leaf_parent.children[a] is None:
                    leaf_parent.children[a] = Node(cmoves, cp)
                # cvalue は葉の手番視点の勝率[0,1]。バックアップは [-1,1] で行うため
                # z = 2*winrate-1 に変換し、親から見た符号に反転する。
                v = -(2.0 * cvalue - 1.0)
                for node, ai in reversed(path):
                    node.W[ai] += 1.0 + v   # virtual lossの -1.0 を戻しつつ加算
                    v = -v
                done += 1

        elapsed = (time.perf_counter() - t0) * 1000
        return root, {
            "visits": int(root.N.sum()),
            "nn_calls": self.nn_calls,
            "nn_positions": self.nn_positions,
            "elapsed_ms": round(elapsed, 1),
            "root_winrate": root_value,
        }

    # --- 着手の選択 -----------------------------------------------------------
    @staticmethod
    def pick(root: Node, temperature: float = 0.0) -> tuple[int, np.ndarray]:
        """訪問回数から着手を選ぶ。temperature=0 なら最多訪問手。"""
        n = root.N.astype(np.float64)
        if n.sum() == 0:
            n = root.P.astype(np.float64)
        if temperature <= 1e-6:
            a = int(np.argmax(n))
        else:
            p = n ** (1.0 / temperature)
            p = p / p.sum()
            a = int(np.random.choice(len(p), p=p))
        return a, n / n.sum()
