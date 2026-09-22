import type {
  GenmoveRequest, GenmoveResponse, AnalyzeResponse, HealthResponse, KifuGame,
} from '../types';

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined)
  ?? 'http://localhost:8080';

/** Cloud Run のコールドスタートは5秒以上かかる。短いタイムアウトは禁物。 */
const DEFAULT_TIMEOUT_MS = 60_000;

export class ApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ApiError';
  }
}

async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
  // 呼び出し側の中断（AbortController）と内部タイムアウトの両方を効かせる
  signal?.addEventListener('abort', () => ctrl.abort(), { once: true });
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new ApiError(await res.text().catch(() => res.statusText), res.status);
    }
    return (await res.json()) as T;
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (e instanceof DOMException && e.name === 'AbortError') {
      throw new ApiError('中断されました');
    }
    throw new ApiError(
      `エンジンに接続できません（${API_BASE}）。起動しているか確認してください。`,
    );
  } finally {
    clearTimeout(timer);
  }
}

export const genmove = (req: GenmoveRequest, signal?: AbortSignal) =>
  post<GenmoveResponse>('/genmove', req, signal);

export const analyze = (req: GenmoveRequest, signal?: AbortSignal) =>
  post<AnalyzeResponse>('/analyze', req, signal);

/**
 * 外部サービスの棋譜を取り込む。
 * 先方が CORS を許可していないのでブラウザからは直接取れず、エンジンが中継する。
 */
export const importKifu = (url: string, signal?: AbortSignal) =>
  post<KifuGame>('/kifu', { url }, signal);

export async function health(): Promise<HealthResponse> {
  const res = await fetch(`${API_BASE}/health`);
  if (!res.ok) throw new ApiError(res.statusText, res.status);
  return (await res.json()) as HealthResponse;
}

export { API_BASE };
