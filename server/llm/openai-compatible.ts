/**
 * OpenAI 兼容的 LLM 适配器（当前承载 DeepSeek 与 Kimi）
 *
 * 为什么是一个适配器而不是两个：
 *   实测两家的响应结构**完全一致** —— 最终答案在 `choices[0].message.content`，
 *   思维链在 `choices[0].message.reasoning_content`，用量在
 *   `usage.completion_tokens_details.reasoning_tokens`。
 *   差异只在**配置**（baseUrl / model / temperature），所以差异应该留在配置里，
 *   而不是复制成两份代码 —— 复制出来的两份必然会在某次修 bug 时只改一份。
 *
 * 实测对照（2026-10-12，curl 直取原始字节）：
 *
 *   | 项           | DeepSeek deepseek-flash | Kimi kimi-k2.6        |
 *   |--------------|-------------------------|-----------------------|
 *   | 提示词增强耗时 | 1.5–4.1s（3 次采样）     | 2.3–2.4s（3 次），另有 22.2s 离群一次 |
 *   | temperature  | 0.8 可用                | **只接受 1**          |
 *   | 思维链占输出  | 41%–88%（波动大）        | 72%–79%（较稳定）      |
 *   | 模型可用性    | 无 deepseek-chat        | 无 moonshot-v1-*      |
 *
 * 由此推出四条必须固化的设计：
 *   1. `maxTokens` 必须包含思维链预算 —— 设小了会得到**空 content + finish_reason='length'**，
 *      一个看起来像「模型没返回」的静默失败。
 *   2. 温度**不能跨 provider 共用默认值** —— Kimi K2 传 0.7 直接 400。温度走 profile 配置。
 *   3. 思维链绝不透传给前端（可能含系统提示词原文，等于泄漏技能包内容）。
 *   4. 成本按 `completion_tokens` 计（含思维链）；只数 `content` 会严重低估。
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
 * DeepSeek 与 Kimi 共用这一份 —— 因为实测它们的响应结构一致。
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
        `调大 <PROVIDER>_MAX_TOKENS（推理模型下建议 ≥2000），或改用非推理模型。` +
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

/** HTTP 状态码 + 响应体 → LlmError。与 providers 的错误归一保持同样的「给出下一步」风格 */
export function failureFromStatus(status: number, body: unknown): LlmError {
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? '');

  // Kimi 用 400 返回「temperature 不合法」这类**配置错误**，不是鉴权或限流。
  // 不做特判的话它会被归到泛化的请求被拒，排查时看不到真正原因。
  if (status === 400 && /temperature/i.test(text)) {
    return new LlmError(
      'LLM_BAD_RESPONSE',
      `温度取值被厂商拒绝（HTTP 400）：${text.slice(0, 160)}`,
      '该模型可能只接受固定温度（实测 Kimi K2 只允许 1）。请调整 <PROVIDER>_TEMPERATURE',
      body,
    );
  }

  if (status === 401 || status === 403) {
    return new LlmError('LLM_AUTH_FAILED', `鉴权失败（HTTP ${status}）`, '检查 <PROVIDER>_API_KEY 是否有效、是否已过期或额度耗尽', body);
  }
  if (status === 429) {
    return new LlmError('LLM_RATE_LIMITED', '触发限流（HTTP 429）', '降低并发或加退避重试；同步交互场景建议在前端做节流', body);
  }
  if (status >= 500) {
    return new LlmError('LLM_UNAVAILABLE', `供应商不可用（HTTP ${status}）`, '稍后重试；若持续则切备用 provider', body);
  }
  return new LlmError('LLM_BAD_RESPONSE', `请求被拒绝（HTTP ${status}）`, `核对 baseUrl / model 名称与请求体格式。原始响应：${text.slice(0, 200)}`, body);
}

export class OpenAiCompatibleLlm implements LlmAdapter {
  readonly id: string;
  readonly model: string;

  constructor(private readonly cfg: LlmConfig) {
    this.id = cfg.provider;
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
        `LLM provider「${this.cfg.provider}」未配置完整`,
        `在 app/.env.llm 填入 ${this.cfg.provider.toUpperCase()}_BASE_URL / _API_KEY / _MODEL，然后运行 npm run llm:check`,
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
          // 温度来自 profile：Kimi K2 只接受 1，共用一个默认值会直接 400
          temperature: options.temperature ?? this.cfg.temperature,
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
          '提示词增强是同步交互：Kimi K2 实测单次约 22s，DeepSeek flash 约 2s。' +
            '若用慢模型，建议调大超时并在前端给明确的等待反馈',
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
      adapter: 'openai-compatible',
      provider: this.cfg.provider,
      baseUrl: this.cfg.baseUrl || '(未配置)',
      model: this.model || '(未配置)',
      temperature: String(this.cfg.temperature),
      apiKey: maskKey(this.cfg.apiKey),
    };
  }
}

/** 解析当前启用的 LLM 适配器；传入 providerName 可显式指定 */
export function resolveLlm(providerName?: string): OpenAiCompatibleLlm {
  return new OpenAiCompatibleLlm(loadLlmConfig(providerName));
}
