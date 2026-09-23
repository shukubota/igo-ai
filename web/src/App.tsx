import { useCallback, useMemo, useRef, useState } from 'react';
import { Board } from './components/Board';
import { genmove, importKifu, API_BASE } from './api/client';
import { ApiLog, type ApiLogEntry } from './components/ApiLog';
import { WinrateChart, type WinratePoint } from './components/WinrateChart';
import {
  createPosition, tryPlay, pass, toGtp, score, groupAt,
  type Position, type Score,
} from './goban/rules';
import { PASS, BLACK, WHITE, toBlackWinrate, type Candidate, type Color,
         type GenmoveRequest, type GenmoveResponse, type KifuGame, type Move } from './types';

const SIZES = [9, 13, 19] as const;
type Size = (typeof SIZES)[number];
const DEFAULT_SIZE: Size = 13;

// 日本ルールのコミ。features.py は rules="chinese" で符号化しているので、
// 中国ルールに合わせるなら 7.5 にする（碁の数え方が違うぶん 1 目ずれる）。
const KOMI = 6.5;

const COLOR_LABEL: Record<Color, string> = { [BLACK]: '黒', [WHITE]: '白' };

/**
 * 画面の状態。
 *   playing — 対局中
 *   scoring — 両者パス後の死活確認。石をクリックして死石を決める
 *   review  — 検討。手を戻して任意の局面をエンジンに聞ける
 */
type Phase = 'playing' | 'scoring' | 'review';

/**
 * 全手解析の結果。1局面 = 1件。
 *
 * 「この局面で AI なら何を打つか」と「実際に何が打たれたか」を並べて持つのが要点。
 * loss はその手で手番側が失った勝率で、悪手の大きさの目安になる。
 */
interface PlyReview {
  ply: number;
  /** この局面の評価（黒視点） */
  black: number;
  toMove: Color;
  /** AI の候補手 */
  candidates: Candidate[];
  /** 実際に打たれた手。最終局面では null */
  actual: Move | null;
  /** actual が候補の何番目だったか。圏外なら null */
  actualRank: number | null;
  /** この手で手番側が失った勝率。次の局面が無ければ null */
  loss: number | null;
}

interface GameResult {
  kind: 'pass' | 'resign' | 'imported';
  /** 投了で決まった場合の勝者。整地で決まる場合は null（score 側に入る） */
  winner: Color | null;
  text: string;
}

/**
 * 対局画面。
 *
 * サーバーはステートレスなので、対局の正はここ（クライアント）にある。
 * 終局判定・死活・地の計算・検討もすべてクライアント側の責務。
 */
