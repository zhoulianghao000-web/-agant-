/**
 * DeepSeek（OpenAI 兼容）适配器
 *
 * 实测结论（2026-10-12，已用 curl 原始字节复核）：
 *   · `GET /models` 在本账号下返回 `deepseek-flash` 与 `deepseek-v4-pro`（**没有** `deepseek-chat`）
 *   · `deepseek-flash` 是**推理模型**：结果在 `choices[0].message.content`，
 *     思维链在 `choices[0].message.reasoning_content`，用量在
 *     `usage.completion_tokens_details.reasoning_tokens`
 *   · 实测「一只猫」：reasoning_tokens=252、最终答案 61 token ⇒ **思维链占总输出约 80%**
 *
 * 由此推出三条必须固化的设计（都不是可选优化）：
 *   1. `maxTokens` 必须包含思维链预算。设小了会得到**空 content + finish_reason='length'**，
 *      一个看起来像「模型没返回」的静默失败。
 *   2. 思维链绝不透传给前端（可能含系统提示词原文）。
 *   3. 成本按 `completion_tokens` 计（含思维链），只数 `content` 会严重低估。
 */

import { loadLlmConfig, maskKey, type LlmConfig } from '../config';
import { LlmError, type LlmAdapter, type LlmChatResult, type LlmMessage, type LlmUsage } from './types';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 把厂商返回归一为 `LlmChatResult`；不可用时抛 `LlmError`。
 *
 * 纯函数（不发请求），因此可能出现的每种坏情况都能被单测锁住。
 */
export function normalizeChatCompletion(raw: unknown, elapsedMs = 0): LlmChatResult {
  if (!isRecord(raw)) {
    throw new LlmError('LLM_BAD_RESPONSE', '响应不是 JSON 对象', '检查 baseUrl 是否指到了非 API 地址（如登录页）', raw);
  }

  const choices = raw.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new LlmError('LLM_BAD_RESPONSE', '响应中没有 choices', '该模型可能不是 chat 类型，或请求体缺 messages', raw);
  }

  const first = choices[0];
  if (!isRecord(first)) {
    throw new LlmError('LLM_BAD_RESPONSE', 'choices[0] 结构异常', '对照厂商文档核对响应结构', raw);
  }

  const message = isRecord(first.message) ? first.message : {};
  const content = typeof message.content === 'string' ? message.content.trim() : '';
  const reasoning = typeof message.reasoning_content === 'string' ? message.reasoning_content : '';
  const finishReason = typeof first.finish_reason === 'string' ? first.finish_reason : '';

  const usageRaw = isRecord(raw.usage) ? raw.usage : {};
  const details = isRecord(usageRaw.completion_tokens_details) ? usageRaw.completion_tokens_details : {};
  const usage: LlmUsage = {
    promptTokens: num(usageRaw.prompt_tokens),
    completionTokens: num(usageRaw.completion_tokens),
    reasoningTokens: num(details.reasoning_tokens),
    totalTokens: num(usageRaw.total_tokens),
  };

  if (!content) {
    // 关键分支：这正是实测踩到的坑。
    // 推理模型把 token 预算全花在思维链上时，content 为空、finish_reason='length'。
    // 若不显式区分，上层只会看到「空字符串」，然后把它当成一次成功的空结果写进库。
    if (finishReason === 'length') {
      throw new LlmError(
        'LLM_TRUNCATED_BY_TOKEN_LIMIT',
        `输出被 max_tokens 截断：思维链已消耗 ${usage.reasoningTokens} token，最终答案未产出`,
        `调大 LLM_MAX_TOKENS（当前推理模型下建议 ≥2000），或改用非推理模型。` +
          `注意思维链计入 token 与费用。`,
        raw,
      );
    }
    throw new LlmError(
      'LLM_EMPTY_CONTENT',
      `模型返回了空内容（finish_reason=${finishReason || '未知'}）`,
      '若是内容审核拦截，请检查提示词；否则换一次重试或改用其它模型',
      raw,
    );
  }

  return {
    content,
    reasoning,
    finishReason,
    usage,
    model: typeof raw.model === 'string' ? raw.model : '(未知)',
    elapsedMs,
  };
}

/** HTTP 状态码 → LlmError。与 providers 的错误归一保持同样的「给出下一步」风格 */
export function failureFromStatus(status: number, body: unknown): LlmError {
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? '');
  if (status === 401 || status === 403) {
    return new LlmError('LLM_AUTH_FAILED', `鉴权失败（HTTP ${status}）`, '检查 LLM_API_KEY 是否有效、是否已过期或额度耗尽', body);
  }
  if (status === 429) {
    return new LlmError('LLM_RATE_LIMITED', '触发限流（HTTP 429）', '降低并发或加退避重试；同步交互场景建议在前端做节流', body);
  }
  if (status >= 500) {
    return new LlmError('LLM_UNAVAILABLE', `供应商不可用（HTTP ${status}）`, '稍后重试；若持续则切备用模型', body);
  }
  return new LlmError('LLM_BAD_RESPONSE', `请求被拒绝（HTTP ${status}）`, `核对 baseUrl / model 名称与请求体格式。原始响应：${text.slice(0, 200)}`, body);
}

export class DeepSeekLlm implements LlmAdapter {
  readonly id = 'deepseek';
  readonly model: string;

  constructor(private readonly cfg: LlmConfig) {
    this.model = cfg.model;
  }

  get configured(): boolean {
    return Boolean(this.cfg.baseUrl && this.cfg.apiKey && this.cfg.model);
  }

  async chat(
    messages: LlmMessage[],
    options: { maxTokens?: number; temperature?: number } = {},
  ): Promise<LlmChatResult> {
    if (!this.configured) {
      throw new LlmError(
        'LLM_NOT_CONFIGURED',
        'LLM 未配置完整',
        '复制 app/.env.llm.example 为 app/.env.llm 并填入 LLM_API_KEY，然后运行 npm run llm:check',
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    const t0 = Date.now();

    try {
      const res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.cfg.apiKey}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          messages,
          max_tokens: options.maxTokens ?? this.cfg.maxTokens,
          temperature: options.temperature ?? 0.7,
          stream: false,
        }),
      });

      const text = await res.text();
      let body: unknown = text;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        /* 保留原始文本，便于定位「baseUrl 指到了 HTML 页面」这类问题 */
      }

      if (!res.ok) throw failureFromStatus(res.status, body);

      return normalizeChatCompletion(body, Date.now() - t0);
    } catch (err) {
      if (err instanceof LlmError) throw err;
      if (controller.signal.aborted) {
        throw new LlmError(
          'LLM_TIMEOUT',
          `超过 ${this.cfg.timeoutMs}ms 未返回`,
          '提示词增强是同步交互，建议缩短提示词或在前端给明确的等待反馈；也可调大 LLM_TIMEOUT_MS',
        );
      }
      throw new LlmError('LLM_UNAVAILABLE', err instanceof Error ? err.message : String(err), '检查网络与 baseUrl 可达性');
    } finally {
      clearTimeout(timer);
    }
  }

  /** 供状态接口展示，**不含明文 Key** */
  describe(): Record<string, string> {
    return {
      adapter: 'deepseek',
      provider: this.cfg.provider,
      baseUrl: this.cfg.baseUrl || '(未配置)',
      model: this.model || '(未配置)',
      apiKey: maskKey(this.cfg.apiKey),
    };
  }
}

export function resolveLlm(): DeepSeekLlm {
  return new DeepSeekLlm(loadLlmConfig());
}
