import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, describeFailure, extractError, normalizeError } from '../server/providers/errors';
import { maskKey, reportProviderConfig, type ProviderConfig } from '../server/config';

/**
 * 错误归一测试 —— 适配层里最该被锁住的一段。
 *
 * 为什么必须测：积分返还与重试策略**完全依赖归一结果**。
 * 一旦「内容拦截」被误判为「参数错误」，用户会看到与事实不符的提示、
 * 且错误码会写进契约之外的取值，前端的分支处理随之失效。
 */

describe('normalizeError · 平台错误码判定', () => {
  const cases: Array<[string, unknown, string]> = [
    ['英文字段 content_policy_violation', { code: 'content_policy_violation' }, 'CONTENT_BLOCKED_BY_PROVIDER'],
    ['中文字段「敏感内容」', { message: '包含敏感内容，已拦截' }, 'CONTENT_BLOCKED_BY_PROVIDER'],
    ['厂商用 400 返回内容拦截', { code: '400', message: 'policy violation' }, 'CONTENT_BLOCKED_BY_PROVIDER'],
    ['超时（中文）', { message: '生成超时，请重试' }, 'PROVIDER_TIMEOUT'],
    ['超时（ETIMEDOUT）', { code: 'ETIMEDOUT' }, 'PROVIDER_TIMEOUT'],
    ['限流 429', { code: '429' }, 'RATE_LIMITED'],
    ['限流（中文「频率限制」）', { message: '触发频率限制' }, 'RATE_LIMITED'],
    ['服务不可用 503', { code: '503' }, 'PROVIDER_UNAVAILABLE'],
    ['参数非法', { code: 'invalid_request', message: 'unsupported aspect ratio' }, 'INVALID_ARGUMENT'],
    ['参数非法（中文）', { message: '参数不支持' }, 'INVALID_ARGUMENT'],
    // ⚠️ 以下几项是写 stub 模拟器时才发现的**真实归一缺口**：
    //    各家错误码普遍用下划线（too_many_requests / bad_request / timed_out），
    //    而规则原写 `too\s?many` —— `\s?` 只允许空白，匹配不到下划线。
    //    于是它们会掉到兜底的 PROVIDER_ERROR，而 PROVIDER_ERROR **不可重试**：
    //    一次本可自动重试的限流，就变成给用户报「未知错误」且不再重试。
    ['下划线 too_many_requests（Google / Stripe / GitHub 通用）', { code: 'too_many_requests' }, 'RATE_LIMITED'],
    ['下划线 RESOURCE_EXHAUSTED（gRPC 的配额耗尽）', { code: 'RESOURCE_EXHAUSTED' }, 'RATE_LIMITED'],
    ['下划线 bad_request', { code: 'bad_request' }, 'INVALID_ARGUMENT'],
    ['下划线 timed_out', { code: 'timed_out' }, 'PROVIDER_TIMEOUT'],
    ['未知错误兜底', { code: 'internal_error' }, 'PROVIDER_ERROR'],
  ];

  for (const [name, input, expected] of cases) {
    it(`${name} → ${expected}`, () => {
      expect(normalizeError(input).code).toBe(expected);
    });
  }

  it('规则优先级：内容拦截必须排在参数错误之前', () => {
    // 这是本文件存在的核心理由。厂商普遍用 400 返回内容拦截，
    // 若「400/参数」规则排在前面，用户会看到「参数错误」这种与事实不符的提示。
    const contentIdx = DEFAULT_RULES.findIndex((r) => r.code === 'CONTENT_BLOCKED_BY_PROVIDER');
    const invalidIdx = DEFAULT_RULES.findIndex((r) => r.code === 'INVALID_ARGUMENT');
    expect(contentIdx).toBeGreaterThanOrEqual(0);
    expect(contentIdx).toBeLessThan(invalidIdx);

    expect(normalizeError({ code: '400', message: 'content policy violation' }).code).toBe(
      'CONTENT_BLOCKED_BY_PROVIDER',
    );
  });

  it('显式 errorMap 优先于内置规则', () => {
    // 真实场景：某厂商把内容拦截编码为 1001，光看码值是看不出语义的
    const failure = normalizeError(
      { code: '1001', message: 'request rejected' },
      { errorMap: { '1001': 'CONTENT_BLOCKED_BY_PROVIDER' } },
    );
    expect(failure.code).toBe('CONTENT_BLOCKED_BY_PROVIDER');
    expect(failure.providerCode).toBe('1001');
  });

  it('errorMap 里的非法值被忽略，回落到内置规则（不产生契约外的错误码）', () => {
    const failure = normalizeError({ code: 'x', message: 'timeout' }, { errorMap: { x: 'NOT_A_CODE' } });
    expect(failure.code).toBe('PROVIDER_TIMEOUT');
  });

  it('HTTP 状态码作为上下文参与判定', () => {
    expect(normalizeError({ foo: 1 }, { context: 'http 504' }).code).toBe('PROVIDER_TIMEOUT');
  });

  it('失败一律不计费（B4.3 口径只有一个判定点）', () => {
    for (const input of [{ code: 'invalid' }, { code: '429' }, { message: '超时' }]) {
      expect(normalizeError(input).billable).toBe(false);
    }
  });

  it('可重试性：只有「等一会儿能好」的失败才可重试', () => {
    expect(normalizeError({ code: '429' }).retryable).toBe(true);
    expect(normalizeError({ code: '503' }).retryable).toBe(true);
    expect(normalizeError({ code: 'timeout' }).retryable).toBe(true);
    // 未知错误刻意不重试：无法判断厂商是否已真实执行，重试可能造成重复生成与重复消耗
    expect(normalizeError({ code: 'internal_error' }).retryable).toBe(false);
    expect(normalizeError({ message: 'content policy' }).retryable).toBe(false);
    expect(normalizeError({ code: 'invalid_param' }).retryable).toBe(false);
  });

  it('厂商已计费与用户计费是两件事，不可合并', () => {
    const f = normalizeError({ code: 'internal_error', charged: true });
    expect(f.providerCharged).toBe(true); // 厂商扣了我方成本
    expect(f.billable).toBe(false); // 但不向用户收费
  });

  it('能处理异常、字符串与非对象输入，不抛错', () => {
    expect(normalizeError(new Error('boom')).code).toBe('PROVIDER_ERROR');
    expect(normalizeError('something went wrong with timeout').code).toBe('PROVIDER_TIMEOUT');
    expect(normalizeError(null).code).toBe('PROVIDER_ERROR');
    expect(normalizeError(undefined).message).toBeTruthy();
  });

  it('缺失厂商错误码时有明确占位，不出现空字符串', () => {
    const f = normalizeError({ something: 'odd' });
    expect(f.providerCode).toBe('(厂商未提供错误码)');
    expect(f.raw).toBeDefined();
  });

  it('describeFailure 输出可读且不含密钥形态的字符串', () => {
    const text = describeFailure(normalizeError({ code: '429', message: 'too many requests' }));
    expect(text).toContain('RATE_LIMITED');
    expect(text).toContain('可重试=true');
    expect(text).not.toMatch(/(sk|key)-[A-Za-z0-9]{16,}/);
  });
});

