/**
 * ルール実装のテスト。
 *
 * ⚠️ engine/tests/test_goban.py と同じケースを維持すること。
 */
import { describe, it, expect } from 'vitest';
import { createPosition, tryPlay, isLegal, pass, toGtp } from './rules';
import { BLACK, WHITE, EMPTY, PASS } from '../types';

describe('取り', () => {
  it('中央の白1子を黒4子で囲んで取る', () => {
    let p = createPosition(19);
    p.stones[180] = WHITE;
    for (const q of [161, 199, 179]) p = tryPlay(p, q, BLACK)!;
    expect(p.stones[180]).toBe(WHITE);
    p = tryPlay(p, 181, BLACK)!;
    expect(p.stones[180]).toBe(EMPTY);
    expect(p.prisoners[BLACK]).toBe(1);
  });
});

describe('自殺手', () => {
  it('呼吸点のない自分の石は置けない', () => {
    const p = createPosition(19);
    p.stones[1] = WHITE;
    p.stones[19] = WHITE;
    expect(isLegal(p, 0, BLACK)).toBe(false);
  });

  it('相手を取れるなら合法', () => {
    const p = createPosition(19);
    p.stones[1] = WHITE; p.stones[19] = WHITE;
    p.stones[2] = BLACK; p.stones[20] = BLACK; p.stones[38] = BLACK;
    expect(isLegal(p, 0, BLACK)).toBe(true);
  });
});

describe('コウ', () => {
  const ix = (r: number, c: number) => r * 19 + c;

  it('取り返しが禁止され、1手他所に打つと解除される', () => {
    let p = createPosition(19);
    p.stones[ix(5, 6)] = BLACK; p.stones[ix(5, 7)] = WHITE;
    p.stones[ix(6, 5)] = BLACK; p.stones[ix(6, 6)] = WHITE; p.stones[ix(6, 8)] = WHITE;
    p.stones[ix(7, 6)] = BLACK; p.stones[ix(7, 7)] = WHITE;

    p = tryPlay(p, ix(6, 7), BLACK)!;
    expect(p.stones[ix(6, 6)]).toBe(EMPTY);
    expect(p.ko).toBe(ix(6, 6));
    expect(isLegal(p, ix(6, 6), WHITE)).toBe(false);

    const q = pass(p);
    expect(q.ko).toBe(-1);
    expect(isLegal(q, ix(6, 6), WHITE)).toBe(true);
  });

  it('1子取りでも打った石に呼吸点が複数あればコウにならない', () => {
    let p = createPosition(19);
    p.stones[180] = WHITE;
    for (const q of [161, 199, 179]) p = tryPlay(p, q, BLACK)!;
    p = tryPlay(p, 181, BLACK)!;
    expect(p.ko).toBe(-1);
  });
});

describe('パスと手番', () => {
  it('手番が入れ替わりコウが解除される', () => {
    const p = createPosition(19);
    expect(p.toMove).toBe(BLACK);
    const q = pass(p);
    expect(q.toMove).toBe(WHITE);
    expect(q.ko).toBe(-1);
  });
});

describe('GTP座標', () => {
  it('index を GTP 表記に変換する', () => {
    expect(toGtp(19, 0)).toBe('A19');
    expect(toGtp(19, 180)).toBe('K10');
    expect(toGtp(19, PASS)).toBe('pass');
  });
});
