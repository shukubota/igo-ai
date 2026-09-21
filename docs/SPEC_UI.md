# UI 実装仕様書 — igo-ai/web

囲碁の対局・検討 UI。`engine/` の HTTP API を叩く SPA。

- **スタック**: Vite + React + TypeScript（`strict: true`）
- **状態管理ライブラリなし**。`useReducer` で足りる規模。増やす前に相談
- **既存コード**: `web/` に動くスケルトンあり（盤が描画され、着手できる）
- **エンジン側の仕様**: `docs/SPEC_ENGINE.md`

---

## 1. 設計の前提

### エンジンはステートレス

サーバーは対局状態を持たない。**盤面を毎リクエストで丸ごと送る。**
つまり対局の正はクライアント側にある。

この帰結として UI 側の責務が重い:

- 着手の合法性判定（サーバー往復を待たずに石を置くため）
- 取りの処理、コウの管理
- 着手履歴と待った
- 棋譜の保持

`web/src/goban/rules.ts` がそれを担う。**`engine/goban.py` と同じロジックの
TypeScript 版**で、食い違ったらサーバー側（Python）が正。

> 二重実装は本来避けたいが、サーバー往復（CPU で 0.3〜3 秒）を待って
> 自分の石が現れるのは体験として成立しない。意図的な重複。

### 座標は一次元 index

`0 .. size*size-1`。19路なら `0..360`。`-1` がパス。
`engine` と `web` で同じ規約。左上が 0、行優先。

```ts
const idx = row * size + col;
const [row, col] = [Math.floor(idx / size), idx % size];
```

GTP 表記（`D16` など）は表示専用。内部では使わない。

### 型はサーバーと手で同期

`web/src/types.ts` が `engine/main.py` の Pydantic モデルに対応する。
コード生成は入れていない（この規模では過剰）。
**片方だけ直さないこと。** API を変えたら両方直す。

---

## 2. 画面構成

単一画面。3領域。

```
┌─────────────────────────────────────────────┐
│  ヘッダー: 手番 / 手数 / アゲハマ            │
├──────────────────────┬──────────────────────┤
│                      │  勝率バー             │
│                      │  ─────────────       │
│      碁盤            │                      │
│     (canvas)         │  操作                │
│                      │   パス / 待った /     │
│                      │   投了 / 初期化       │
│                      │                      │
│                      │  設定                │
│                      │   強さ (visits)      │
│                      │   ばらけ (temp)      │
│                      │   候補手を表示 ☐     │
│                      │   形勢を表示 ☐       │
│                      │                      │
│                      │  棋譜                │
│                      │   1. D16             │
│                      │   2. Q4              │
│                      │   ...                │
└──────────────────────┴──────────────────────┘
```

**スマホ幅（〜700px）では縦積み。** 盤を上、操作を下。棋譜は折りたたむ。

### 碁盤の描画

`<canvas>` に命令的に描く。React で 361 個の DOM を管理するのは無駄。

- 盤面サイズは親要素から取り、`devicePixelRatio` を掛けて描く（Retina 対応）
- 石は放射グラデーションで立体感を出す。黒 `#0a0a0a`→`#5a5a5a`、白 `#c8c5bd`→`#fff`
- **直前の手にマーカー**を打つ（石の色と反対色の丸）
- 星（3-3, 3-9, 3-15 …）を打つ
- 盤の色 `#dcb35c` 系。ダークモードでは少し落とす

`Board.tsx` の責務は「盤面配列を受けて描く」＋「クリック座標を index に変換して
`onPlay(idx)` を呼ぶ」だけ。ルール判定は持たない。

---

## 3. 状態設計

```ts
type GameState = {
  size: number;              // 19
  stones: Int8Array;         // 0=空 1=黒 2=白、長さ size*size
  toMove: Color;             // 1 | 2
  ko: number;                // 単純コウの禁止点。-1 = なし
  history: Move[];           // 着手履歴（-1 = パス）
  prisoners: { 1: number; 2: number };
  positionHashes: string[];  // 超コウ判定用
  status: 'playing' | 'finished';
};

type UiState = {
  thinking: boolean;
  lastResponse: GenmoveResponse | null;
  settings: { visits: number; temperature: number;
              showCandidates: boolean; showOwnership: boolean };
  error: string | null;
};
```

`GameState` は `useReducer`。アクションは `play` / `pass` / `undo` / `reset` / `load`。

**待ったは2手戻す**（自分の手 + AI の手）。
スナップショットを積む方式でよい。履歴から再生するより単純。

`stones` を `Int8Array` にしているのは、毎手 JSON に載せる際に
`Array.from()` で素直に変換できるから。React の再レンダリングは
配列参照の差し替えで起こす（`Int8Array` を新規生成して渡す）。

---

## 4. API クライアント

`web/src/api/client.ts`。`fetch` のラッパー。ライブラリ不要。

```ts
const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8080';

export async function genmove(req: GenmoveRequest): Promise<GenmoveResponse>
export async function analyze(req: GenmoveRequest): Promise<AnalyzeResponse>
export async function health(): Promise<HealthResponse>
```

### 必須の考慮

