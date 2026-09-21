/**
 * 囲碁のルール（TypeScript版）。
 *
 * ⚠️ engine/goban.py と同じロジックの移植。食い違ったら **サーバー側が正**。
 *    着手をサーバー往復（0.3〜3秒）待たずに反映するために二重実装している。
 *
 * 未実装（SPEC_UI.md の Phase U1）:
 *   - 超コウ（同一局面反復）
 *   - 終局判定（両者連続パス）
 *   - 地の計算
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
  const r = Math.floor(p / size), c = p % size;
  const out: number[] = [];
  if (r > 0) out.push(p - size);
  if (r < size - 1) out.push(p + size);
  if (c > 0) out.push(p - 1);
  if (c < size - 1) out.push(p + 1);
  return out;
}

/** p を含む連の石集合と呼吸点集合 */
export function groupAndLiberties(
  stones: Int8Array, size: number, p: number,
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
      else if (v === color && !group.has(nb)) { group.add(nb); stack.push(nb); }
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
    size, stones: next, toMove: opp, ko,
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
  const r = Math.floor(p / size), c = p % size;
  return `${letters[c]}${size - r}`;
}
