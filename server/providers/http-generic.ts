/**
 * 通用 HTTP Provider 适配器 —— 「填 Key 即可用」的那一层
 *
 * 设计目标：把「接一家新 Provider」的成本压到**只填环境变量**，不改代码。
 * 需要提供的 4 个必填项与 3 个可选项都写在 `.env.provider.example` 里。
 *
 * ⚠️ 安全：`apiKey` 只在本进程内存中使用，用于拼接 Authorization 头。
 *    任何日志、错误信息、接口响应一律走 `maskKey()`，绝不出现明文。
 *
 * ⚠️ 接口形态假设：本适配器按「提交返回 jobId、轮询取状态」的**最常见形态**实现。
 *    真实 Provider 定下来后，若形态不同（例如回调式），只需在本文件内调整，
 *    接口契约（types.ts）与上层业务代码不受影响 —— 这正是适配层存在的意义。
 */

import type {
  Artifact,
  Capability,
  PlatformFailure,
  PollResult,
  ProviderAdapter,
  ProviderJobStatus,
  SubmitInput,
  SubmitResult,
} from './types';
import { ProviderNotConfiguredError } from './types';
import { normalizeError } from './errors';
import { maskKey, type ProviderConfig } from '../config';

/** 厂商状态字符串 → 平台状态。命不中就归到 running（保守，避免误判成功） */
const STATUS_MAP: Array<[RegExp, ProviderJobStatus]> = [
  [/^(queued|pending|created|waiting|in_queue)$/i, 'queued'],
  [/^(running|processing|in_progress|generating)$/i, 'running'],
  [/^(succeeded|success|done|completed|finished)$/i, 'succeeded'],
  [/^(blocked|rejected|censored|moderated)$/i, 'blocked'],
  [/^(failed|error|canceled|cancelled|timeout)$/i, 'failed'],
];

function mapStatus(raw: string): ProviderJobStatus {
  for (const [re, status] of STATUS_MAP) if (re.test(raw)) return status;
  return 'running';
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** 按点路径取值，如 `data.0.url`；取不到返回 undefined */
function pickPath(source: unknown, path: string): unknown {
  let cur: unknown = source;
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(seg);
      cur = Number.isInteger(idx) ? cur[idx] : undefined;
    } else if (isRecord(cur)) {
      cur = cur[seg];
    } else {
      return undefined;
    }
  }
  return cur;
}

