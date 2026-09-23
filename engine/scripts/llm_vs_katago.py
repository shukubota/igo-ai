#!/usr/bin/env python3
"""Claude と KataGo を対局させ、棋譜を JSON で吐く。

出力は engine/kifu.py が返すのと同じ形なので、Web UI の検討モードに
そのまま読み込める（全手解析・悪手リストがそのまま効く）。

    ./scripts/llm_vs_katago.py --size 9 --visits 8 --llm-color white

⚠️ Claude 側は `claude -p` を毎手起動する。Claude Code のログイン（Team プラン等）を
   そのまま使うので API キーは要らないが、使用量はそのアカウントに乗る。
   実測で1手あたり約16,600トークン / $0.17 / 1.5秒。--max-moves で上限を切ること。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np
import onnxruntime as ort

import features as F
import llm_player as LP
from goban import BLACK, PASS, WHITE, Board
from mcts import MCTS


def katago_move(sess, board: Board, *, komi: float, visits: int, top_k: int) -> tuple[int, float]:
    """KataGo の着手と、その局面の手番視点の勝率を返す。"""
    if visits <= 1:
        # 探索なし。main.py の visits=1 の経路と同じく policy ch0 を使う。
        bin_in, glob_in = F.encode(board, komi=komi)
        dt = F.input_dtype(sess)
        out = sess.run(None, {"bin_input": bin_in.astype(dt, copy=False),
                              "global_input": glob_in.astype(dt, copy=False)})
        res = dict(zip([o.name for o in sess.get_outputs()], out, strict=True))
        policy = np.asarray(res["policy"])[0, 0].astype(np.float64)
        probs = F.softmax_masked(policy, board.legal_mask())
        value = np.asarray(res["value"])[0].astype(np.float64)
        e = np.exp(value - value.max())
        move = int(np.argmax(probs))
        return (PASS if move == board.n else move), float((e / e.sum())[0])

    engine = MCTS(sess, komi=komi, top_k=top_k)
    root, _ = engine.search(board, visits=visits, max_time_ms=30_000)
    a, _ = MCTS.pick(root, 0.0)
    mv = int(root.moves[a])
    q = float(root.W[a] / root.N[a]) if root.N[a] > 0 else 0.0
    return (PASS if mv == board.n else mv), (q + 1.0) / 2.0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--size", type=int, default=9, choices=(9, 13, 19))
    ap.add_argument("--komi", type=float, default=6.5)
    ap.add_argument("--visits", type=int, default=8, help="KataGo 側の探索回数")
    ap.add_argument("--search-top-k", type=int, default=24)
    ap.add_argument("--llm-color", choices=("black", "white"), default="black")
    ap.add_argument("--max-moves", type=int, default=None,
                    help="既定は盤の広さ×1.2手。課金の上限にもなる")
    ap.add_argument("--model", default=LP.MODEL)
    ap.add_argument("--model-path", default=os.environ.get("MODEL_PATH", "models/model.onnx"))
    # 既定は engine/games/ にタイムスタンプ付きで残す。上書きで前の対局を失わないため。
    # ~/Desktop など好きな場所を --out で指定してもよい。
    ap.add_argument("--out", default=None,
                    help="棋譜の出力先。既定は engine/games/<日時>_<盤>路.json")
    ap.add_argument("--resign-at", type=float, default=0.98,
                    help="KataGo 側の勝率がこれを超え続けたら相手を投了させる。0で無効")
    ap.add_argument("--resign-streak", type=int, default=5,
                    help="--resign-at が何手続いたら投了とみなすか")
    # 序盤で勝率が振り切れても投了させない。評価値が高いのは差がついている証拠だが、
    # 布石の段階で投げると棋譜として何も残らない（実測で 5〜25手で終わった）。
    ap.add_argument("--resign-after", type=float, default=0.6,
                    help="盤の広さに対して何割の手数が進んだら投了を許すか。1.0で実質無効")
    args = ap.parse_args()

    area = args.size * args.size
    if args.max_moves is None:
        args.max_moves = int(area * 1.2)
    resign_from = int(area * args.resign_after)

    if args.out is None:
        stamp = time.strftime("%Y%m%d-%H%M%S")
        out_dir = Path(__file__).resolve().parent.parent / "games"
        args.out = str(out_dir / f"{stamp}_{args.size}路.json")
    Path(args.out).expanduser().parent.mkdir(parents=True, exist_ok=True)
    args.out = str(Path(args.out).expanduser())

    llm_color = BLACK if args.llm_color == "black" else WHITE
    print(f"{args.size}路 / コミ {args.komi} / Claude={args.llm_color} "
          f"({args.model}) vs KataGo(visits={args.visits})", flush=True)
    print(f"最大 {args.max_moves} 手 / 投了は {resign_from} 手目以降のみ"
          f"（勝率 {args.resign_at} が {args.resign_streak} 手継続）", flush=True)

    so = ort.SessionOptions()
    so.intra_op_num_threads = int(os.environ.get("ORT_THREADS", 4))
    sess = ort.InferenceSession(args.model_path, sess_options=so,
                                providers=["CPUExecutionProvider"])

    def snapshot(result: dict | None) -> dict:
        return {
            "source": "llm_vs_katago",
            "id": None,
            "size": args.size,
            "komi": args.komi,
            "black": {"name": "Claude" if llm_color == BLACK else f"KataGo v{args.visits}",
                      "rating": None},
            "white": {"name": "Claude" if llm_color == WHITE else f"KataGo v{args.visits}",
                      "rating": None},
            "moves": moves,
            "result": result,
            "created": None,
        }

    def save(result: dict | None) -> None:
        # 毎手書く。1手でも落ちると全部消えるのは高くつく（実測で22手ぶん失った）。
        Path(args.out).write_text(
            json.dumps(snapshot(result), ensure_ascii=False, indent=1), encoding="utf-8")

    board = Board(args.size)
    moves: list[dict] = []
    usage = LP.Usage()
    last: int | None = None
    passes = 0
    hopeless = 0
    illegal_total = 0
    timeouts = 0
    result: dict | None = None
    t0 = time.perf_counter()

    for ply in range(args.max_moves):
        who = board.to_move
        if who == llm_color:
            r = LP.choose_move(board, komi=args.komi, last_move=last,
                               model=args.model)
            usage.add(r)
            mv, note = r.move, r.reason
            if r.attempts > 1:
                illegal_total += r.attempts - 1
            tag = "Claude"
            if r.timed_out:
                timeouts += 1
            if r.forced_pass:
                note = "合法手を返せずパス"
        else:
            mv, wr = katago_move(sess, board, komi=args.komi, visits=args.visits,
                                 top_k=args.search_top_k)
            note = f"勝率 {wr:.3f}"
            tag = "KataGo"
            # 勝ち切っている局面を最後まで打たせても情報が増えず、費用だけかかる。
            # 人間なら投了している水準で切り上げる。
            # 最終盤に入るまでは投了させない。序盤の大差は投了の理由にしない。
            if args.resign_at > 0 and ply >= resign_from and wr >= args.resign_at:
                hopeless += 1
                if hopeless >= args.resign_streak:
                    winner = WHITE if llm_color == BLACK else BLACK
                    result = {"winner": int(winner), "reason": "RESIGN",
                              "text": f"{'黒' if llm_color == BLACK else '白'}投了"
                                      f"（{ply + 1}手目 / KataGo の勝率が"
                                      f" {args.resign_at} 超で{args.resign_streak}手継続）"}
                    print(f"{ply + 1:>3} {tag:>7} {LP.to_gtp(args.size, mv):>5}  {note}",
                          flush=True)
                    break
            else:
                hopeless = 0

        gtp = LP.to_gtp(args.size, mv)
        print(f"{ply + 1:>3} {tag:>7} {gtp:>5}  {note[:60]}", flush=True)
        moves.append({"move": mv, "color": int(who), "time_ms": None,
                      "by": tag, "note": note})
        save(None)

        if mv == PASS:
            passes += 1
            board.to_move = WHITE if who == BLACK else BLACK
            if passes >= 2:
                result = {"winner": None, "reason": "PASS",
                          "text": "両者パスで終局（整地は UI で）"}
                break
        else:
            passes = 0
            board.play(mv, who)
        last = mv

    if result is None:
        result = {"winner": None, "reason": "MAXMOVES",
                  "text": f"{args.max_moves} 手で打ち切り"}

    elapsed = time.perf_counter() - t0
    save(result)

    print()
    print(f"{len(moves)} 手 / {elapsed:.0f}s / {result['text']}")
    print(f"Claude の非合法手: {illegal_total} 回 / タイムアウト {timeouts} 回 / "
          f"API 呼び出し {usage.calls} 回")
    print(f"トークン: 入力 {usage.input_tokens} / 出力 {usage.output_tokens} / "
          f"キャッシュ書込 {usage.cache_write_tokens} 読出 {usage.cache_read_tokens}")
    print(f"概算コスト: ${usage.cost_usd(args.model):.3f}")
    print(f"棋譜: {args.out}（Web UI の検討モードに読み込める）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
