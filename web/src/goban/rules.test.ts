/**
 * ルール実装のテスト。
 *
 * ⚠️ engine/tests/test_goban.py と同じケースを維持すること。
 */
import { describe, it, expect } from 'vitest';
import { createPosition, tryPlay, isLegal, pass, toGtp, score, groupAt } from './rules';
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

describe('地の計算（中国ルール）', () => {
  /** 5路盤を縦に二分する。左2列が黒、右2列が白、中央列が境界。 */
  const split = () => {
    const p = createPosition(5);
    for (let r = 0; r < 5; r++) {
      p.stones[r * 5 + 2] = BLACK;   // 黒の壁
      p.stones[r * 5 + 3] = WHITE;   // 白の壁
    }
    return p;
  };

  it('石と囲った空点を足す', () => {
    const s = score(split(), 0, new Set());
    // 黒: 壁5 + 左の空点10 = 15、白: 壁5 + 右の空点5 = 10
    expect(s.black).toBe(15);
    expect(s.white).toBe(10);
    expect(s.diff).toBe(5);
    expect(s.winner).toBe(BLACK);
  });

  it('コミで勝敗がひっくり返る', () => {
    expect(score(split(), 6.5, new Set()).winner).toBe(WHITE);
    expect(score(split(), 4.5, new Set()).winner).toBe(BLACK);
  });

  it('ちょうど差がゼロなら持碁', () => {
    expect(score(split(), 5, new Set()).winner).toBe(null);
  });

  it('死石を指定すると相手の地になる', () => {
    const p = split();
    const dead = new Set([0 * 5 + 3, 1 * 5 + 3, 2 * 5 + 3, 3 * 5 + 3, 4 * 5 + 3]);
    const s = score(p, 0, dead);
    // 白の壁が消え、右半分3列すべてが黒地になる
    expect(s.black).toBe(25);
    expect(s.white).toBe(0);
    expect(s.winner).toBe(BLACK);
  });

  it('両色に接する空点は中立として数えない', () => {
    const p = createPosition(3);
    p.stones[0] = BLACK;   // 左上
    p.stones[8] = WHITE;   // 右下
    const s = score(p, 0, new Set());
    // 残り7点はどちらにも接するので中立。石1つずつのみ
    expect(s.black).toBe(1);
    expect(s.white).toBe(1);
  });

  it('空盤は誰の地でもない', () => {
    const s = score(createPosition(5), 6.5, new Set());
    expect(s.black).toBe(0);
    expect(s.white).toBe(0);
    expect(s.winner).toBe(WHITE);   // コミのぶん白
  });
});

describe('連の取得（死石のトグル用）', () => {
  it('つながった石をまとめて返す', () => {
    const p = createPosition(5);
    for (const q of [6, 7, 12]) p.stones[q] = BLACK;
    p.stones[8] = WHITE;
    expect([...groupAt(p, 6)].sort((a, b) => a - b)).toEqual([6, 7, 12]);
    expect([...groupAt(p, 8)]).toEqual([8]);
  });

  it('空点は空集合', () => {
    expect(groupAt(createPosition(5), 0).size).toBe(0);
  });
});
