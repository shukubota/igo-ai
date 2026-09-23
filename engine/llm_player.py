"""Claude に囲碁を打たせる。

盤面をテキストで渡して着手を1つ返させるだけの薄い層。探索も評価もしない。
KataGo と同じ土俵に立てるとは考えていない（LLM は盤面を毎回テキストから
読み直すので、シチョウや死活のような「見れば分かる」情報に弱い）。
狙いは強さではなく、どこで崩れるかを既存の検討 UI で観察すること。

呼び出しは `claude -p`（Claude Code のヘッドレス実行）を毎手起動する。
Anthropic SDK ではなく CLI を使うのは、Claude Code のログイン（Team プラン等）を
そのまま使えるのがこの経路だけのため。SDK は ANTHROPIC_API_KEY 等を別途要求する。

コストの実測（Opus 5 / 1手あたり、list 価格での表示値）:
    素の `claude -p`                        34,553 tok  $0.35  2.8s
    + --system-prompt                       26,807 tok  $0.27  1.4s
    + --disable-slash-commands / ツール無効  16,616 tok  $0.17  1.5s

`--resume` でのセッション継続は**逆効果**だった（キャッシュを読まず履歴ごと
書き直すため 30,620 tok / $0.41 に増えた）。毎手새規起動が安い。
"""
from __future__ import annotations

import json
import re
import subprocess
from dataclasses import dataclass

from goban import Board, BLACK, EMPTY, PASS, WHITE

MODEL = "claude-opus-5"

# Claude Code のプリアンブルを削るための指定。ツールもスキルも囲碁には使わないが、
# 何も言わないと定義一式がプロンプトに載って課金される（実測で約2倍）。
_OFF_TOOLS = ["Bash", "Read", "Write", "Edit", "NotebookEdit",
              "WebFetch", "WebSearch", "Task", "Glob", "Grep"]

# GTP の列記号。I を飛ばすのは囲碁の慣習（1 と紛れるため）。
_COLUMNS = "ABCDEFGHJKLMNOPQRST"

_SYSTEM = """あなたは囲碁のプレイヤーです。盤面を読んで次の一手を選んでください。

## 盤面の読み方

    . 空点   X 黒石   O 白石
    列は左から A B C ... （I は使いません）、行は下から 1 2 3 ...
    左下が A1、右上が最大の座標です。

## 守ること

- **1行目に GTP 座標だけ**を書いてください（例: D4）。パスなら PASS。
- 2行目に理由を1文だけ。それ以外は書かないでください。
- **合法手だけを返してください。** 石のある点、自殺手、コウの取り返しは打てません。
  与えられる合法手の一覧から必ず選んでください。
- 一覧に無い座標を返すと再試行になり、3回失敗するとパス扱いになります。

## 考え方の目安

序盤は隅と辺、次に模様の接点。中盤は自分の弱い石の補強と相手の弱い石への攻め。
自分の石が取られそうなときは逃げるか捨てるかを決めてください。
盤が小さいほど1手の価値が大きく、序盤から接近戦になります。
"""


@dataclass
class MoveResult:
    move: int
    """一次元 index。PASS は -1"""
    gtp: str
    reason: str
    attempts: int
    """合法手を返すまでにかかった往復回数"""
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    forced_pass: bool = False
    """再試行しても合法手が出ずパスにした"""
    timed_out: bool = False
    """一度でもタイムアウトした"""


@dataclass
class Usage:
    """対局全体の課金量。終わったあと概算コストを出すために貯める。"""

    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    calls: int = 0

    def add(self, r: MoveResult) -> None:
        self.input_tokens += r.input_tokens
        self.output_tokens += r.output_tokens
        self.cache_read_tokens += r.cache_read_tokens
        self.cache_write_tokens += r.cache_write_tokens
        self.calls += r.attempts

    def cost_usd(self, model: str = MODEL) -> float:
        """概算。Opus 5 の公開価格（入力 $5 / 出力 $25 per MTok）で計算する。

        キャッシュ書き込みは入力の1.25倍、読み出しは0.1倍で見積もる。
        """
        if model != MODEL:
            return float("nan")
        return (
            self.input_tokens * 5.0
            + self.cache_write_tokens * 6.25
            + self.cache_read_tokens * 0.5
            + self.output_tokens * 25.0
        ) / 1_000_000


def to_gtp(size: int, p: int) -> str:
    if p == PASS:
        return "PASS"
    return f"{_COLUMNS[p % size]}{size - p // size}"


def from_gtp(size: int, s: str) -> int | None:
    """GTP 座標を一次元 index に。読めなければ None。"""
    s = s.strip().upper()
    if s in ("PASS", "パス"):
        return PASS
    m = re.fullmatch(r"([A-HJ-T])\s*(\d{1,2})", s)
    if not m:
        return None
    col = _COLUMNS.index(m.group(1))
    row = size - int(m.group(2))
    if not (0 <= col < size and 0 <= row < size):
        return None
    return row * size + col


def render(board: Board) -> str:
    """盤面を ASCII に。行番号と列記号を付けて座標を数えなくて済むようにする。"""
    s = board.size
    width = 2 if s >= 10 else 1
    head = "   " + " ".join(_COLUMNS[:s])
    lines = [head]
    for r in range(s):
        cells = []
        for c in range(s):
            v = board.stones[r * s + c]
            cells.append("." if v == EMPTY else ("X" if v == BLACK else "O"))
        lines.append(f"{s - r:>{width}} " + " ".join(cells) + f" {s - r}")
    lines.append(head)
    return "\n".join(lines)


