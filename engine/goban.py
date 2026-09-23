"""囲碁のルールエンジン（純Python + numpy）。ニューラルネットとは独立。"""
from __future__ import annotations

import numpy as np

EMPTY, BLACK, WHITE = 0, 1, 2
PASS = -1


def opponent(c: int) -> int:
    return BLACK if c == WHITE else WHITE


class Board:
    """19路（可変）の盤面。位置は 0..size*size-1 の一次元インデックス。"""

    def __init__(self, size: int = 19):
        self.size = size
        self.n = size * size
        self.stones = np.zeros(self.n, dtype=np.int8)
        self.ko = -1                 # 単純コウで着手禁止の点
        self.to_move = BLACK
        self.history: list[int] = []  # 着手履歴（PASS含む）
        self.prisoners = {BLACK: 0, WHITE: 0}

    # --- 座標ユーティリティ -------------------------------------------------
    def neighbors(self, p: int):
        s = self.size
        r, c = divmod(p, s)
        if r > 0:     yield p - s
        if r < s - 1: yield p + s
        if c > 0:     yield p - 1
        if c < s - 1: yield p + 1

    # --- 連（group）と呼吸点 -------------------------------------------------
    def group_and_liberties(self, p: int):
        """p を含む連の石集合と呼吸点集合を返す。"""
        color = self.stones[p]
        if color == EMPTY:
            return set(), set()
        seen = {p}
        stack = [p]
        libs = set()
        while stack:
            q = stack.pop()
            for nb in self.neighbors(q):
                v = self.stones[nb]
                if v == EMPTY:
                    libs.add(nb)
                elif v == color and nb not in seen:
                    seen.add(nb)
                    stack.append(nb)
        return seen, libs

    # --- 合法手判定 ----------------------------------------------------------
    def is_legal(self, p: int, color: int | None = None) -> bool:
        if p == PASS:
            return True
        color = self.to_move if color is None else color
        if not (0 <= p < self.n) or self.stones[p] != EMPTY:
            return False
        if p == self.ko:
            return False
        opp = opponent(color)
        # 仮置きして判定
        self.stones[p] = color
        try:
            # 相手の石を取れるなら合法
            for nb in self.neighbors(p):
                if self.stones[nb] == opp:
                    _, libs = self.group_and_liberties(nb)
                    if not libs:
                        return True
            # 自分の連に呼吸点が残るか（自殺手の禁止）
            _, libs = self.group_and_liberties(p)
            return len(libs) > 0
        finally:
            self.stones[p] = EMPTY

    def legal_moves(self) -> np.ndarray:
        """長さ n+1 のbool配列。最後の要素はパス（常にTrue）。"""
        mask = np.zeros(self.n + 1, dtype=bool)
        for p in range(self.n):
            if self.stones[p] == EMPTY and self.is_legal(p):
                mask[p] = True
        mask[self.n] = True
        return mask


    # --- 高速な合法手マスク -------------------------------------------------
    def legal_mask(self, color: int | None = None) -> np.ndarray:
        """長さ n+1 のbool配列（末尾はパス、常にTrue）。

        MCTSはノードごとにこれを呼ぶので速度が効く。
        空き点のうち「隣に空きがある」ものは必ず呼吸点を持つので即合法と判定し、
        完全に囲まれた点だけ flood fill で自殺手かどうかを調べる。
        序中盤なら重い判定に回るのは数点だけになる。
        """
        color = self.to_move if color is None else color
        s, n = self.size, self.n
        st = self.stones.reshape(s, s)
        empty = (st == 0)

        # 上下左右のいずれかが空きか（盤外は空き扱いしない）
        has_empty_nb = np.zeros((s, s), dtype=bool)
        has_empty_nb[1:, :] |= empty[:-1, :]
        has_empty_nb[:-1, :] |= empty[1:, :]
        has_empty_nb[:, 1:] |= empty[:, :-1]
        has_empty_nb[:, :-1] |= empty[:, 1:]

        mask = np.zeros(n + 1, dtype=bool)
        mask[:n] = (empty & has_empty_nb).reshape(-1)   # 即合法
        mask[n] = True                                   # パス

        # 残り（空きだが四方を石に囲まれている点）だけ厳密判定
        surrounded = np.flatnonzero(empty.reshape(-1) & ~has_empty_nb.reshape(-1))
        for p in surrounded:
            if self.is_legal(int(p), color):
                mask[p] = True

        if self.ko >= 0:
            mask[self.ko] = False
        return mask

    # --- 着手 ----------------------------------------------------------------
    def play(self, p: int, color: int | None = None) -> None:
        color = self.to_move if color is None else color
        if p == PASS:
            self.ko = -1
            self.history.append(PASS)
            self.to_move = opponent(color)
            return
        if not self.is_legal(p, color):
            raise ValueError(f"illegal move: {p}")
        opp = opponent(color)
        self.stones[p] = color
        captured: list[int] = []
        for nb in self.neighbors(p):
            if self.stones[nb] == opp:
                grp, libs = self.group_and_liberties(nb)
                if not libs:
                    captured.extend(grp)
        for q in set(captured):
            self.stones[q] = EMPTY
        self.prisoners[color] += len(set(captured))

        # 単純コウ：1子だけ取り、取った石も1子で呼吸点1
        self.ko = -1
        if len(set(captured)) == 1:
            grp, libs = self.group_and_liberties(p)
            if len(grp) == 1 and len(libs) == 1:
                self.ko = next(iter(set(captured)))

        self.history.append(p)
        self.to_move = opp

    # --- 変換 ----------------------------------------------------------------
    def copy(self) -> Board:
        b = Board(self.size)
        b.stones = self.stones.copy()
        b.ko = self.ko
        b.to_move = self.to_move
        b.history = list(self.history)
        b.prisoners = dict(self.prisoners)
        return b

    @classmethod
    def from_dict(cls, d: dict) -> Board:
        """{"size":19,"stones":[0|1|2,...],"to_move":1,"history":[...],"ko":-1}"""
        b = cls(int(d.get("size", 19)))
        st = d.get("stones")
        if st is not None:
            arr = np.asarray(st, dtype=np.int8).reshape(-1)
            if arr.size != b.n:
                raise ValueError(f"stones must have {b.n} entries, got {arr.size}")
            b.stones = arr
        b.to_move = int(d.get("to_move", BLACK))
        b.history = [int(x) for x in d.get("history", [])]
        b.ko = int(d.get("ko", -1))
        return b

    def to_gtp(self, p: int) -> str:
        if p == PASS or p == self.n:
            return "pass"
        letters = "ABCDEFGHJKLMNOPQRST"
        r, c = divmod(p, self.size)
        return f"{letters[c]}{self.size - r}"
