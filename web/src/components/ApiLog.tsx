import { PASS, type GenmoveRequest, type GenmoveResponse } from '../types';

export interface ApiLogEntry {
  id: number;
  at: Date;
  path: string;
  req: GenmoveRequest;
  res?: GenmoveResponse;
  error?: string;
  /** 往復の実測。res.inference_ms（サーバー内の推論時間）との差が通信＋探索の外側 */
  elapsedMs: number;
}

interface Props {
  entries: ApiLogEntry[];
  open: boolean;
  onToggle: () => void;
  onClear: () => void;
  apiBase: string;
}

const time = (d: Date) =>
  `${d.toLocaleTimeString('ja-JP', { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`;

/** 候補手の重み。探索ありは visits、探索なしは policy 確率。 */
const weight = (c: { visits?: number; prob?: number }) => c.visits ?? c.prob ?? 0;

function Entry({ e }: { e: ApiLogEntry }) {
  const cands = e.res?.candidates ?? [];
  // 棒グラフは最大値基準。visits と prob でスケールが違うので絶対値では引けない。
  const max = cands.reduce((m, c) => Math.max(m, weight(c)), 0) || 1;

  return (
    <li className="log-entry">
      <div className="log-head">
        <span className="log-time">{time(e.at)}</span>
        <code>POST {e.path}</code>
        {e.error ? <span className="err">失敗</span> : <span className="muted">{e.elapsedMs} ms</span>}
      </div>

      <div className="log-req muted">
        {e.req.size}路 / 手番 {e.req.to_move === 1 ? '黒' : '白'} / コミ {e.req.komi} /
        {' '}visits {e.req.visits} / 温度 {e.req.temperature} / top_k {e.req.top_k}
      </div>

      {e.error && <div className="err log-err">{e.error}</div>}

      {e.res && (
        <>
          <div className="log-pick">
            選んだ手 <strong>{e.res.move === PASS ? 'パス' : e.res.gtp}</strong>
            <span className="muted">
              {' '}/ 勝率(手番) {(e.res.winrate * 100).toFixed(1)}% /
              {' '}{e.res.search ? `探索 ${e.res.visits} visits` : '探索なし'} /
              {' '}推論 {e.res.nn_calls} 回 {e.res.inference_ms} ms
            </span>
          </div>

          {cands.length > 0 && (
            <ol className="log-cands">
              {cands.map((c) => {
                const picked = c.move === e.res!.move;
                const w = weight(c);
                return (
                  <li key={`${c.move}`} className={picked ? 'picked' : undefined}>
                    <span className="cand-gtp">{c.move === PASS ? 'パス' : c.gtp}</span>
                    <span className="cand-bar">
                      <span style={{ width: `${(w / max) * 100}%` }} />
                    </span>
                    <span className="cand-val">
                      {c.visits !== undefined ? `${c.visits}v` : `${(w * 100).toFixed(1)}%`}
                    </span>
                    {picked && <span className="cand-mark">←</span>}
                  </li>
                );
              })}
            </ol>
          )}
        </>
      )}

      <details className="log-raw">
        <summary className="muted">生の JSON</summary>
        <pre>{JSON.stringify({ request: e.req, response: e.res ?? e.error }, null, 1)}</pre>
      </details>
    </li>
  );
}

/**
 * API 通信の可視化。画面右端のドロワー。
 *
 * 「どんな候補があって、どれを選んだか」を毎リクエスト残す。
 * temperature > 0 だと最善手以外を選ぶので、その挙動の確認にも使う。
 */
export function ApiLog({ entries, open, onToggle, onClear, apiBase }: Props) {
  return (
    <div className={open ? 'apilog open' : 'apilog'}>
      <button className="apilog-tab" onClick={onToggle}
              aria-expanded={open} title="API 通信ログ">
        {open ? '›' : '‹'} API {entries.length ? `(${entries.length})` : ''}
      </button>

      {open && (
        <div className="apilog-body">
          <div className="apilog-head">
            <strong>API 通信</strong>
            <code className="muted">{apiBase}</code>
            <button onClick={onClear} disabled={!entries.length}>消去</button>
          </div>
          {entries.length === 0
            ? <p className="muted">まだリクエストがありません。盤に着手すると記録されます。</p>
            : <ol className="apilog-list">{entries.map((e) => <Entry key={e.id} e={e} />)}</ol>}
        </div>
      )}
    </div>
  );
}