def _legal_list(board: Board, limit: int = 400) -> tuple[list[int], str]:
    legal = [p for p in range(board.n) if board.is_legal(p)]
    shown = legal[:limit]
    text = " ".join(to_gtp(board.size, p) for p in shown)
    if len(legal) > limit:
        text += f" …ほか {len(legal) - limit} 点"
    return legal, text


def _prompt(board: Board, komi: float, last: int | None) -> str:
    _, legal_text = _legal_list(board)
    me = "黒 (X)" if board.to_move == BLACK else "白 (O)"
    last_s = "なし（初手）" if last is None else to_gtp(board.size, last)
    return (
        f"{board.size}路盤 / コミ {komi} / あなたは{me}\n"
        f"相手の直前の手: {last_s}\n"
        f"アゲハマ: 黒 {board.prisoners[BLACK]} 白 {board.prisoners[WHITE]}\n\n"
        f"{render(board)}\n\n"
        f"合法手:\n{legal_text}\n\n"
        f"次の一手を選んでください。"
    )


class ClaudeTimeout(RuntimeError):
    """`claude -p` が時間内に返さなかった。1手落とすだけで対局は続ける。"""


def _call_claude(system: str, prompt: str, model: str, timeout_s: int = 300
                 ) -> tuple[str, dict]:
    """`claude -p` を1回起動して (本文, usage) を返す。

    プロンプトは stdin で渡す。`--disallowed-tools` が可変長引数なので、
    位置引数で渡すと prompt を食われる（実測で踏んだ）。
    """
    cmd = [
        "claude", "-p", "--model", model, "--output-format", "json",
        "--system-prompt", system,
        "--disable-slash-commands",
        "--disallowed-tools", *_OFF_TOOLS,
    ]
    try:
        proc = subprocess.run(cmd, input=prompt, capture_output=True,
                              text=True, timeout=timeout_s)
    except subprocess.TimeoutExpired as e:
        # 通常1.5秒で返るが、稀に長考して戻らないことがある（実測で遭遇）。
        # 対局全体を落とさず、この手だけ諦める。
        raise ClaudeTimeout(f"{timeout_s}秒以内に応答がありませんでした") from e
    if proc.returncode != 0:
        raise RuntimeError(f"claude -p が失敗しました: {proc.stderr.strip()[:300]}")
    try:
        doc = json.loads(proc.stdout)
    except json.JSONDecodeError:
        raise RuntimeError(f"claude -p の出力が JSON ではありません: {proc.stdout[:300]}")
    if doc.get("is_error"):
        raise RuntimeError(f"claude -p がエラーを返しました: {doc.get('result')}")
    return str(doc.get("result", "")), doc.get("usage") or {}


def _parse_reply(text: str) -> tuple[str, str]:
    """1行目を座標、残りを理由として取る。"""
    lines = [ln.strip() for ln in text.strip().splitlines() if ln.strip()]
    if not lines:
        return "", ""
    return lines[0], " ".join(lines[1:])[:200]


def choose_move(
    board: Board,
    *,
    komi: float = 6.5,
    last_move: int | None = None,
    max_attempts: int = 3,
    model: str = MODEL,
) -> MoveResult:
    """1手選ばせる。非合法手なら理由を添えて投げ直す。

    毎回起動し直すので会話履歴は持たない。代わりに、やり直しのときは
    直前に何を返して何がだめだったかをプロンプトに書き足す。
    """
    legal, _ = _legal_list(board)
    res = MoveResult(move=PASS, gtp="PASS", reason="", attempts=0)
    extra = ""

    for attempt in range(1, max_attempts + 1):
        res.attempts = attempt
        try:
            text, usage = _call_claude(_SYSTEM, _prompt(board, komi, last_move) + extra,
                                       model)
        except ClaudeTimeout as e:
            res.reason = str(e)
            res.timed_out = True
            continue   # 同じ問いをもう一度投げる

        res.input_tokens += usage.get("input_tokens", 0) or 0
        res.output_tokens += usage.get("output_tokens", 0) or 0
        res.cache_read_tokens += usage.get("cache_read_input_tokens", 0) or 0
        res.cache_write_tokens += usage.get("cache_creation_input_tokens", 0) or 0

        coord, reason = _parse_reply(text)
        res.reason = reason
        mv = from_gtp(board.size, coord)

        if mv == PASS:
            res.move, res.gtp = PASS, "PASS"
            return res
        if mv is not None and mv in legal:
            res.move, res.gtp = mv, to_gtp(board.size, mv)
            return res

        why = "座標として読めません" if mv is None else "そこには打てません（石がある/自殺手/コウ）"
        extra += (f"\n\n【やり直し {attempt}】直前に {coord or '(空)'} と答えましたが、"
                  f"{why}。合法手の一覧から選び直してください。")

    # 打てなかった。投了ではなくパスにして対局を続ける（棋譜として崩れ方が残る）。
    res.move, res.gtp, res.forced_pass = PASS, "PASS", True
    return res
