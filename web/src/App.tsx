import { useCallback, useRef, useState } from 'react';
import { Board } from './components/Board';
import { genmove } from './api/client';
import { createPosition, tryPlay, pass, toGtp, type Position } from './goban/rules';
import { PASS, BLACK, toBlackWinrate, type GenmoveResponse } from './types';

const SIZE = 19;

/**
 * 対局画面。
 *
 * サーバーはステートレスなので、対局の正はここ（クライアント）にある。
 * SPEC_UI.md の Phase U1 以降で rules.ts / 検討機能 / 棋譜を足していく。
 */
export default function App() {
  const [pos, setPos] = useState<Position>(() => createPosition(SIZE));
  const [history, setHistory] = useState<number[]>([]);
  const [snapshots, setSnapshots] = useState<Array<{ pos: Position; history: number[] }>>([]);
  const [thinking, setThinking] = useState(false);
  const [last, setLast] = useState<GenmoveResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [visits, setVisits] = useState(1);
  const abort = useRef<AbortController | null>(null);

  const lastMove = history.length ? history[history.length - 1]! : -1;
  const blackWinrate = last ? toBlackWinrate(last.winrate, pos.toMove) : 0.5;

  const askEngine = useCallback(async (p: Position, h: number[]) => {
    setThinking(true);
    setError(null);
    abort.current = new AbortController();
    try {
      const res = await genmove({
        size: p.size,
        stones: Array.from(p.stones),
        to_move: p.toMove,
        history: h.slice(-5),
        ko: p.ko,
        komi: 7.5,
        visits,
        max_time_ms: 30_000,
        c_puct: 1.4,
        search_top_k: 24,
        batch_size: 8,
        temperature: 0.6,
        top_k: 5,
      }, abort.current.signal);
      setLast(res);
      const next = res.move === PASS ? pass(p) : tryPlay(p, res.move);
      // サーバーが非合法手を返したら盤面は動かさない（Phase 0 未完了の兆候）
      if (!next) { setError(`エンジンが非合法手を返しました: ${res.gtp}`); return; }
      setPos(next);
      setHistory([...h, res.move]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setThinking(false);
      abort.current = null;
    }
  }, [visits]);

  const handlePlay = useCallback(async (idx: number) => {
    if (thinking || pos.toMove !== BLACK) return;
    const next = tryPlay(pos, idx);
    if (!next) { setError('そこには打てません'); return; }
    setSnapshots((s) => [...s, { pos, history }]);
    const h = [...history, idx];
    setPos(next); setHistory(h); setError(null);
    await askEngine(next, h);
  }, [pos, history, thinking, askEngine]);

  const handlePass = async () => {
    if (thinking || pos.toMove !== BLACK) return;
    setSnapshots((s) => [...s, { pos, history }]);
    const next = pass(pos);
    const h = [...history, PASS];
    setPos(next); setHistory(h);
    await askEngine(next, h);
  };

  const handleUndo = () => {
    if (thinking) return;
    const s = snapshots[snapshots.length - 1];
    if (!s) return;
    setPos(s.pos); setHistory(s.history);
    setSnapshots((xs) => xs.slice(0, -1));
    setError(null);
  };

  const handleReset = () => {
    abort.current?.abort();
    setPos(createPosition(SIZE)); setHistory([]); setSnapshots([]);
    setLast(null); setError(null);
  };

  return (
    <div className="app">
      <header>
        <strong>igo-ai</strong>
        <span className="muted">
          {history.length} 手 / 手番 {pos.toMove === BLACK ? '黒' : '白'}
          {' '}/ アゲハマ 黒{pos.prisoners[BLACK]} 白{pos.prisoners[2]}
        </span>
      </header>

      <div className="layout">
        <div className="board-col">
          <Board size={SIZE} stones={pos.stones} lastMove={lastMove}
                 onPlay={handlePlay} disabled={thinking || pos.toMove !== BLACK} />
        </div>

        <aside>
          <div className="panel">
            <label>黒の勝率 {(blackWinrate * 100).toFixed(1)}%</label>
            <div className="wr"><div style={{ width: `${blackWinrate * 100}%` }} /></div>
          </div>

          <div className="panel">
            <label htmlFor="visits">強さ（visits）</label>
            <select id="visits" value={visits} disabled={thinking}
                    onChange={(e) => setVisits(Number(e.target.value))}>
              <option value={1}>1 — 探索なし（速い）</option>
              <option value={10}>10 — 少し読む</option>
              <option value={30}>30 — 読む（3秒前後）</option>
            </select>
          </div>

          <div className="panel actions">
            <button onClick={handlePass} disabled={thinking}>パス</button>
            <button onClick={handleUndo} disabled={thinking || !snapshots.length}>待った</button>
            <button onClick={handleReset}>初期化</button>
            {thinking && <button onClick={() => abort.current?.abort()}>中断</button>}
          </div>

          <div className="panel status">
            {thinking && <span>AI 思考中…</span>}
            {error && <span className="err">{error}</span>}
            {!thinking && !error && last && (
              <span>
                AI: {last.gtp} / {last.visits} visits /
                推論 {last.nn_calls} 回 / {last.inference_ms} ms
              </span>
            )}
            {!thinking && !error && !last && <span className="muted">あなたは黒番です。</span>}
          </div>

          <div className="panel kifu">
            <label>棋譜</label>
            <ol>
              {history.map((m, i) => (
                <li key={i}>{m === PASS ? 'パス' : toGtp(SIZE, m)}</li>
              ))}
            </ol>
          </div>
        </aside>
      </div>
    </div>
  );
}
