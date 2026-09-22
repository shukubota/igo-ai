"""外部サービスの棋譜を取り込む。

いまのところ囲碁クエスト（kifu.questgames.net）だけ。

ブラウザから直接叩けないのでサーバー側で中継する。あちらの API は
Access-Control-Allow-Origin を返さないため、fetch すると CORS で弾かれる。

⚠️ 中継は SSRF の入口になりうる。ユーザーから受け取った URL をそのまま
   取りに行かず、**ID だけを抜き出して自分で URL を組み立てる**。
   ホストもスキームもこちらが決めるので、内部ネットワークへは飛ばない。
"""
from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from typing import Any, Literal

BLACK, WHITE = 1, 2
PASS = -1

GOQUEST_HOST = "kifu.questgames.net"
_GOQUEST_URL = f"https://{GOQUEST_HOST}/game/{{id}}.json"

# 囲碁クエストの対局 ID。英数字のみを許す（パス区切りや .. を弾くため）
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{4,64}$")
# "B[kd]" / "W[]"（パス）
_MOVE_RE = re.compile(r"^([BW])\[([a-z]{0,2})\]$")

_TIMEOUT_S = 15
_MAX_BYTES = 2_000_000  # 300手でも数十KB。これを超えるものは想定外


class KifuError(ValueError):
    """取り込みに失敗した。呼び出し側で 400 / 502 に振り分ける。"""


def extract_goquest_id(src: str) -> str:
    """URL でも ID そのものでも受け付けて、ID を返す。

    受け付ける形:
        https://kifu.questgames.net/go/ud6x5f3mvi0m
        kifu.questgames.net/go/ud6x5f3mvi0m
        ud6x5f3mvi0m
    """
    s = src.strip()
    if not s:
        raise KifuError("URL が空です")
    # クエリとフラグメントを落としてから末尾セグメントを取る
    s = s.split("#", 1)[0].split("?", 1)[0].rstrip("/")
    if "/" in s:
        if GOQUEST_HOST not in s:
            raise KifuError(f"{GOQUEST_HOST} の URL だけ取り込めます")
        s = s.rsplit("/", 1)[-1]
    if s.endswith(".json"):
        s = s[: -len(".json")]
    if not _ID_RE.match(s):
        raise KifuError(f"対局 ID として解釈できません: {s[:40]}")
    return s


def _sgf_to_index(coord: str, size: int) -> int:
    """SGF 座標 'kd' を一次元 index に直す。空文字はパス。

    SGF は [列][行] の順で、どちらも 'a' 起点。こちらの規約は row*size+col。
    """
    if coord == "":
        return PASS
    # 19路までは 'tt' をパスとして使う古い流儀がある
    if len(coord) != 2:
        raise KifuError(f"座標が読めません: {coord}")
    col = ord(coord[0]) - ord("a")
    row = ord(coord[1]) - ord("a")
    if col == row == 19 and size <= 19:
        return PASS
    if not (0 <= col < size and 0 <= row < size):
        raise KifuError(f"盤外の座標です: {coord}（size={size}）")
    return row * size + col


def _fetch_json(url: str) -> Any:
    req = urllib.request.Request(url, headers={"User-Agent": "igo-ai/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT_S) as res:
            raw = res.read(_MAX_BYTES + 1)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            raise KifuError("その対局は見つかりませんでした") from e
        raise KifuError(f"取得に失敗しました（HTTP {e.code}）") from e
    except urllib.error.URLError as e:
        raise KifuError(f"取得に失敗しました: {e.reason}") from e
    if len(raw) > _MAX_BYTES:
        raise KifuError("棋譜が大きすぎます")
    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        raise KifuError("棋譜の JSON を解釈できませんでした") from e


def _parse_result(token: str, to_move: int) -> dict[str, Any]:
    """'LOSE:RESIGN' のような終局表記を解釈する。

    主語はその時点の手番。LOSE ならその手番が負け、WIN なら勝ち。
    """
    head, _, reason = token.partition(":")
    reason = reason or "UNKNOWN"
    other = WHITE if to_move == BLACK else BLACK
    if head == "LOSE":
        winner = other
    elif head == "WIN":
        winner = to_move
    else:
        # DRAW など。勝者を決めずに原文だけ返す
        return {"winner": None, "reason": token, "text": token}

    label = {"RESIGN": "投了", "TIMEOUT": "時間切れ", "SCORE": "計算",
             "DISCONNECT": "切断"}.get(reason, reason)
    loser = other if winner == to_move else to_move
    color_name = {BLACK: "黒", WHITE: "白"}
    text = (f"{color_name[loser]}{label}" if reason in ("RESIGN", "TIMEOUT", "DISCONNECT")
            else f"{color_name[winner]}の勝ち（{label}）")
    return {"winner": winner, "reason": reason, "text": text}


def parse_goquest(doc: dict[str, Any]) -> dict[str, Any]:
    """囲碁クエストの JSON を、こちらの規約（一次元 index）に直す。"""
    # 見つからない対局でも HTTP 200 + {"error": "Game not found"} が返ってくる
    if doc.get("error"):
        raise KifuError("その対局は見つかりませんでした")
    position = doc.get("position") or {}
    if not position:
        raise KifuError("棋譜の形式が想定と違います")
    size = int(position.get("size") or 0)
    if size not in (9, 13, 19):
        raise KifuError(f"対応していない盤サイズです: {size}")

    moves: list[dict[str, Any]] = []
    result: dict[str, Any] | None = None
    expected = BLACK  # 黒先

    for item in position.get("moves") or []:
        if "m" in item:
            m = _MOVE_RE.match(str(item["m"]))
            if not m:
                raise KifuError(f"着手が読めません: {item['m']}")
            color = BLACK if m.group(1) == "B" else WHITE
            moves.append({
                "move": _sgf_to_index(m.group(2), size),
                "color": color,
                "time_ms": item.get("t"),
            })
            expected = WHITE if color == BLACK else BLACK
        elif "s" in item:
            # 終局マーカー。手番はここまでの着手から決まる
            result = _parse_result(str(item["s"]), expected)

    players = doc.get("players") or []

    def who(i: int) -> dict[str, Any]:
        p = players[i] if i < len(players) else {}
        return {"name": p.get("name"), "rating": p.get("oldR")}

    return {
        "source": "goquest",
        "id": doc.get("id"),
        "size": size,
        # 囲碁クエストの JSON にコミは入っていない。推測で埋めず null を返し、
        # 表示側の既定値を使わせる（勝敗は先方の result が正）。
        "komi": None,
        "black": who(0),
        "white": who(1),
        "moves": moves,
        "result": result,
        "created": doc.get("created"),
    }


def import_goquest(src: str) -> dict[str, Any]:
    """URL か ID を受け取って、正規化した棋譜を返す。"""
    gid = extract_goquest_id(src)
    return parse_goquest(_fetch_json(_GOQUEST_URL.format(id=gid)))
