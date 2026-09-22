export interface WinratePoint {
  /** 何手目の局面に対する評価か */
  ply: number;
  /** 黒の勝率 0..1 */
  black: number;
}

interface Props {
  points: WinratePoint[];
  /** 検討中に見ている手数。縦線で示す */
  cursorPly?: number;
  /** グラフをクリックしてその手数へ飛ぶ */
  onSeek?: (ply: number) => void;
}

const W = 260;
const H = 84;
const PAD = 2;

/**
 * 黒の勝率の推移。
 *
 * 点が打たれるのはエンジンに問い合わせたときだけなので、
 * 人間の着手とエンジンの着手で1点ずつではなく、1往復で1点になる。
 *
 * viewBox で描いて CSS 側で伸縮させる（盤やパネル幅に追従させるため）。
 */
export function WinrateChart({ points, cursorPly, onSeek }: Props) {
  if (points.length === 0) {
    return <p className="muted wr-empty">着手するとここに勝率の推移が出ます。</p>;
  }

  const x = (i: number) =>
    points.length === 1 ? W / 2 : PAD + (i / (points.length - 1)) * (W - PAD * 2);
  const y = (v: number) => PAD + (1 - v) * (H - PAD * 2);

  const line = points.map((p, i) => `${x(i).toFixed(1)},${y(p.black).toFixed(1)}`).join(' ');
  // 塗りは 50% 線との差分。黒優勢か白優勢かを面で見せる。
  const area = `${x(0).toFixed(1)},${y(0.5).toFixed(1)} ${line} ${x(points.length - 1).toFixed(1)},${y(0.5).toFixed(1)}`;
  const latest = points[points.length - 1]!;

  return (
    <div className="wrchart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img"
           aria-label={`黒の勝率の推移。最新 ${(latest.black * 100).toFixed(1)}%`}>
        <rect x="0" y="0" width={W} height={H} className="wrc-bg" />
        <line x1="0" y1={y(0.5)} x2={W} y2={y(0.5)} className="wrc-mid" />
        <polygon points={area} className="wrc-area" />
        <polyline points={line} className="wrc-line" />
        <circle cx={x(points.length - 1)} cy={y(latest.black)} r="2.5" className="wrc-dot" />
        {cursorPly !== undefined && (() => {
          // 手数は飛び飛び（1往復1点）なので、一番近い点に線を合わせる
          let best = 0;
          points.forEach((p, i) => {
            if (Math.abs(p.ply - cursorPly) < Math.abs(points[best]!.ply - cursorPly)) best = i;
          });
          return <line x1={x(best)} y1="0" x2={x(best)} y2={H} className="wrc-cursor" />;
        })()}
        {onSeek && (
          <rect x="0" y="0" width={W} height={H} fill="transparent"
                className="wrc-hit"
                onClick={(ev) => {
                  const r = (ev.target as SVGRectElement).getBoundingClientRect();
                  const ratio = (ev.clientX - r.left) / r.width;
                  const i = Math.round(ratio * (points.length - 1));
                  onSeek(points[Math.max(0, Math.min(points.length - 1, i))]!.ply);
                }} />
        )}
      </svg>
      <div className="wrc-axis muted">
        <span>{points[0]!.ply} 手</span>
        <span>黒 {(latest.black * 100).toFixed(1)}%</span>
        <span>{latest.ply} 手</span>
      </div>
    </div>
  );
}
