import type { Problem } from '@/shared/types/api';

/**
 * HTTP 客户端（对应接口契约 `contracts/openapi.yaml`）
 *
 * 只做四件事：拼基址、注入凭证、注入幂等键、把 Problem 结构转成可判别的错误类型。
 * 不做重试（写操作不自动重试，避免重复生成与重复扣费）。
 */

/**
 * 导出是刻意的：界面在请求失败时需要能告诉用户「该配哪个变量」。
 * 若把基址藏在本模块内，页面只能显示「请求失败」——
 * 而「忘了配 VITE_API_BASE_URL」恰恰是本地联调最高频的原因。
 */
export const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly problem: Problem;

  constructor(status: number, problem: Problem) {
    super(problem.detail ?? problem.title);
    this.name = 'ApiError';
    this.status = status;
    this.code = problem.code;
    this.problem = problem;
  }
}

/** 契约里的错误码 → 客户端应有的应对（见契约 info 描述中的错误码总表） */
export type ErrorStrategy =
  | 'guide-login' // 401
  | 'guide-topup' // 402 余额不足，保留表单
  | 'detach-reference' // 409 资产被引用
  | 'show-diff-notice' // 422 审核拦截
  | 'countdown-retry' // 429
  | 'retryable' // 502 / 503 / 504
  | 'unknown';

export function strategyOf(error: unknown): ErrorStrategy {
  if (!(error instanceof ApiError)) return 'unknown';
  switch (error.code) {
    case 'UNAUTHENTICATED':
      return 'guide-login';
    case 'INSUFFICIENT_CREDIT':
      return 'guide-topup';
    case 'ASSET_REFERENCED':
      return 'detach-reference';
    case 'CONTENT_BLOCKED_BY_PROVIDER':
      return 'show-diff-notice';
    case 'RATE_LIMITED':
      return 'countdown-retry';
    case 'PROVIDER_ERROR':
    case 'PROVIDER_UNAVAILABLE':
    case 'PROVIDER_TIMEOUT':
      return 'retryable';
    default:
      return 'unknown';
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** 写操作的幂等键；来自 createIdempotencySlot()，重试时必须复用同一个值 */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, idempotencyKey, signal } = options;

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  const token = readToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
    credentials: 'include',
  });

  if (response.status === 204) return undefined as T;

  const isJson = response.headers.get('Content-Type')?.includes('application/json') ?? false;
  const payload: unknown = isJson ? await response.json() : await response.text();

  if (!response.ok) {
    const problem: Problem =
      isJson && payload && typeof payload === 'object' && 'code' in payload
        ? (payload as Problem)
        : {
            title: response.statusText || 'Request failed',
            status: response.status,
            code: 'UNKNOWN',
            detail: typeof payload === 'string' ? payload : undefined,
          };
    throw new ApiError(response.status, problem);
  }

  return payload as T;
}

/**
 * Token 读取留空实现：P0 的鉴权方案未定（Cookie 会话 vs Bearer 双轨）。
 * 两者都支持是有意的 —— BFF 尚未冻结，前端不提前绑定。
 */
function readToken(): string | null {
  return null;
}
