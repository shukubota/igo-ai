import { useEffect, useRef } from 'react';
import { BLACK } from '../types';

interface Props {
  size: number;
  stones: Int8Array;
  /** 直前の着手（マーカーを打つ）。-1 なら描かない */
  lastMove: number;
  onPlay: (index: number) => void;
  disabled?: boolean;
  /** 整地モード: 死石に指定した点 */
  dead?: ReadonlySet<number>;
  /** 整地モード: 各点の帰属（0=中立 1=黒 2=白） */
  territory?: Int8Array | null;
  /** 検討モード: 候補手。weight は 0..1 に正規化済み */
  candidates?: Array<{ move: number; label: string; weight: number }>;
  /** 検討モード: 実際に打たれた手。候補と見分けるため印を変える */
  actualMove?: number;
}

/**
 * 碁盤の描画。canvas に命令的に描く。
 *
 * 責務は「盤面配列を受けて描く」と「クリック座標を index に変換する」だけ。
 * ルール判定は持たない（goban/rules.ts の担当）。
 */
/**
 * 星の位置（行, 列）。0-indexed。
 *
 * 19路は 3/9/15 の9点だが、13路・9路は隅4点＋天元の5点で、
 * 19路と同じ総当たりで描くと存在しない星を描いてしまう。
 */
function hoshi(size: number): Array<[number, number]> {
  if (size === 19) {
    const xs = [3, 9, 15];
    return xs.flatMap((r) => xs.map((c) => [r, c] as [number, number]));
  }
  if (size === 13)
    return [
      [3, 3],
      [3, 9],
      [9, 3],
      [9, 9],
      [6, 6],
    ];
  if (size === 9)
    return [
      [2, 2],
      [2, 6],
      [6, 2],
      [6, 6],
      [4, 4],
    ];
  return [];
}

