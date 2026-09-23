/**
 * 囲碁のルール（TypeScript版）。
 *
 * ⚠️ engine/goban.py と同じロジックの移植。食い違ったら **サーバー側が正**。
 *    着手をサーバー往復（0.3〜3秒）待たずに反映するために二重実装している。
 *
 * 未実装（SPEC_UI.md の Phase U1）:
 *   - 超コウ（同一局面反復）
 *   - 地の計算
 *
 * 終局判定（両者連続パス）と投了は App.tsx 側で持つ。エンジンはステートレスで
 * 対局の進行を知らないため、対局状態は UI の責務。
 */
import { EMPTY, BLACK, WHITE, type Color } from '../types';

export interface Position {
  size: number;
  stones: Int8Array;
  toMove: Color;
  /** 単純コウの禁止点。-1 = なし */
  ko: number;
  prisoners: Record<Color, number>;
}

export const opponent = (c: Color): Color => (c === BLACK ? WHITE : BLACK);

export function createPosition(size = 19): Position {
  return {
    size,
    stones: new Int8Array(size * size),
    toMove: BLACK,
    ko: -1,
    prisoners: { [BLACK]: 0, [WHITE]: 0 },
  };
}

export function neighbors(size: number, p: number): number[] {
  const r = Math.floor(p / size),
    c = p % size;
  const out: number[] = [];
  if (r > 0) out.push(p - size);
  if (r < size - 1) out.push(p + size);
  if (c > 0) out.push(p - 1);
  if (c < size - 1) out.push(p + 1);
  return out;
}

/** p を含む連の石集合と呼吸点集合 */
export function groupAndLiberties(
  stones: Int8Array,
  size: number,
  p: number,
): { group: Set<number>; liberties: Set<number> } {
  const color = stones[p];
  if (!color) return { group: new Set(), liberties: new Set() };
  const group = new Set([p]);
  const liberties = new Set<number>();
  const stack = [p];
  while (stack.length) {
    const q = stack.pop()!;
    for (const nb of neighbors(size, q)) {
      const v = stones[nb];
      if (v === EMPTY) liberties.add(nb);
      else if (v === color && !group.has(nb)) {
        group.add(nb);
        stack.push(nb);
      }
    }
  }
  return { group, liberties };
}

/**
 * 着手を試す。合法なら新しい盤面を返し、非合法なら null。
 * 元の Position は変更しない。
 */
export function tryPlay(pos: Position, p: number, color?: Color): Position | null {
  const col = color ?? pos.toMove;
  const { size } = pos;
  if (p < 0 || p >= size * size) return null;
  if (pos.stones[p] !== EMPTY) return null;
  if (p === pos.ko) return null;

  const next = Int8Array.from(pos.stones);
  next[p] = col;
  const opp = opponent(col);

  const captured: number[] = [];
  for (const nb of neighbors(size, p)) {
    if (next[nb] === opp) {
      const { group, liberties } = groupAndLiberties(next, size, nb);
      if (liberties.size === 0) captured.push(...group);
    }
  }
  const caps = new Set(captured);
  for (const q of caps) next[q] = EMPTY;

  // 自殺手の禁止（相手を取れる場合は合法）
  if (caps.size === 0) {
    const { liberties } = groupAndLiberties(next, size, p);
    if (liberties.size === 0) return null;
  }

  // 単純コウ: 1子だけ取り、打った石も1子で呼吸点1
  let ko = -1;
  if (caps.size === 1) {
    const { group, liberties } = groupAndLiberties(next, size, p);
    if (group.size === 1 && liberties.size === 1) ko = [...caps][0]!;
  }

  return {
    size,
    stones: next,
    toMove: opp,
    ko,
    prisoners: { ...pos.prisoners, [col]: pos.prisoners[col] + caps.size },
  };
}

export function isLegal(pos: Position, p: number, color?: Color): boolean {
  return tryPlay(pos, p, color) !== null;
}

export function pass(pos: Position): Position {
  return { ...pos, stones: Int8Array.from(pos.stones), toMove: opponent(pos.toMove), ko: -1 };
}

/** 表示用のGTP座標。内部では使わない。 */
export function toGtp(size: number, p: number): string {
  if (p < 0) return 'pass';
  const letters = 'ABCDEFGHJKLMNOPQRST';
  const r = Math.floor(p / size),
    c = p % size;
  return `${letters[c]}${size - r}`;
}

/** p を含む連の石集合。死石のトグルで連ごと選ぶために使う。 */
export function groupAt(pos: Position, p: number): Set<number> {
  if (pos.stones[p] === EMPTY) return new Set();
  return groupAndLiberties(pos.stones, pos.size, p).group;
}

export interface Score {
  /** 黒の地 + 生きている黒石 */
  black: number;
  white: number;
  komi: number;
  /** black - (white + komi)。正なら黒勝ち */
  diff: number;
  /** 持碁（diff === 0）なら null */
  winner: Color | null;
  /** 各点の帰属。EMPTY=中立（ダメ・セキ）、BLACK/WHITE=その色の地か石 */
  owner: Int8Array;
}

/**
 * 中国ルール（地 + 石）で数える。
 *
 * ⚠️ 死活はここでは判定しない。`dead` に入っている石を取り除いた盤面を
 * 「すべての石が生きている」前提で数えるだけ。死活の判断は呼び出し側
 * （＝人間）の責任。ニューラルネットの ownership は値域が [-1,1] に
 * 収まっておらず（実測で -2.6 まで出る）解釈が未確定なので使っていない。
 *
 * 空点は、隣接する石がすべて同色ならその色の地。両色に接する点と、
 * どの石にも到達しない点（空盤など）は中立として数えない。
 */
export function score(pos: Position, komi: number, dead: ReadonlySet<number>): Score {
  const { size } = pos;
  const n = size * size;
  const stones = Int8Array.from(pos.stones);
  for (const p of dead) stones[p] = EMPTY;

  const owner = new Int8Array(n);
  for (let p = 0; p < n; p++) if (stones[p] !== EMPTY) owner[p] = stones[p]!;

  const seen = new Uint8Array(n);
  for (let start = 0; start < n; start++) {
    if (stones[start] !== EMPTY || seen[start]) continue;
    // 空点の連結成分をまとめて塗る
    const region: number[] = [];
    const touching = new Set<number>();
    const stack = [start];
    seen[start] = 1;
    while (stack.length) {
      const q = stack.pop()!;
      region.push(q);
      for (const nb of neighbors(size, q)) {
        const v = stones[nb]!;
        if (v === EMPTY) {
          if (!seen[nb]) {
            seen[nb] = 1;
            stack.push(nb);
          }
        } else {
          touching.add(v);
        }
      }
    }
    if (touching.size === 1) {
      const c = [...touching][0]!;
      for (const q of region) owner[q] = c;
    }
  }

  let black = 0,
    white = 0;
  for (let p = 0; p < n; p++) {
    if (owner[p] === BLACK) black++;
    else if (owner[p] === WHITE) white++;
  }

  const diff = black - (white + komi);
  return {
    black,
    white,
    komi,
    diff,
    winner: diff === 0 ? null : diff > 0 ? BLACK : WHITE,
    owner,
  };
}
