"""棋譜取り込みのテスト。ネットワークには出ず、パースだけを見る。"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from kifu import (
    BLACK,
    PASS,
    WHITE,
    KifuError,
    extract_goquest_id,
    parse_goquest,
)


class TestExtractId:
    def test_url(self):
        assert extract_goquest_id(
            "https://kifu.questgames.net/go/ud6x5f3mvi0m") == "ud6x5f3mvi0m"

    def test_id_only(self):
        assert extract_goquest_id("ud6x5f3mvi0m") == "ud6x5f3mvi0m"

    def test_strips_query_and_fragment(self):
        assert extract_goquest_id(
            "https://kifu.questgames.net/go/abc123?x=1#y") == "abc123"

    def test_rejects_other_host(self):
        # SSRF 対策の本体。別ホストは ID を抜かずに弾く
        with pytest.raises(KifuError):
            extract_goquest_id("https://evil.example.com/go/abc123")

    def test_rejects_path_traversal(self):
        with pytest.raises(KifuError):
            extract_goquest_id("../../etc/passwd")

    def test_rejects_empty(self):
        with pytest.raises(KifuError):
            extract_goquest_id("  ")


def _doc(moves, size=13):
    return {
        "id": "x1", "gtype": f"go{size}",
        "players": [{"name": "kuro", "oldR": 2000.0}, {"name": "shiro", "oldR": 1900.0}],
        "position": {"size": size, "moves": moves},
        "created": "2026-09-20T03:57:26.789Z",
    }


class TestParse:
    def test_sgf_coord_to_index(self):
        # 'kd' は列 k(=10) 行 d(=3)。13路なので 3*13+10 = 49
        g = parse_goquest(_doc([{"m": "B[kd]", "t": 1}]))
        assert g["moves"][0] == {"move": 49, "color": BLACK, "time_ms": 1}

    def test_origin_is_top_left(self):
        g = parse_goquest(_doc([{"m": "B[aa]"}]))
        assert g["moves"][0]["move"] == 0

    def test_colors_alternate(self):
        g = parse_goquest(_doc([{"m": "B[aa]"}, {"m": "W[bb]"}, {"m": "B[cc]"}]))
        assert [m["color"] for m in g["moves"]] == [BLACK, WHITE, BLACK]

    def test_empty_bracket_is_pass(self):
        g = parse_goquest(_doc([{"m": "B[]"}]))
        assert g["moves"][0]["move"] == PASS

    def test_rejects_out_of_board(self):
        with pytest.raises(KifuError):
            parse_goquest(_doc([{"m": "B[nn]"}]))   # n = 13、13路では盤外

    def test_rejects_unknown_size(self):
        with pytest.raises(KifuError):
            parse_goquest(_doc([], size=21))

    def test_komi_is_null(self):
        # 先方の JSON にコミは無い。推測で埋めない
        assert parse_goquest(_doc([]))["komi"] is None

    def test_players(self):
        g = parse_goquest(_doc([]))
        assert g["black"]["name"] == "kuro"
        assert g["white"]["name"] == "shiro"


class TestResult:
    def test_black_resigns(self):
        # B, W と来た次は黒番。そこで LOSE なら黒の投了
        g = parse_goquest(_doc([{"m": "B[aa]"}, {"m": "W[bb]"}, {"s": "LOSE:RESIGN"}]))
        assert g["result"]["winner"] == WHITE
        assert g["result"]["text"] == "黒投了"

    def test_white_resigns(self):
        g = parse_goquest(_doc([{"m": "B[aa]"}, {"s": "LOSE:RESIGN"}]))
        assert g["result"]["winner"] == BLACK
        assert g["result"]["text"] == "白投了"

    def test_win_prefix_flips_subject(self):
        g = parse_goquest(_doc([{"m": "B[aa]"}, {"s": "WIN:TIMEOUT"}]))
        assert g["result"]["winner"] == WHITE

    def test_unknown_token_keeps_raw(self):
        g = parse_goquest(_doc([{"s": "DRAW"}]))
        assert g["result"]["winner"] is None
        assert g["result"]["text"] == "DRAW"

    def test_no_result_when_unfinished(self):
        assert parse_goquest(_doc([{"m": "B[aa]"}]))["result"] is None


class TestUpstreamErrors:
    def test_game_not_found(self):
        # 先方は 404 ではなく 200 + error フィールドで返してくる
        with pytest.raises(KifuError, match="見つかりません"):
            parse_goquest({"error": "Game not found"})

    def test_missing_position(self):
        with pytest.raises(KifuError, match="形式"):
            parse_goquest({"id": "x"})
