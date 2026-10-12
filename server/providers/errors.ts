/**
 * 错误归一（适配层四件事里最容易出错、也最该被测试锁住的一件）
 *
 * 为什么单独成文件：各家的错误码形态千差万别（有的给 `code`、有的给 `error_code`、
 * 有的只有一句中文 message），而平台的积分与重试策略**完全依赖归一结果**。
 * 一旦这段逻辑散落在各 adapter 里，就会出现「同一类失败在 A 家返还积分、在 B 家不返还」。
 *
 * 纯函数、无副作用、不发网络请求 —— 所以它可以被完整单测覆盖（见 tests/provider-errors.test.ts）。
 */

import type { PlatformErrorCode, PlatformFailure } from './types';

export interface NormalizeRule {
  match: RegExp;
  code: PlatformErrorCode;
}

/**
 * 内置兜底规则：按**优先级从上到下**匹配第一个命中的。
 * 顺序有讲究 —— 例如「内容违规」必须排在「参数非法」之前，
 * 否则厂商用 400 返回内容拦截时会被误判为 INVALID_ARGUMENT，
 * 进而让用户看到「参数错误」这种与事实不符的提示。
 */
export const DEFAULT_RULES: readonly NormalizeRule[] = [
  {
    match:
      /content|policy|safety|moderation|nsfw|violat|forbidden_content|敏感|违规|审核|涉黄|涉政|不适宜|风险/i,
    code: 'CONTENT_BLOCKED_BY_PROVIDER',
  },
  // ⚠️ 下面三处的分隔符写成 `[\s_-]?` 而不是 `\s?` —— 这是写 stub 模拟器时发现的真实缺陷：
  //    各家的错误码普遍用**下划线**（`too_many_requests` / `bad_request` / `timed_out`），
  //    而 `\s?` 只允许「零个或一个空白」，匹配不到下划线。
  //    后果很具体：`too_many_requests` 会一路掉到兜底的 PROVIDER_ERROR，
  //    而 PROVIDER_ERROR 是**不可重试**的 —— 于是一次本可自动重试的限流，
  //    变成给用户报「未知错误」且不再重试。
  { match: /timeout|timed?[\s_-]?out|deadline|etimedout|504|超时/i, code: 'PROVIDER_TIMEOUT' },
  { match: /rate|throttl|too[\s_-]?many|quota|concurren|exhaust|429|限流|频率|配额/i, code: 'RATE_LIMITED' },
  {
    match: /unavailable|overload|capacity|maintenance|busy|502|503|不可用|繁忙|维护|过载/i,
    code: 'PROVIDER_UNAVAILABLE',
  },
  {
    match: /invalid|bad[\s_-]?request|param|unsupported|malformed|400|422|参数|非法|不支持/i,
    code: 'INVALID_ARGUMENT',
  },
];

/**
 * 可重试性：只有「等一会儿大概率能好」的失败才允许自动重试。
 *
 * `PROVIDER_ERROR` 刻意标记为**不可重试** —— 未知错误自动重试可能造成重复生成与重复消耗，
 * 而我们无法判断它是否已经在厂商侧真正执行了。宁可让用户手动重试。
 */
const RETRYABLE: ReadonlySet<PlatformErrorCode> = new Set<PlatformErrorCode>([
  'RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_TIMEOUT',
]);

export interface ExtractedError {
  /** 厂商错误码（可能为空字符串） */
  code: string;
  message: string;
  /** 厂商是否已向我方计费（用于毛利核算，与「是否向用户计费」是两件事） */
  providerCharged: boolean;
  raw: unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** 从各种可能的厂商返回形态里抽出 code / message，不抛异常 */
export function extractError(input: unknown): ExtractedError {
  if (input instanceof Error) {
    return { code: input.name ?? '', message: input.message, providerCharged: false, raw: input };
  }
  if (typeof input === 'string') {
    return { code: '', message: input, providerCharged: false, raw: input };
  }
  if (!isRecord(input)) {
    return { code: '', message: JSON.stringify(input) ?? '', providerCharged: false, raw: input };
  }

  const nested = isRecord(input.error) ? input.error : undefined;
  const pick = (...keys: string[]): string => {
    for (const k of keys) {
      const v = input[k] ?? nested?.[k];
      if (typeof v === 'string' && v) return v;
      if (typeof v === 'number') return String(v);
    }
    return '';
  };

  const code = pick('code', 'error_code', 'errorCode', 'status', 'type', 'errno', 'reason');
  const message = pick('message', 'msg', 'detail', 'error_message', 'errorMessage', 'description');

  const chargedRaw = input.charged ?? input.billed ?? input.is_charged ?? input.cost;
  const providerCharged = chargedRaw === true || (typeof chargedRaw === 'number' && chargedRaw > 0);

  return { code, message, providerCharged, raw: input };
}

export interface NormalizeOptions {
  /** 厂商侧错误码 → 平台错误码的显式映射（来自 PROVIDER_ERROR_MAP），优先级最高 */
  errorMap?: Record<string, string>;
  /** 附加到判定文本末尾的上下文（如 HTTP 状态码），提高规则命中率 */
  context?: string;
}

const PLATFORM_CODES: ReadonlySet<string> = new Set<string>([
  'CONTENT_BLOCKED_BY_PROVIDER',
  'PROVIDER_TIMEOUT',
  'PROVIDER_ERROR',
  'PROVIDER_UNAVAILABLE',
  'RATE_LIMITED',
  'INVALID_ARGUMENT',
]);

/**
 * 把厂商错误归一为平台失败。
 *
 * 判定顺序：
 *   1. 厂商错误码精确命中 `errorMap`（且映射值本身是合法平台码）
 *   2. 用 code + message + context 跑内置规则
 *   3. 都不中 → `PROVIDER_ERROR`（保守兜底，且不自动重试）
 */
export function normalizeError(input: unknown, options: NormalizeOptions = {}): PlatformFailure {
  const { code, message, providerCharged, raw } = extractError(input);
  const text = `${code} ${message} ${options.context ?? ''}`;

  let platformCode: PlatformErrorCode | null = null;

  const mapped = code ? options.errorMap?.[code] : undefined;
  if (mapped && PLATFORM_CODES.has(mapped)) {
    platformCode = mapped as PlatformErrorCode;
  }

  if (!platformCode) {
    for (const rule of DEFAULT_RULES) {
      if (rule.match.test(text)) {
        platformCode = rule.code;
        break;
      }
    }
  }

  const finalCode: PlatformErrorCode = platformCode ?? 'PROVIDER_ERROR';

  return {
    code: finalCode,
    providerCode: code || '(厂商未提供错误码)',
    message: message || '厂商未提供错误信息',
    // 平台口径（B4.3）：向用户计费只发生在成功时。
    // 注意这与 providerCharged 是两件事：厂商可能已扣我方成本，但用户不该为此付费。
    billable: false,
    retryable: RETRYABLE.has(finalCode),
    providerCharged,
    raw,
  };
}

/** 供日志与工单使用的一行摘要；**绝不包含**任何密钥 */
export function describeFailure(f: PlatformFailure): string {
  return `${f.code} (厂商码 ${f.providerCode})：${f.message}｜可重试=${f.retryable}｜厂商已计费=${f.providerCharged}`;
}
