/**
 * Provider 适配层接口（对应架构设计 v1.2 · B4.1）
 *
 * 适配层存在的唯一理由：把「换供应商」的成本压到只改一个 adapter。
 * 因此接口必须统一四件事 —— `submit` / `poll` / `cancel` / `normalize`，
 * 且**平台内部只认下面这套类型，不认任何厂商的字段名**。
 *
 * 设计约束（评审时请重点看这三条）：
 *   1. `PollResult.raw` 保留厂商原始返回 —— 出错时没有原始报文，排查只能靠猜
 *   2. `normalize` 的产物是 `PlatformFailure`，含**是否计费**的判定依据
 *   3. 适配器不得自己决定积分与配额，那是账本层的职责（B4.3）
 */

export type Capability = 'txt2img' | 'img2video' | 'txt2video' | 'audio';

/** 平台错误码：与 `contracts/openapi.yaml` 的错误码总表一一对应 */
export type PlatformErrorCode =
  | 'CONTENT_BLOCKED_BY_PROVIDER'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_ERROR'
  | 'PROVIDER_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'INVALID_ARGUMENT';

export interface SubmitInput {
  capability: Capability;
  /** 模型标识（对应 Model Registry 的 modelKey） */
  modelKey: string;
  prompt: string;
  negativePrompt?: string;
  /** 随机种子。一键同款可还原的关键，绝不可省略 */
  seed: number;
  durationSeconds?: number;
  aspect?: string;
  /** 参考素材的**已签名 URL**（不是 assetId —— 适配层不认识平台内部 ID） */
  referenceUrls?: string[];
}

export interface SubmitResult {
  providerJobId: string;
  acceptedAt: string;
}

export type ProviderJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'blocked';

export interface Artifact {
  url: string;
  width?: number;
  height?: number;
  durationMs?: number;
}

export interface PollResult {
  status: ProviderJobStatus;
  /** 0–100 */
  progress: number;
  artifacts?: Artifact[];
  failure?: PlatformFailure;
  /** 厂商原始返回，排查用；不要直接透传给前端 */
  raw?: unknown;
}

export interface PlatformFailure {
  /** 归一后的平台错误码 */
  code: PlatformErrorCode;
  /** 厂商原始错误码，用于对账与工单 */
  providerCode: string;
  message: string;
  /**
   * 该失败是否应当计费。
   * 平台口径（B4.3 / DR-003）：只有「成功」才计费；
   * 审核拦截、超时、厂商异常、限流一律不计费。
   * 放在这里而不是散在业务代码里，是为了让这条口径**只有一个判定点**。
   */
  billable: boolean;
  /** 是否值得自动重试（限流与不可用值得，内容拦截不值得） */
  retryable: boolean;
  /**
   * 厂商是否已向我方计费。
   * 与 `billable` 是两件事，不可合并：
   *   厂商已扣我方成本 ≠ 用户该为此付费。前者进 `job.cost_provider` 用于毛利核算，
   *   后者决定 `job.settled`。把两者混为一谈会让毛利看板失真。
   */
  providerCharged: boolean;
  /** 厂商原始返回，排查时唯一可靠的依据；不透传给前端 */
  raw?: unknown;
}

export interface ProviderAdapter {
  readonly id: string;
  readonly displayName: string;
  /** 该适配器是否必须配置 Key 才能工作（stub 为 false） */
  readonly requiresKey: boolean;
  /** 配置是否完整；false 时所有网络方法应快速失败并给出可执行的指引 */
  readonly configured: boolean;
  capabilities(): Capability[];

  submit(input: SubmitInput, signal?: AbortSignal): Promise<SubmitResult>;
  poll(providerJobId: string, signal?: AbortSignal): Promise<PollResult>;
  cancel(providerJobId: string, signal?: AbortSignal): Promise<{ cancelled: boolean }>;

  /** 把厂商错误归一为平台错误；输入可以是原始报文、错误码或异常 */
  normalize(input: unknown): PlatformFailure;
}

/** 未配置 Key 时抛这个，让上层能把它与「真实调用失败」区分开 */
export class ProviderNotConfiguredError extends Error {
  readonly missing: readonly string[];

  constructor(missing: readonly string[], hint: string) {
    super(`Provider 未配置完整，缺失：${missing.join(', ')}。${hint}`);
    this.name = 'ProviderNotConfiguredError';
    this.missing = missing;
  }
}

/** 通过 HTTP 时可复用的默认超时包装 */
export async function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  onTimeout: () => PlatformFailure,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } catch (err) {
    if (controller.signal.aborted) {
      throw Object.assign(new Error(onTimeout().message), { platformFailure: onTimeout() });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
