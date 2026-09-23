"""ルールエンジンのテスト。

⚠️ web/src/goban/rules.test.ts と同じケースを維持すること。
   両実装が食い違ったらすぐ分かるようにするため。
"""
import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from goban import BLACK, EMPTY, PASS, WHITE, Board


def test_single_capture():
    """中央の白1子を黒4子で囲んで取る。"""
    b = Board(19)
    b.stones[180] = WHITE            # (9,9)
    for p in (161, 199, 179):        # 上・下・左
        b.play(p, BLACK)
    assert b.stones[180] == WHITE, "まだ取れていないはず"
    b.play(181, BLACK)               # 右をふさぐ
    assert b.stones[180] == EMPTY
    assert b.prisoners[BLACK] == 1


def test_suicide_forbidden():
    """呼吸点のない自分の石を置けない。ただし相手を取れるなら合法。"""
    b = Board(19)
    # 左上隅(0)を白で囲む: 1=(0,1), 19=(1,0)
    b.stones[1] = WHITE
    b.stones[19] = WHITE
    assert not b.is_legal(0, BLACK), "自殺手は非合法"

    # 白の1と19が両方アタリなら、0に打って取れるので合法になる
    b2 = Board(19)
    b2.stones[1] = WHITE; b2.stones[19] = WHITE
    b2.stones[2] = BLACK; b2.stones[20] = BLACK; b2.stones[38] = BLACK
    assert b2.is_legal(0, BLACK), "相手を取れる着手は合法"


def test_simple_ko():
    """典型的なコウの形を作り、取り返しが禁止され、1手他所に打つと解除される。

        列:      5  6  7  8
        行 5:    .  B  W  .
        行 6:    B  W  ?  W      ? = 黒がここに打って白(6,6)を取る
        行 7:    .  B  W  .
    """
    def ix(r, c):
        return r * 19 + c

    b = Board(19)
    for p, c in [(ix(5, 6), BLACK), (ix(5, 7), WHITE),
                 (ix(6, 5), BLACK), (ix(6, 6), WHITE), (ix(6, 8), WHITE),
                 (ix(7, 6), BLACK), (ix(7, 7), WHITE)]:
        b.stones[p] = c
    b.to_move = BLACK

    b.play(ix(6, 7), BLACK)
    assert b.stones[ix(6, 6)] == EMPTY, "白1子が取れているはず"
    assert b.ko == ix(6, 6), f"コウ点が立つはず: got {b.ko}"
    assert not b.is_legal(ix(6, 6), WHITE), "即座の取り返しは禁止"

    b.play(PASS, WHITE)                     # 1手他所（パス）でコウが解除される
    assert b.ko == -1
    assert b.is_legal(ix(6, 6), WHITE), "解除後は打てる"


def test_ko_condition_is_exact():
    """1子取りでも、打った石に呼吸点が複数あればコウにならない。"""
    b = Board(19)
    b.stones[180] = WHITE
    for p in (161, 199, 179):
        b.play(p, BLACK)
    b.play(181, BLACK)
    # 181 の連は呼吸点4つ → コウではない
    assert b.ko == -1


def test_pass_and_turn():
    b = Board(19)
    assert b.to_move == BLACK
    b.play(PASS)
    assert b.to_move == WHITE
    assert b.history[-1] == PASS
    assert b.ko == -1


def test_legal_mask_matches_naive():
    """高速版と素朴版が完全一致すること。ランダム自己対局で検証。"""
    rng = np.random.default_rng(0)
    for trial in range(5):
        b = Board(19)
        for _ in range(80):
            mask = b.legal_mask()
            idx = np.flatnonzero(mask[: b.n])
            if idx.size == 0:
                break
            b.play(int(rng.choice(idx)))
            assert np.array_equal(b.legal_moves(), b.legal_mask()), \
                f"trial={trial} で不一致"


def test_legal_mask_excludes_ko():
    b = Board(19)
    b.ko = 100
    assert not b.legal_mask()[100]


def test_gtp_coordinates():
    b = Board(19)
    assert b.to_gtp(0) == "A19"
    assert b.to_gtp(180) == "K10"      # 中央（天元）
    assert b.to_gtp(PASS) == "pass"
