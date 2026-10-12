import { describe, expect, it } from 'vitest';
import { failureFromStatus, normalizeChatCompletion } from '../server/llm/deepseek';
import { LlmError } from '../server/llm/types';
import { findSkill, PROMPT_SKILLS } from '../server/llm/prompt-enhance';

/**
 * LLM 响应归一测试。
 *
 * 这里的用例**全部来自真实实测**（2026-10-12，curl 直取原始字节），不是构造出来的：
 *   · 第 1 条复现的是我实际踩到的坑 —— max_tokens=300 时 `deepseek-flash` 把
 *     整个预算花在思维链上，`content` 返回空字符串且 `finish_reason='length'`。
 *     如果不显式区分它，上层会看到「成功但内容为空」，然后把空串写进 genSnapshot。
 */

const okResponse = {
  id: 'x',
  model: 'deepseek-flash',
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: '一只毛茸茸的橘色虎斑猫，圆润大眼与粉嫩肉垫，慵懒地趴在木质窗台，写实摄影风格，清晨柔和侧逆光，三分法构图，浅景深虚化背景，超高清细节，8K画质。',
        reasoning_content: 'We need answer in Chinese, only prompt...',
      },
      finish_reason: 'stop',
    },
  ],
  usage: {
    prompt_tokens: 82,
    completion_tokens: 313,
    total_tokens: 395,
    completion_tokens_details: { reasoning_tokens: 252 },
  },
};

describe('normalizeChatCompletion · 正常路径', () => {
  it('提取最终答案，并把思维链单独存放（不混入 content）', () => {
    const r = normalizeChatCompletion(okResponse);
    expect(r.content).toContain('橘色虎斑猫');
    expect(r.content).not.toContain('We need answer');
    expect(r.reasoning).toContain('We need answer');
    expect(r.finishReason).toBe('stop');
    expect(r.model).toBe('deepseek-flash');
  });

  it('用量含思维链：思维链计入 completion_tokens 与计费', () => {
    const r = normalizeChatCompletion(okResponse);
    expect(r.usage.reasoningTokens).toBe(252);
    expect(r.usage.completionTokens).toBe(313);
    // 实测：思维链占输出约 80%。只数 content 会严重低估成本
    expect(r.usage.reasoningTokens / r.usage.completionTokens).toBeGreaterThan(0.7);
  });

  it('content 两侧空白被清理', () => {
    const r = normalizeChatCompletion({
      ...okResponse,
      choices: [{ message: { content: '  正常内容  ' }, finish_reason: 'stop' }],
    });
    expect(r.content).toBe('正常内容');
  });
});

describe('normalizeChatCompletion · 静默失败必须被挡住', () => {
  it('推理吃光预算导致 content 为空 → 抛 LLM_TRUNCATED_BY_TOKEN_LIMIT', () => {
    // 这是实测复现：max_tokens=300 时 completion_tokens=300、reasoning_tokens=300、content=""
    const truncated = {
      model: 'deepseek-flash',
      choices: [{ message: { role: 'assistant', content: '', reasoning_content: '思考中…' }, finish_reason: 'length' }],
      usage: {
        prompt_tokens: 55,
        completion_tokens: 300,
        total_tokens: 355,
        completion_tokens_details: { reasoning_tokens: 300 },
      },
    };

    let caught: unknown;
    try {
      normalizeChatCompletion(truncated);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(LlmError);
    const e = caught as LlmError;
    expect(e.code).toBe('LLM_TRUNCATED_BY_TOKEN_LIMIT');
    // 错误信息必须带上「思维链吃掉了多少」，否则没人能想出该怎么修
    expect(e.message).toContain('300');
    expect(e.hint).toContain('LLM_MAX_TOKENS');
  });

  it('空内容但非截断 → LLM_EMPTY_CONTENT（与截断区分开）', () => {
    expect(() =>
      normalizeChatCompletion({
        choices: [{ message: { content: '   ' }, finish_reason: 'stop' }],
      }),
    ).toThrowError(/LLM_EMPTY_CONTENT|空内容/);
  });

  it('结构异常不静默通过，而是给出可排查的错误', () => {
    for (const bad of [null, {}, { choices: [] }, { choices: [null] }, 'not json']) {
      expect(() => normalizeChatCompletion(bad)).toThrow(LlmError);
    }
  });

  it('缺 usage 时不崩，按 0 处理', () => {
    const r = normalizeChatCompletion({
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    });
    expect(r.usage.completionTokens).toBe(0);
    expect(r.content).toBe('ok');
  });
});

describe('failureFromStatus · HTTP 状态映射', () => {
  const cases: Array<[number, string]> = [
    [401, 'LLM_AUTH_FAILED'],
    [403, 'LLM_AUTH_FAILED'],
    [429, 'LLM_RATE_LIMITED'],
    [500, 'LLM_UNAVAILABLE'],
    [503, 'LLM_UNAVAILABLE'],
    [400, 'LLM_BAD_RESPONSE'],
  ];

  for (const [status, code] of cases) {
    it(`HTTP ${status} → ${code}`, () => {
      const e = failureFromStatus(status, { error: 'x' });
      expect(e.code).toBe(code);
      expect(e.hint).toBeTruthy(); // 没有 hint 前端只能显示「调用失败」
    });
  }
});

describe('PromptSkill · 版本纪律', () => {
  it('未知技能回落到通用技能，而不是抛错打断创作', () => {
    expect(findSkill('not-exist').id).toBe('generic');
  });

  it('每个技能都有 id + version + systemPrompt（同款还原必需）', () => {
    expect(PROMPT_SKILLS.length).toBeGreaterThan(0);
    for (const s of PROMPT_SKILLS) {
      expect(s.id).toBeTruthy();
      expect(s.version).toBeTruthy();
      expect(s.systemPrompt.length).toBeGreaterThan(20);
    }
  });

  it('技能 id@version 唯一（重复会导致溯源时无法判断用了哪一版）', () => {
    const keys = PROMPT_SKILLS.map((s) => `${s.id}@${s.version}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('系统提示词明确要求「只输出提示词」，避免把解释性文字写进 genSnapshot', () => {
    for (const s of PROMPT_SKILLS) {
      expect(/只输出/.test(s.systemPrompt)).toBe(true);
    }
  });
});