describe('extractError · 字段抽取', () => {
  it('能从嵌套 error 对象里取值', () => {
    expect(extractError({ error: { code: 'E42', message: 'nested' } }).code).toBe('E42');
  });

  it('数字码值转字符串', () => {
    expect(extractError({ status: 429 }).code).toBe('429');
  });

  it('cost > 0 视为厂商已计费', () => {
    expect(extractError({ code: 'x', cost: 12 }).providerCharged).toBe(true);
    expect(extractError({ code: 'x', cost: 0 }).providerCharged).toBe(false);
  });
});

describe('密钥掩码与配置自检（风险 R13）', () => {
  const base: ProviderConfig = {
    id: 'test',
    displayName: 'test',
    baseUrl: 'https://api.example.com',
    // 夹具刻意写成明显不像密钥的形态（无 sk- 前缀、带连字符）：
    // 归档时的密钥扫描按「sk- 后跟 20+ 位」这样的**形态**来查，
    // 若夹具长得像真密钥，扫描就会命中它 —— 那是误报，而正确的修法是
    // 让夹具不像密钥，不是放宽扫描器（放宽会让真密钥漏过去）。
    apiKey: 'test-fixture-not-a-real-key-9876543210',
    submitPath: '/s',
    pollPath: '/p/{id}',
    cancelPath: '/c/{id}',
    pollIntervalMs: 1000,
    timeoutMs: 1000,
    errorMap: {},
  };

  it('掩码永不泄漏完整 Key', () => {
    const masked = maskKey(base.apiKey);
    expect(masked).not.toContain(base.apiKey);
    // 也不得泄漏除末 4 位以外的任何片段
    expect(masked).not.toContain('fixture-not-a-real');
    expect(masked).toContain(base.apiKey.slice(-4));
    expect(masked).toContain(String(base.apiKey.length));
  });

  it('空 Key 与极短 Key 也有安全输出', () => {
    expect(maskKey('')).toBe('(未配置)');
    expect(maskKey('short')).not.toContain('short');
  });

  it('缺少必填项时配置判定为未就绪，且缺失项明确', () => {
    const report = reportProviderConfig({ ...base, apiKey: '' });
    expect(report.configured).toBe(false);
    expect(report.missing).toContain('PROVIDER_API_KEY');
  });

  it('自检报告中的 Key 字段是掩码，不是明文', () => {
    const report = reportProviderConfig(base);
    expect(report.configured).toBe(true);
    expect(report.masked.PROVIDER_API_KEY).not.toBe(base.apiKey);
    expect(JSON.stringify(report)).not.toContain(base.apiKey);
  });
});