export class GenericHttpProvider implements ProviderAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly requiresKey = true;

  constructor(private readonly cfg: ProviderConfig) {
    this.id = cfg.id;
    this.displayName = cfg.displayName;
  }

  get configured(): boolean {
    return Boolean(this.cfg.baseUrl && this.cfg.apiKey);
  }

  capabilities(): Capability[] {
    return ['txt2img', 'img2video'];
  }

  /** 未配置时给出**可执行**的指引，而不是一句「缺少配置」 */
  private assertConfigured(): void {
    if (this.configured) return;
    const missing: string[] = [];
    if (!this.cfg.baseUrl) missing.push('PROVIDER_BASE_URL');
    if (!this.cfg.apiKey) missing.push('PROVIDER_API_KEY');
    throw new ProviderNotConfiguredError(
      missing,
      '请在 app/.env.provider 中填写（该文件已被 .gitignore 忽略，不会入库），' +
        '然后运行 `npm run provider:check` 自检。Key 只存在于 BFF 进程，绝不能加 VITE_ 前缀。',
    );
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${this.cfg.apiKey}`,
    };
  }

  private url(pathTemplate: string, id?: string): string {
    const path = id ? pathTemplate.replace('{id}', encodeURIComponent(id)) : pathTemplate;
    return `${this.cfg.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  }

  private failureFromResponse(status: number, body: unknown): PlatformFailure {
    return normalizeError(body, {
      errorMap: this.cfg.errorMap,
      context: `http ${status}`,
    });
  }

  async submit(input: SubmitInput, signal?: AbortSignal): Promise<SubmitResult> {
    this.assertConfigured();

    const res = await fetch(this.url(this.cfg.submitPath), {
      method: 'POST',
      headers: this.headers(),
      signal,
      body: JSON.stringify({
        model: input.modelKey,
        prompt: input.prompt,
        negative_prompt: input.negativePrompt,
        seed: input.seed,
        duration: input.durationSeconds,
        aspect_ratio: input.aspect,
        reference_urls: input.referenceUrls,
      }),
    });

    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* 保留原始文本 */
    }

    if (!res.ok) {
      const failure = this.failureFromResponse(res.status, body);
      throw Object.assign(new Error(failure.message), { platformFailure: failure });
    }

    const jobId =
      (pickPath(body, 'id') as string) ??
      (pickPath(body, 'data.id') as string) ??
      (pickPath(body, 'job_id') as string) ??
      (pickPath(body, 'data.job_id') as string);

    if (!jobId) {
      // 拿不到 jobId 就无法轮询，必须显式失败而不是返回一个假的 id
      throw Object.assign(new Error('厂商提交成功但未返回任务 ID，无法轮询'), {
        platformFailure: normalizeError({ code: 'malformed_response', message: '缺少任务 ID' }, {
          errorMap: this.cfg.errorMap,
        }),
      });
    }

    return { providerJobId: String(jobId), acceptedAt: new Date().toISOString() };
  }

  async poll(providerJobId: string, signal?: AbortSignal): Promise<PollResult> {
    this.assertConfigured();

    const res = await fetch(this.url(this.cfg.pollPath, providerJobId), {
      method: 'GET',
      headers: this.headers(),
      signal,
    });

    const text = await res.text();
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* 保留原始文本 */
    }

    if (!res.ok) {
      return {
        status: 'failed',
        progress: 0,
        failure: this.failureFromResponse(res.status, body),
        raw: body,
      };
    }

    const rawStatus =
      (pickPath(body, 'status') as string) ??
      (pickPath(body, 'data.status') as string) ??
      (pickPath(body, 'state') as string) ??
      '';
    const status = mapStatus(String(rawStatus));

    const progressRaw =
      pickPath(body, 'progress') ?? pickPath(body, 'data.progress') ?? (status === 'succeeded' ? 100 : 0);
    const progress = Math.max(0, Math.min(100, Math.round(Number(progressRaw) || 0)));

    if (status === 'failed' || status === 'blocked') {
      const reason =
        pickPath(body, 'error') ?? pickPath(body, 'data.error') ?? pickPath(body, 'message') ?? body;
      return {
        status,
        progress: progress || 0,
        failure: normalizeError(reason, { errorMap: this.cfg.errorMap, context: String(rawStatus) }),
        raw: body,
      };
    }

    if (status === 'succeeded') {
      const urls = [
        pickPath(body, 'artifacts'),
        pickPath(body, 'data.artifacts'),
        pickPath(body, 'output'),
        pickPath(body, 'data.output'),
        pickPath(body, 'url'),
        pickPath(body, 'data.url'),
      ].find((v) => v !== undefined);

      const list: unknown[] = Array.isArray(urls) ? urls : urls ? [urls] : [];
      const artifacts: Artifact[] = list
        .map((item) => (typeof item === 'string' ? { url: item } : (item as Artifact)))
        .filter((a) => a && typeof a.url === 'string' && a.url.length > 0);

      if (artifacts.length === 0) {
        // 「成功但没有产物」是必须显式失败的状态：静默通过会让用户拿到一个空结果
        return {
          status: 'failed',
          progress: 100,
          failure: normalizeError({ code: 'malformed_response', message: '任务成功但未返回产物地址' }, {
            errorMap: this.cfg.errorMap,
          }),
          raw: body,
        };
      }

      return { status, progress: 100, artifacts, raw: body };
    }

    return { status, progress, raw: body };
  }

  async cancel(providerJobId: string, signal?: AbortSignal): Promise<{ cancelled: boolean }> {
    this.assertConfigured();
    const res = await fetch(this.url(this.cfg.cancelPath, providerJobId), {
      method: 'POST',
      headers: this.headers(),
      signal,
    });
    // 厂商不支持取消是可接受的（契约里已写明），此时如实返回 false 而不是抛错
    return { cancelled: res.ok };
  }

  normalize(input: unknown): PlatformFailure {
    return normalizeError(input, { errorMap: this.cfg.errorMap });
  }

  /** 供 /v1/provider/status 展示，**不含明文 Key** */
  describe(): Record<string, string> {
    return {
      adapter: 'generic-http',
      id: this.cfg.id,
      baseUrl: this.cfg.baseUrl || '(未配置)',
      apiKey: maskKey(this.cfg.apiKey),
    };
  }
}
