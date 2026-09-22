/**
 * エンジンAPIの型。
 *
 * ⚠️ engine/main.py の Pydantic モデルと手で同期させること。
 *    コード生成は入れていない（この規模では過剰）。片方だけ直さない。
 */

export const EMPTY = 0;
export const BLACK = 1;
export const WHITE = 2;
export const PASS = -1;

export type Color = typeof BLACK | typeof WHITE;
/** 盤上の一次元index（0..size*size-1）、または PASS */
export type Move = number;

export interface GenmoveRequest {
  size: number;
  /** 0=空 1=黒 2=白、長さ size*size */
  stones: number[];
  to_move: Color;
  /** 直近の着手。-1=パス。直近5手が特徴量に入る */
  history: Move[];
  /** 単純コウで着手禁止の点。-1=なし */
  ko: number;
  komi: number;

  /** MCTSの探索回数。1なら探索なし（生policy） */
  visits: number;
  /** 探索の打ち切り時間（100〜55000） */
  max_time_ms: number;
  /** 大きいほど広く浅く探索 */
  c_puct: number;
  /** 各ノードで候補にする手の数 */
  search_top_k: number;
  /** 1回の推論でまとめて評価する葉の数 */
  batch_size: number;
  /** 0=最善手。大きいほどばらけて弱くなる */
  temperature: number;
  /** 候補手を上位k件返す。0なら返さない */
  top_k: number;
}

export interface Candidate {
  move: Move;
  gtp: string;
  /** 探索あり時のみ */
  visits?: number;
  /** 探索なし時は policy 確率 */
  prob?: number;
  winrate?: number | null;
}

export interface GenmoveResponse {
  move: Move;
  gtp: string;
  /** ⚠️ 手番側の勝率。黒視点に直すには白の手番なら 1-winrate */
  winrate: number;
  confidence: number;
  visits: number;
  /** 実際の推論回数。バッチ化の効きを確認できる */
  nn_calls: number;
  inference_ms: number;
  search: boolean;
  candidates?: Candidate[];
}

export interface AnalyzeResponse {
  /** ⚠️ 手番側の勝率 */
  winrate: number;
  loss: number;
  inference_ms: number;
  /** 長さ size*size。符号の向きは実測で確認すること */
  ownership?: number[];
}

export interface HealthResponse {
  ok: boolean;
  threads: number;
  model: string;
}

/** 手番視点の勝率を黒視点に直す。視点の取り違えを1箇所に閉じ込める。 */
export function toBlackWinrate(winrate: number, toMove: Color): number {
  return toMove === BLACK ? winrate : 1 - winrate;
}

/** 外部サービスから取り込んだ棋譜。engine/kifu.py の返す形と手で同期させる。 */
export interface KifuPlayer { name: string | null; rating: number | null }
export interface KifuMove { move: Move; color: Color; time_ms: number | null }
export interface KifuResult { winner: Color | null; reason: string; text: string }
export interface KifuGame {
  source: string;
  id: string | null;
  size: number;
  /** 囲碁クエストの JSON にコミは無いので null が来る */
  komi: number | null;
  black: KifuPlayer;
  white: KifuPlayer;
  moves: KifuMove[];
  result: KifuResult | null;
  created: string | null;
}