export default function App() {
  const [size, setSize] = useState<Size>(DEFAULT_SIZE);
  const [humanColor, setHumanColor] = useState<Color>(BLACK);
  const [pos, setPos] = useState<Position>(() => createPosition(DEFAULT_SIZE));
  const [history, setHistory] = useState<number[]>([]);
  const [snapshots, setSnapshots] = useState<Array<{ pos: Position; history: number[] }>>([]);
  /** plies[i] = i 手目まで打った局面。検討で手を戻すために持つ。 */
  const [plies, setPlies] = useState<Position[]>(() => [createPosition(DEFAULT_SIZE)]);
  const [thinking, setThinking] = useState(false);
  const [last, setLast] = useState<GenmoveResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [visits, setVisits] = useState(1);
  const [curve, setCurve] = useState<WinratePoint[]>([]);
  const [log, setLog] = useState<ApiLogEntry[]>([]);
  const [logOpen, setLogOpen] = useState(true);

  const [phase, setPhase] = useState<Phase>('playing');
  const [result, setResult] = useState<GameResult | null>(null);
  const [dead, setDead] = useState<ReadonlySet<number>>(() => new Set());
  const [finalScore, setFinalScore] = useState<Score | null>(null);
  /** 検討で見ている手数。plies のインデックス */
  const [cursor, setCursor] = useState(0);
  const [analysis, setAnalysis] = useState<{ ply: number; res: GenmoveResponse } | null>(null);
  const [kifu, setKifu] = useState<KifuGame | null>(null);
  const [kifuUrl, setKifuUrl] = useState('');
  const [importing, setImporting] = useState(false);
  /** 全手の一括解析の進捗。null なら走っていない */
  const [sweep, setSweep] = useState<{ done: number; total: number } | null>(null);
  const [review, setReview] = useState<PlyReview[]>([]);
  /** 検討でどちら側の視点に立つか。取り込み時に選ぶ */
  const [myColor, setMyColor] = useState<Color>(BLACK);
  const [showCandidates, setShowCandidates] = useState(true);

  const abort = useRef<AbortController | null>(null);
  const logSeq = useRef(0);

  const playing = phase === 'playing';
  const myTurn = playing && pos.toMove === humanColor;
  const lastMove = history.length ? history[history.length - 1]! : -1;
  const blackWinrate = curve.length ? curve[curve.length - 1]!.black : 0.5;

  // 整地中はクリックのたびに数え直す。盤が小さいので毎回でも十分速い。
  const liveScore = useMemo(
    () => (phase === 'scoring' ? score(pos, KOMI, dead) : null),
    [phase, pos, dead],
  );

  const shown = phase === 'review' ? plies[cursor]! : pos;
  const shownLastMove = phase === 'review'
    ? (cursor > 0 ? history[cursor - 1]! : -1)
    : lastMove;

  const atCursor = useMemo(
    () => review.find((r) => r.ply === cursor) ?? null, [review, cursor]);

  /** 自分の手のうち、失った勝率が大きい順。振り返りの入口。 */
  const myMistakes = useMemo(() => review
    .filter((r) => r.toMove === myColor && r.loss !== null && r.loss > 0.02)
    .sort((a, b) => (b.loss ?? 0) - (a.loss ?? 0))
    .slice(0, 12), [review, myColor]);

  // 検討中に表示する候補手。重みは最大値で正規化して濃さに使う。
  // 個別解析の結果を優先し、無ければ全手解析の結果を使う。
  const overlayCandidates = useMemo(() => {
    if (phase !== 'review') return undefined;
    const fromAnalysis = analysis && analysis.ply === cursor ? analysis.res.candidates : null;
    const cs = fromAnalysis ?? (showCandidates ? atCursor?.candidates ?? null : null);
    if (!cs) return undefined;
    const val = (c: { visits?: number; prob?: number }) => c.visits ?? c.prob ?? 0;
    const max = cs.reduce((m, c) => Math.max(m, val(c)), 0) || 1;
    return cs.filter((c) => c.move >= 0).map((c) => ({
      move: c.move,
      label: c.visits !== undefined ? String(c.visits) : `${Math.round(val(c) * 100)}`,
      weight: val(c) / max,
    }));
  }, [phase, analysis, cursor, showCandidates, atCursor]);

  // ログは最新30件まで。対局中ずっと溜め続けても困らない程度に抑える。
  const pushLog = (e: ApiLogEntry) => setLog((xs) => [e, ...xs].slice(0, 30));

  const buildReq = (p: Position, h: number[], over: Partial<GenmoveRequest> = {}): GenmoveRequest => ({
    size: p.size,
    stones: Array.from(p.stones),
    to_move: p.toMove,
    history: h.slice(-5),
    ko: p.ko,
    komi: KOMI,
    visits,
    max_time_ms: 30_000,
    c_puct: 1.4,
    search_top_k: 24,
    batch_size: 8,
    temperature: 0.6,
    top_k: 5,
    ...over,
  });

  const askEngine = useCallback(async (p: Position, h: number[]) => {
    setThinking(true);
    setError(null);
    abort.current = new AbortController();

    const req = buildReq(p, h);
    const id = ++logSeq.current;
    const at = new Date();
    const t0 = performance.now();

    try {
      const res = await genmove(req, abort.current.signal);
      pushLog({ id, at, path: '/genmove', req, res,
                elapsedMs: Math.round(performance.now() - t0) });
      setLast(res);
      // winrate はリクエストした局面の手番視点。p.toMove で正規化するのが正しい
      // （エンジンが打った後の pos.toMove で直すと白黒が逆になる）。
      setCurve((xs) => [...xs, { ply: h.length, black: toBlackWinrate(res.winrate, p.toMove) }]);

      const next = res.move === PASS ? pass(p) : tryPlay(p, res.move);
      // サーバーが非合法手を返したら盤面は動かさない（Phase 0 未完了の兆候）
      if (!next) { setError(`エンジンが非合法手を返しました: ${res.gtp}`); return; }
      setPos(next);
      setHistory([...h, res.move]);
      setPlies((ps) => [...ps, next]);
      if (res.move === PASS && h[h.length - 1] === PASS) endByPass();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      pushLog({ id, at, path: '/genmove', req, error: msg,
                elapsedMs: Math.round(performance.now() - t0) });
      setError(msg);
    } finally {
      setThinking(false);
      abort.current = null;
    }
    // buildReq は visits にのみ依存する
  }, [visits]);

  const endByPass = () => {
    setResult({ kind: 'pass', winner: null, text: '両者パスで終局' });
    setDead(new Set());
    setPhase('scoring');
  };

  const handlePlay = useCallback(async (idx: number) => {
    // 整地中は着手ではなく死石のトグル
    if (phase === 'scoring') {
      const g = groupAt(pos, idx);
      if (!g.size) return;
      setDead((d) => {
        const next = new Set(d);
        // 連の代表点が死石なら連ごと生き返らせる
        const wasDead = next.has(idx);
        for (const q of g) wasDead ? next.delete(q) : next.add(q);
        return next;
      });
      return;
    }
    if (thinking || !myTurn) return;
    const next = tryPlay(pos, idx);
    if (!next) { setError('そこには打てません'); return; }
    setSnapshots((s) => [...s, { pos, history }]);
    const h = [...history, idx];
    setPos(next); setHistory(h); setError(null);
    setPlies((ps) => [...ps, next]);
    await askEngine(next, h);
  }, [pos, history, thinking, myTurn, phase, askEngine]);

  const handlePass = async () => {
    if (thinking || !myTurn) return;
    setSnapshots((s) => [...s, { pos, history }]);
    const next = pass(pos);
    const h = [...history, PASS];
    setPos(next); setHistory(h);
    setPlies((ps) => [...ps, next]);
    // 直前もパスなら両者連続パス＝終局。エンジンには聞かない。
    if (history[history.length - 1] === PASS) { endByPass(); return; }
    await askEngine(next, h);
  };

  const handleResign = () => {
    if (!playing) return;
    abort.current?.abort();
    const winner: Color = humanColor === BLACK ? WHITE : BLACK;
    setResult({ kind: 'resign', winner,
                text: `${COLOR_LABEL[humanColor]}投了 — ${COLOR_LABEL[winner]}の勝ち` });
    setFinalScore(null);
    setCursor(plies.length - 1);
    setPhase('review');
  };

  /** 整地を確定して勝敗を決める。 */
  const handleConfirmScore = () => {
    const s = score(pos, KOMI, dead);
    setFinalScore(s);
    setResult({
      kind: 'pass',
      winner: s.winner,
      text: s.winner === null
        ? `持碁（${s.black} 対 ${s.white} + コミ ${s.komi}）`
        : `${COLOR_LABEL[s.winner]}の ${Math.abs(s.diff)} 目勝ち`,
    });
    setCursor(plies.length - 1);
    setPhase('review');
  };

  const handleUndo = () => {
    if (thinking) return;
    const s = snapshots[snapshots.length - 1];
    if (!s) return;
    setPos(s.pos); setHistory(s.history);
    setSnapshots((xs) => xs.slice(0, -1));
    setPlies((ps) => ps.slice(0, s.history.length + 1));
    // 終局後の待ったは終局を取り消す。グラフも戻した手数まで切り詰める。
    setPhase('playing'); setResult(null); setFinalScore(null); setDead(new Set());
    setAnalysis(null);
    setCurve((xs) => xs.filter((pt) => pt.ply <= s.history.length));
    setError(null);
  };

  /**
   * 対局を作り直す。盤サイズも手番も、途中で変えると局面の意味が変わるので
   * 一局まるごと捨てる。人間が白番なら、黒番のエンジンに初手を打たせる。
   */
  const startNewGame = useCallback((nextSize: Size, nextHuman: Color) => {
    abort.current?.abort();
    const fresh = createPosition(nextSize);
    setSize(nextSize); setHumanColor(nextHuman);
    setPos(fresh); setHistory([]); setSnapshots([]); setPlies([fresh]);
    setLast(null); setError(null); setCurve([]);
    setPhase('playing'); setResult(null); setFinalScore(null);
    setDead(new Set()); setAnalysis(null); setCursor(0); setKifu(null); setReview([]);
    if (nextHuman === WHITE) void askEngine(fresh, []);
  }, [askEngine]);

  /** 検討モードで、いま見ている局面をエンジンに聞く。 */
  const handleAnalyze = async () => {
    if (thinking) return;
    const p = plies[cursor]!;
    setThinking(true); setError(null);
    abort.current = new AbortController();
    // 検討では最善手を知りたいので温度0。候補は多めに見る。
    const req = buildReq(p, history.slice(0, cursor), { temperature: 0, top_k: 8 });
    const id = ++logSeq.current;
    const at = new Date();
    const t0 = performance.now();
    try {
      const res = await genmove(req, abort.current.signal);
      pushLog({ id, at, path: '/genmove', req, res,
                elapsedMs: Math.round(performance.now() - t0) });
      setAnalysis({ ply: cursor, res });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      pushLog({ id, at, path: '/genmove', req, error: msg,
                elapsedMs: Math.round(performance.now() - t0) });
      setError(msg);
    } finally {
      setThinking(false);
      abort.current = null;
    }
  };

  /** 囲碁クエストの棋譜を取り込んで検討モードに入る。 */
  const handleImport = async () => {
    if (importing || sweep) return;
    setImporting(true); setError(null);
    try {
      loadKifu(await importKifu(kifuUrl.trim()));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  };

  /** ローカルの棋譜 JSON を読む。llm_vs_katago.py の出力がそのまま入る。 */
  const handleImportFile = async (file: File) => {
    if (importing || sweep) return;
    setImporting(true); setError(null);
    try {
      const g = JSON.parse(await file.text()) as KifuGame;
      if (!g?.moves || !g?.size) throw new Error('棋譜の形式が違います');
      loadKifu(g);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  };

  /** 取り込んだ棋譜を盤に載せて検討モードに入る。URL 経由とファイル経由で共通。 */
  const loadKifu = (g: KifuGame) => {
    {
      // 局面列を作り直す。こちらのルールで再生できない手が来たらそこで止める。
      const ps: Position[] = [createPosition(g.size)];
      const hs: number[] = [];
      let broke: number | null = null;
      for (const m of g.moves) {
        const cur = ps[ps.length - 1]!;
        const nx = m.move === PASS ? pass(cur) : tryPlay(cur, m.move, m.color);
        if (!nx) { broke = hs.length + 1; break; }
        ps.push(nx); hs.push(m.move);
      }
      abort.current?.abort();
      setKifu(g);
      setSize(g.size as Size);
      setPlies(ps); setHistory(hs); setPos(ps[ps.length - 1]!);
      setSnapshots([]); setCurve([]); setAnalysis(null); setLast(null); setReview([]);
      setFinalScore(null); setDead(new Set());
      setResult(g.result
        ? { kind: 'imported', winner: g.result.winner, text: g.result.text }
        : null);
      setCursor(0);
      setPhase('review');
      if (broke !== null) {
        setError(`${broke} 手目を再生できませんでした。そこまでを読み込んでいます`);
      }
    }
  };

  /**
   * 全局面をまとめて評価して勝率の推移を作る。
   *
   * ここは visits=1 に固定する。欲しいのは value ヘッドの数字だけで探索は要らず、
   * 130手を探索つきで回すと分単位になるため。個別の局面は「この局面を解析」で深く見る。
   */
  const handleSweep = async () => {
    if (thinking || sweep) return;
    const ctrl = new AbortController();
    abort.current = ctrl;
    setSweep({ done: 0, total: plies.length });
    setCurve([]); setReview([]); setError(null);

    const acc: PlyReview[] = [];
    try {
      for (let i = 0; i < plies.length; i++) {
        if (ctrl.signal.aborted) break;
        const p = plies[i]!;
        // 候補も一緒に取る。探索しないので top_k を増やしても時間は変わらない。
        const req = buildReq(p, history.slice(0, i), { visits: 1, top_k: 6, temperature: 0 });
        const id = ++logSeq.current;
        const at = new Date();
        const t0 = performance.now();
        const res = await genmove(req, ctrl.signal);
        pushLog({ id, at, path: '/genmove', req, res,
                  elapsedMs: Math.round(performance.now() - t0) });

        const black = toBlackWinrate(res.winrate, p.toMove);
        const actual = i < history.length ? history[i]! : null;
        const cands = res.candidates ?? [];
        const rank = actual === null ? null
          : (cands.findIndex((c) => c.move === actual) + 1) || null;

        acc.push({ ply: i, black, toMove: p.toMove, candidates: cands,
                   actual, actualRank: rank, loss: null });
        // 1つ前の手の loss は、今の評価が出て初めて確定する
        const prev = acc[acc.length - 2];
        if (prev) {
          const before = prev.toMove === BLACK ? prev.black : 1 - prev.black;
          const after = prev.toMove === BLACK ? black : 1 - black;
          prev.loss = before - after;
        }
        setReview([...acc]);
        setCurve((xs) => [...xs, { ply: i, black }]);
        setSweep({ done: i + 1, total: plies.length });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!ctrl.signal.aborted) setError(msg);
    } finally {
      setSweep(null);
      abort.current = null;
    }
  };

  const seek = (to: number) => setCursor(Math.max(0, Math.min(plies.length - 1, to)));

  const enterReview = () => {
    if (!playing || thinking) return;
    abort.current?.abort();
    setCursor(plies.length - 1);
    setPhase('review');
  };
  const resumePlay = () => {
    // 検討から対局に戻れるのは、まだ終局していない場合だけ
    if (result) return;
    setAnalysis(null);
    setPhase('playing');
  };

  const cursorWinrate = curve.find((pt) => pt.ply === cursor)?.black;

  return (
    <div className={logOpen ? 'app with-log' : 'app'}>
      <header>
        <strong>igo-ai</strong>
        <span className="muted">
          {history.length} 手 / 手番 {COLOR_LABEL[pos.toMove]}
          {' '}（あなたは{COLOR_LABEL[humanColor]}番）
          {result && <> / <strong>{result.text}</strong></>}
          {' '}/ アゲハマ 黒{pos.prisoners[BLACK]} 白{pos.prisoners[2]}
        </span>
      </header>

      <div className="layout">
        <div className="board-col">
          <Board size={size} stones={shown.stones} lastMove={shownLastMove}
                 onPlay={handlePlay}
                 disabled={phase === 'review' || (phase === 'playing' && (thinking || !myTurn))}
                 dead={phase === 'scoring' ? dead : undefined}
                 territory={phase === 'scoring' ? liveScore!.owner : null}
                 candidates={overlayCandidates}
                 actualMove={phase === 'review' ? atCursor?.actual ?? undefined : undefined} />

          {phase === 'scoring' && (
            <div className="phasebar">
              <span>
                死んでいる石をクリックしてください。
                {' '}<strong>黒 {liveScore!.black}</strong> 対{' '}
                <strong>白 {liveScore!.white} + コミ {liveScore!.komi}</strong>
                {' '}→ {liveScore!.winner === null
                  ? '持碁'
                  : `${COLOR_LABEL[liveScore!.winner]} ${Math.abs(liveScore!.diff)} 目`}
              </span>
              <span className="phasebar-btns">
                <button onClick={() => setDead(new Set())} disabled={!dead.size}>
                  死石をクリア
                </button>
                <button onClick={handleConfirmScore}>この結果で確定</button>
              </span>
            </div>
          )}

          {phase === 'review' && (
            <div className="phasebar">
              <span className="review-seek">
                <button onClick={() => seek(0)} disabled={cursor === 0}>⏮</button>
                <button onClick={() => seek(cursor - 1)} disabled={cursor === 0}>◀</button>
                <input type="range" min={0} max={plies.length - 1} value={cursor}
                       onChange={(e) => seek(Number(e.target.value))} />
                <button onClick={() => seek(cursor + 1)}
                        disabled={cursor >= plies.length - 1}>▶</button>
                <button onClick={() => seek(plies.length - 1)}
                        disabled={cursor >= plies.length - 1}>⏭</button>
                {/* 幅が変わるとスライダーが伸縮して前後のボタンが動くので、
                    桁を揃えたうえで枠を固定する。勝率が無い手数でも欄は残す。 */}
                <span className="muted review-pos">
                  <span className="rp-ply">{cursor}/{plies.length - 1}</span>
                  <span className="rp-wr">
                    {cursorWinrate !== undefined
                      ? `黒 ${(cursorWinrate * 100).toFixed(1)}%`
                      : '黒 —'}
                  </span>
                </span>
              </span>
              <span className="phasebar-btns">
                {sweep
                  ? <button onClick={() => abort.current?.abort()}>
                      中止（{sweep.done}/{sweep.total}）
                    </button>
                  : <button className="btn-sweep" onClick={handleSweep} disabled={thinking}>
                      全手を解析
                    </button>}
                <label className="toggle" title="全手解析の候補を各局面で表示する">
                  <input type="checkbox" checked={showCandidates}
                         onChange={(e) => setShowCandidates(e.target.checked)} />
                  AI候補
                </label>
                <button className="btn-analyze" onClick={handleAnalyze}
                        disabled={thinking || !!sweep}>
                  {thinking ? '解析中…' : 'この局面を解析'}
                </button>
                {!result && !sweep && <button onClick={resumePlay}>対局に戻る</button>}
              </span>
            </div>
          )}
        </div>

        <aside>
          <div className="panel">
            <label htmlFor="kifu">囲碁クエストの棋譜を検討</label>
            <div className="import-row">
              <input id="kifu" type="text" value={kifuUrl} placeholder="棋譜の URL か対局 ID"
                     disabled={importing || !!sweep}
                     onChange={(e) => setKifuUrl(e.target.value)}
                     onKeyDown={(e) => { if (e.key === 'Enter') void handleImport(); }} />
              <button onClick={handleImport} disabled={importing || !!sweep || !kifuUrl.trim()}>
                {importing ? '取得中…' : '読み込む'}
              </button>
            </div>
            <label className="file-row muted">
              またはローカルの棋譜 JSON（llm_vs_katago.py の出力）
              <input type="file" accept="application/json,.json"
                     disabled={importing || !!sweep}
                     onChange={(e) => {
                       const f = e.target.files?.[0];
                       if (f) void handleImportFile(f);
                       e.target.value = '';   // 同じファイルを選び直せるように
                     }} />
            </label>
            {kifu && (
              <div className="kifu-meta muted">
                <div>
                  <strong>●{kifu.black.name ?? '黒'}</strong>
                  {kifu.black.rating != null && ` (${Math.round(kifu.black.rating)})`}
                  {' vs '}
                  <strong>○{kifu.white.name ?? '白'}</strong>
                  {kifu.white.rating != null && ` (${Math.round(kifu.white.rating)})`}
                </div>
                <div>
                  {kifu.size} 路 / {kifu.moves.length} 手
                  {kifu.result && ` / ${kifu.result.text}`}
                  {kifu.created && ` / ${kifu.created.slice(0, 10)}`}
                </div>
                {/* 先方の JSON にコミが無い。勝敗は先方の結果が正なので、
                    ここのコミは検討中の評価にだけ効く。 */}
                <div>コミ {KOMI}（棋譜に含まれないため既定値）</div>
              </div>
            )}
            {kifu && (
              <div className="viewpoint">
                <label htmlFor="mycolor">自分の視点</label>
                <select id="mycolor" value={myColor}
                        onChange={(e) => setMyColor(Number(e.target.value) as Color)}>
                  <option value={BLACK}>●{kifu.black.name ?? '黒'}（黒）</option>
                  <option value={WHITE}>○{kifu.white.name ?? '白'}（白）</option>
                </select>
              </div>
            )}
          </div>

          <div className="panel">
            <label>黒の勝率 {(blackWinrate * 100).toFixed(1)}%</label>
            <div className="wr"><div style={{ width: `${blackWinrate * 100}%` }} /></div>
            <WinrateChart points={curve}
                          cursorPly={phase === 'review' ? cursor : undefined}
                          onSeek={phase === 'review' ? seek : undefined} />
          </div>

          {finalScore && (
            <div className="panel result">
              <label>結果</label>
              <table>
                <tbody>
                  <tr><td>黒（地＋石）</td><td>{finalScore.black}</td></tr>
                  <tr><td>白（地＋石）</td><td>{finalScore.white}</td></tr>
                  <tr><td>コミ</td><td>+{finalScore.komi}</td></tr>
                  <tr className="sum">
                    <td>{result!.text}</td><td>{finalScore.diff > 0 ? '+' : ''}{finalScore.diff}</td>
                  </tr>
                </tbody>
              </table>
              <p className="muted">中国ルール（地＋石）。死活は手動指定。</p>
            </div>
          )}

          {phase === 'review' && atCursor && (
            <div className="panel">
              <label>
                {cursor} 手目の局面（{COLOR_LABEL[atCursor.toMove]}番）
                {atCursor.toMove === myColor && <span className="mine"> あなたの手番</span>}
              </label>
              {kifu?.moves[cursor] && (kifu.moves[cursor]!.by || kifu.moves[cursor]!.note) && (
                <p className="by-note">
                  {kifu.moves[cursor]!.by && <strong>{kifu.moves[cursor]!.by}: </strong>}
                  <span className="muted">{kifu.moves[cursor]!.note}</span>
                </p>
              )}
              {atCursor.actual !== null ? (
                <p className="actual">
                  実際: <strong>{atCursor.actual === PASS ? 'パス' : toGtp(size, atCursor.actual)}</strong>
                  {atCursor.actualRank
                    ? <span className="muted"> — AI候補の {atCursor.actualRank} 番目</span>
                    : <span className="muted"> — AI候補に入っていない</span>}
                  {atCursor.loss !== null && (
                    <span className={atCursor.loss > 0.05 ? 'err' : 'muted'}>
                      {' '}/ 勝率 {atCursor.loss >= 0 ? '−' : '+'}
                      {Math.abs(atCursor.loss * 100).toFixed(1)}pt
                    </span>
                  )}
                </p>
              ) : <p className="muted">最終局面</p>}
              <ol className="cand-list">
                {atCursor.candidates.map((c) => (
                  <li key={c.move} className={c.move === atCursor.actual ? 'played' : undefined}>
                    <span>
                      {c.move === PASS ? 'パス' : toGtp(size, c.move)}
                      {c.move === atCursor.actual && ' ←実戦'}
                    </span>
                    <span className="muted">
                      {c.visits !== undefined ? `${c.visits}v` : `${((c.prob ?? 0) * 100).toFixed(1)}%`}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          )}

          {phase === 'review' && myMistakes.length > 0 && (
            <div className="panel">
              <label>
                {COLOR_LABEL[myColor]}番の失点が大きかった手（上位 {myMistakes.length}）
              </label>
              <ol className="mistakes">
                {myMistakes.map((r) => (
                  <li key={r.ply} onClick={() => seek(r.ply)}
                      className={cursor === r.ply ? 'at' : undefined}>
                    <span>{r.ply + 1} 手目</span>
                    <span>{r.actual === PASS ? 'パス' : toGtp(size, r.actual!)}</span>
                    <span className="muted">
                      {r.candidates[0] && `AI: ${r.candidates[0].move === PASS
                        ? 'パス' : toGtp(size, r.candidates[0].move)}`}
                    </span>
                    <span className="err">−{((r.loss ?? 0) * 100).toFixed(1)}pt</span>
                  </li>
                ))}
              </ol>
              <p className="muted">
                クリックでその局面へ。評価値の絶対値はずれているので、下落幅を目安に見る。
              </p>
            </div>
          )}

          {phase === 'review' && analysis?.ply === cursor && (
            <div className="panel">
              <label>この局面の候補手（{COLOR_LABEL[plies[cursor]!.toMove]}番）</label>
              <ol className="cand-list">
                {(analysis.res.candidates ?? []).map((c) => (
                  <li key={c.move}>
                    <span>{c.move === PASS ? 'パス' : c.gtp}</span>
                    <span className="muted">
                      {c.visits !== undefined ? `${c.visits}v` : `${((c.prob ?? 0) * 100).toFixed(1)}%`}
                      {c.winrate != null && ` / ${(c.winrate * 100).toFixed(0)}%`}
                    </span>
                  </li>
                ))}
              </ol>
              <p className="muted">
                エンジンの推奨: <strong>{analysis.res.gtp}</strong> /
                {' '}勝率(手番) {(analysis.res.winrate * 100).toFixed(1)}%
              </p>
            </div>
          )}

          <div className="panel">
            <label htmlFor="size">盤サイズ</label>
            <select id="size" value={size} disabled={thinking}
                    onChange={(e) => handleSizeChange(Number(e.target.value) as Size)}>
              {SIZES.map((s) => <option key={s} value={s}>{s} 路</option>)}
            </select>
          </div>

          <div className="panel">
            <label htmlFor="color">あなたの手番</label>
            <select id="color" value={humanColor} disabled={thinking}
                    onChange={(e) => handleColorChange(Number(e.target.value) as Color)}>
              <option value={BLACK}>黒番（先手）</option>
              <option value={WHITE}>白番（後手）</option>
            </select>
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
            <button onClick={handlePass} disabled={thinking || !myTurn}>パス</button>
            <button onClick={handleResign} disabled={!playing}>投了</button>
            <button onClick={enterReview} disabled={!playing || thinking}>検討</button>
            <button onClick={handleUndo} disabled={thinking || !snapshots.length}>待った</button>
            <button onClick={handleReset}>初期化</button>
            {thinking && <button onClick={() => abort.current?.abort()}>中断</button>}
          </div>

          <div className="panel status">
            {phase === 'scoring' && (
              <span className="over">死活を確認してください</span>
            )}
            {sweep && (
              <span>
                全手を解析中 {sweep.done}/{sweep.total}
                （visits=1 固定。探索なしの評価値）
              </span>
            )}
            {phase === 'review' && !sweep && result && <span className="over">{result.text}</span>}
            {phase === 'review' && !sweep && !result &&
              <span className="muted">検討モード</span>}
            {playing && thinking && <span>AI 思考中…</span>}
            {error && <span className="err">{error}</span>}
            {playing && !thinking && !error && last && (
              <span>
                AI: {last.gtp} / {last.visits} visits /
                推論 {last.nn_calls} 回 / {last.inference_ms} ms
              </span>
            )}
            {playing && !thinking && !error && !last &&
              <span className="muted">あなたは{COLOR_LABEL[humanColor]}番です。</span>}
          </div>

          <div className="panel kifu">
            <label>棋譜</label>
            <ol>
              {history.map((m, i) => (
                <li key={i}
                    className={phase === 'review' && cursor === i + 1 ? 'at' : undefined}
                    onClick={() => phase === 'review' && seek(i + 1)}>
                  {m === PASS ? 'パス' : toGtp(size, m)}
                </li>
              ))}
            </ol>
          </div>
        </aside>
      </div>

      <ApiLog entries={log} open={logOpen} apiBase={API_BASE}
              onToggle={() => setLogOpen((v) => !v)} onClear={() => setLog([])} />
    </div>
  );

  function handleReset() { startNewGame(size, humanColor); }
  function handleSizeChange(next: Size) { if (!thinking) startNewGame(next, humanColor); }
  function handleColorChange(next: Color) { if (!thinking) startNewGame(size, next); }
}
