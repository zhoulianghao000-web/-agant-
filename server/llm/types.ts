/**
 * LLM 适配层类型
 *
 * 为什么单独一层、不复用 providers/：
 *   `providers/` 是**生成能力**（文生图 / 图生视频）——异步任务、轮询、按张/秒计费。
 *   `llm/` 是**语言模型**——同步问答、按 token 计费、有思维链。
 *   两者的生命周期、失败恢复、成本模型完全不同，合并会逼出一个到处是 if 的适配器。
 */

export type LlmRole = 'system' | 'user' | 'assistant';

export interface LlmMessage {
  role: LlmRole;
  content: string;
}

export type LlmFailureCode =
  | 'LLM_NOT_CONFIGURED'
  | 'LLM_TRUNCATED_BY_TOKEN_LIMIT'
  | 'LLM_EMPTY_CONTENT'
  | 'LLM_AUTH_FAILED'
  | 'LLM_RATE_LIMITED'
  | 'LLM_TIMEOUT'
  | 'LLM_UNAVAILABLE'
  | 'LLM_BAD_RESPONSE';

export class LlmError extends Error {
  readonly code: LlmFailureCode;
  /** 给用户的下一步动作；没有它，前端只能显示「调用失败」 */
  readonly hint: string;
  readonly raw?: unknown;

  constructor(code: LlmFailureCode, message: string, hint: string, raw?: unknown) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    this.hint = hint;
    this.raw = raw;
  }
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  /** 思维链消耗的 token（推理模型才有）。**它计入计费**，不能忽略 */
  reasoningTokens: number;
  totalTokens: number;
}

export interface LlmChatResult {
  /** 最终答案（已 trim）。**不含思维链** */
  content: string;
  /**
   * 思维链。默认**不透传给前端** ——
   * ① 它是模型内部推理，暴露给用户会造成「为什么它这么想」的困惑；
   * ② 它可能包含系统提示词原文，等于泄漏技能包内容。
   * 保留是为了排查与成本分析。
   */
  reasoning: string;
  finishReason: string;
  usage: LlmUsage;
  model: string;
  /** 端到端耗时 */
  elapsedMs: number;
}

export interface LlmAdapter {
  readonly id: string;
  readonly model: string;
  readonly configured: boolean;
  /** messages → 单轮补全 */
  chat(messages: LlmMessage[], options?: { maxTokens?: number; temperature?: number }): Promise<LlmChatResult>;
}
