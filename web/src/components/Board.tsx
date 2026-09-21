import { useEffect, useRef } from 'react';
import { BLACK } from '../types';

interface Props {
  size: number;
  stones: Int8Array;
  /** 直前の着手（マーカーを打つ）。-1 なら描かない */
  lastMove: number;
  onPlay: (index: number) => void;
  disabled?: boolean;
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
  if (size === 13) return [[3, 3], [3, 9], [9, 3], [9, 9], [6, 6]];
  if (size === 9) return [[2, 2], [2, 6], [6, 2], [6, 6], [4, 4]];
  return [];
}

export function Board({ size, stones, lastMove, onPlay, disabled }: Props) {
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

      // 石
      const rad = gap * 0.47;
      for (let p = 0; p < size * size; p++) {
        const v = stones[p];
        if (!v) continue;
        const x = pad + (p % size) * gap;
        const y = pad + Math.floor(p / size) * gap;
        const g = ctx.createRadialGradient(x - rad * 0.35, y - rad * 0.35, rad * 0.1, x, y, rad);
        if (v === BLACK) { g.addColorStop(0, '#5a5a5a'); g.addColorStop(1, '#0a0a0a'); }
        else { g.addColorStop(0, '#ffffff'); g.addColorStop(1, '#c8c5bd'); }
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, rad, 0, Math.PI * 2);
        ctx.fill();

        if (p === lastMove) {
          ctx.strokeStyle = v === BLACK ? '#fff' : '#000';
          ctx.lineWidth = Math.max(1.4, css / 300);
          ctx.beginPath();
          ctx.arc(x, y, rad * 0.4, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    };

    draw();
    // 親要素のリサイズに追従する（ウィンドウリサイズだけでは足りない）
    const ro = new ResizeObserver(draw);
    ro.observe(cv);
    return () => ro.disconnect();
  }, [size, stones, lastMove]);

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
        width: '100%', aspectRatio: '1', display: 'block', borderRadius: 6,
        cursor: disabled ? 'default' : 'pointer',
        boxShadow: '0 2px 14px rgba(0,0,0,.18)',
      }}
    />
  );
}