| 事項 | 対応 |
|---|---|
| **コールドスタート** | Cloud Run の初回は5秒以上かかる。タイムアウトは 60 秒に取る |
| **思考時間が長い** | `visits=30` で 3 秒前後。`AbortController` で中断できるようにする |
| **連投の防止** | `thinking` 中はクリックを無視する。楽観的 UI にはしない |
| **エラー表示** | 失敗したら盤面を戻さず、エラーだけ出す。石が消えると混乱する |
| **API URL の設定** | `.env.local` の `VITE_API_BASE`。UI からも変えられると便利 |

`localStorage` に設定を保存してよいが、**try/catch で囲む**。
プライベートウィンドウでは throw する。

---

## 5. 実装フェーズ

### Phase U0 — スケルトンの確認

スケルトンは `npm install && npm run dev` で盤が出て、クリックで石が置ける
状態にしてある。まずこれが動くことを確認する。

エンジンが起動していれば AI も応答する。していなければエラー表示になる。

### Phase U1 — ルール実装の完成

`web/src/goban/rules.ts` に以下を実装する。`engine/goban.py` の移植でよい。

- [x] 連と呼吸点（flood fill）
- [x] 取り、自殺手の禁止
- [x] 単純コウ
- [ ] **超コウ** — 盤面ハッシュ履歴で同一局面反復を検出
- [ ] **終局判定** — 両者連続パス
- [ ] **地の計算**（中国ルール）— 終局時のスコア表示

**テスト**（`web/src/goban/rules.test.ts`、Vitest）:
`engine/tests/test_goban.py` と**同じテストケース**を書く。
両者の実装が食い違ったらすぐ分かるようにする。

### Phase U2 — 対局体験の仕上げ

| 項目 | 内容 |
|---|---|
| 思考中の表示 | `visits=30` で 3 秒。スピナーだけでなく経過秒数も出す |
| 中断 | 思考中に「中断」を出す。`AbortController` |
| 勝率バー | `winrate` を黒視点に正規化してから描く（レスポンスは手番視点） |
| 着手音 | 石を置く音。あると体験が変わる。`AudioContext` で合成でもよい |
| 待った | 2手戻す。連続で押せる |
| 投了 | AI の `winrate` が閾値を割ったら AI から投了してもよい |

**勝率の視点に注意。** レスポンスの `winrate` は**手番側の勝率**。
黒視点のバーに描くには、白の手番なら `1 - winrate` にする。
ここは間違えやすいので、変換関数を1つ作ってそこだけ通す。

### Phase U3 — 検討機能

| 項目 | 内容 |
|---|---|
| 候補手の表示 | `top_k` を投げて `candidates` を受け、盤上に訪問数を重ねる |
| 形勢の表示 | `/analyze` の `ownership`（長さ `size²`、-1〜1）を盤に薄く塗る |
| 勝率の推移グラフ | 各手の `winrate` を折れ線に。SVG を手書きでよい（ライブラリ不要） |
| 手を戻して検討 | 棋譜の任意の手をクリックしてその局面に飛ぶ |

`ownership` は黒が正、白が負（要確認）。**符号の向きは実測で確かめる。**
序盤の空盤に近い局面では全体が 0 付近になるはず。

### Phase U4 — 棋譜

| 項目 | 内容 |
|---|---|
| SGF 書き出し | 標準形式。他のソフトで開けることを確認する |
| SGF 読み込み | `~/kgs-sgf` に実戦の棋譜があるならテストに使える |
| 検討モード | 読み込んだ棋譜を1手ずつ送り、各局面で `/analyze` |

**SGF の座標は `aa`〜`ss` の2文字**（19路）。一次元 index との変換関数を作る。
SGF は左上原点で、内部表現と同じ向き。

---

## 6. 受け入れ条件

- [ ] `npm run dev` で盤が出て、クリックで着手でき、AI が応答する
- [ ] `rules.test.ts` と `engine/tests/test_goban.py` が同じケースで両方通る
- [ ] 19路を1局、終局まで完走できる（両者パス → スコア表示）
- [ ] 待ったを連続で押しても壊れない
- [ ] エンジンを落とした状態でもクラッシュせず、エラーが表示される
- [ ] 思考中にクリックしても着手が二重に入らない
- [ ] スマホ幅（375px）で横スクロールが出ない
- [ ] ダークモードで盤・石・文字がすべて読める
- [ ] `npm run build` が型エラーなしで通る

---

## 7. やらないこと

- **オンライン対局・マルチプレイヤー**。対人は範囲外
- **ユーザー認証・棋譜のサーバー保存**。ローカル完結
- **UI コンポーネントライブラリ**。この規模では素の CSS で足りる
- **状態管理ライブラリ**（Redux / Zustand 等）。`useReducer` で足りる
- **9路・13路**。`size` は受けるが検証は19路のみ
- **クライアント側推論**（onnxruntime-web）。
  fp16 で147MB をブラウザに落とすのは非現実的。サーバー経由で行く

---

## 8. 参照

- エンジン側の仕様: `docs/SPEC_ENGINE.md`
- プロジェクト指示: `AGENTS.md`
- SGF 仕様: https://www.red-bean.com/sgf/