export function Board({
  size,
  stones,
  lastMove,
  onPlay,
  disabled,
  dead,
  territory,
  candidates,
  actualMove,
}: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;

    const draw = () => {
      const ctx = cv.getContext('2d');
      if (!ctx) return;
      const css = cv.clientWidth;
      const dpr = window.devicePixelRatio || 1;
      cv.width = css * dpr;
      cv.height = css * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const pad = css * 0.045;
      const gap = (css - pad * 2) / (size - 1);

      ctx.fillStyle = '#dcb35c';
      ctx.fillRect(0, 0, css, css);

      ctx.strokeStyle = '#4a3a1a';
      ctx.lineWidth = Math.max(0.6, css / 760);
      for (let i = 0; i < size; i++) {
        ctx.beginPath();
        ctx.moveTo(pad, pad + i * gap);
        ctx.lineTo(css - pad, pad + i * gap);
        ctx.moveTo(pad + i * gap, pad);
        ctx.lineTo(pad + i * gap, css - pad);
        ctx.stroke();
      }

      // 星
      ctx.fillStyle = '#4a3a1a';
      for (const [r, c] of hoshi(size)) {
        ctx.beginPath();
        ctx.arc(pad + c * gap, pad + r * gap, Math.max(1.8, css / 230), 0, Math.PI * 2);
        ctx.fill();
      }

      // 地（整地モード）。石より先に描いて石の下に敷く。
      if (territory) {
        const t = gap * 0.18;
        for (let p = 0; p < size * size; p++) {
          const v = territory[p];
          if (!v || stones[p]) continue; // 石のある点には描かない
          ctx.fillStyle = v === BLACK ? 'rgba(20,20,20,.55)' : 'rgba(250,250,250,.85)';
          ctx.strokeStyle = 'rgba(120,120,120,.6)';
          const x = pad + (p % size) * gap,
            y = pad + Math.floor(p / size) * gap;
          ctx.beginPath();
          ctx.rect(x - t, y - t, t * 2, t * 2);
          ctx.fill();
          ctx.stroke();
        }
      }

      // 石
      const rad = gap * 0.47;
      for (let p = 0; p < size * size; p++) {
        const v = stones[p];
        if (!v) continue;
        const x = pad + (p % size) * gap;
        const y = pad + Math.floor(p / size) * gap;
        const g = ctx.createRadialGradient(
          x - rad * 0.35,
          y - rad * 0.35,
          rad * 0.1,
          x,
          y,
          rad,
        );
        if (v === BLACK) {
          g.addColorStop(0, '#5a5a5a');
          g.addColorStop(1, '#0a0a0a');
        } else {
          g.addColorStop(0, '#ffffff');
          g.addColorStop(1, '#c8c5bd');
        }
        const isDead = dead?.has(p) ?? false;
        ctx.save();
        if (isDead) ctx.globalAlpha = 0.32; // 死石は薄く
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, rad, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        if (isDead) {
          // 薄くするだけだと色の濃淡と紛れるので × も重ねる
          ctx.strokeStyle = '#c0392b';
          ctx.lineWidth = Math.max(1.6, css / 260);
          const d = rad * 0.55;
          ctx.beginPath();
          ctx.moveTo(x - d, y - d);
          ctx.lineTo(x + d, y + d);
          ctx.moveTo(x + d, y - d);
          ctx.lineTo(x - d, y + d);
          ctx.stroke();
          continue; // 死石には最終手マークを出さない
        }

        if (p === lastMove) {
          ctx.strokeStyle = v === BLACK ? '#fff' : '#000';
          ctx.lineWidth = Math.max(1.4, css / 300);
          ctx.beginPath();
          ctx.arc(x, y, rad * 0.4, 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      // 候補手（検討モード）。着手可能な空点に確率/訪問数を重ねる。
      if (candidates?.length) {
        const r2 = gap * 0.42;
        for (const c of candidates) {
          if (c.move < 0 || c.move >= size * size || stones[c.move]) continue;
          const x = pad + (c.move % size) * gap;
          const y = pad + Math.floor(c.move / size) * gap;
          ctx.fillStyle = `rgba(30,110,200,${0.18 + c.weight * 0.5})`;
          ctx.beginPath();
          ctx.arc(x, y, r2, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = 'rgba(20,80,160,.9)';
          ctx.lineWidth = Math.max(1, css / 420);
          ctx.stroke();
          ctx.fillStyle = '#fff';
          ctx.font = `${Math.max(8, gap * 0.34)}px system-ui, sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(c.label, x, y);
        }
      }

      // 実際に打たれた手。AI の候補と重なっていても分かるよう外側に輪を描く。
      if (actualMove !== undefined && actualMove >= 0 && actualMove < size * size) {
        const x = pad + (actualMove % size) * gap;
        const y = pad + Math.floor(actualMove / size) * gap;
        ctx.strokeStyle = '#c0392b';
        ctx.lineWidth = Math.max(1.6, css / 260);
        ctx.beginPath();
        ctx.arc(x, y, gap * 0.5, 0, Math.PI * 2);
        ctx.stroke();
      }
    };

    draw();
    // 親要素のリサイズに追従する（ウィンドウリサイズだけでは足りない）
    const ro = new ResizeObserver(draw);
    ro.observe(cv);
    return () => ro.disconnect();
  }, [size, stones, lastMove, dead, territory, candidates, actualMove]);

  const handleClick = (ev: React.MouseEvent<HTMLCanvasElement>) => {
    if (disabled) return;
    const cv = ev.currentTarget;
    const css = cv.clientWidth;
    const pad = css * 0.045;
    const gap = (css - pad * 2) / (size - 1);
    const rect = cv.getBoundingClientRect();
    const c = Math.round((ev.clientX - rect.left - pad) / gap);
    const r = Math.round((ev.clientY - rect.top - pad) / gap);
    if (r < 0 || r >= size || c < 0 || c >= size) return;
    onPlay(r * size + c);
  };

  return (
    <canvas
      ref={ref}
      onClick={handleClick}
      style={{
        width: '100%',
        aspectRatio: '1',
        display: 'block',
        borderRadius: 6,
        cursor: disabled ? 'default' : 'pointer',
        boxShadow: '0 2px 14px rgba(0,0,0,.18)',
      }}
    />
  );
}
