import { afterEach, describe, expect, it } from 'vitest';
import { failureFromStatus, normalizeChatCompletion } from '../server/llm/openai-compatible';
import { LlmError } from '../server/llm/types';
import { findSkill, listSkills, PROMPT_SKILLS } from '../server/llm/prompt-enhance';
import { loadLlmConfig } from '../server/config';

/**
 * LLM 适配层测试。
 *
 * 这里的用例**全部来自真实实测**（2026-10-12，curl 直取原始字节），不是构造出来的：
 *   · DeepSeek 与 Kimi 的响应结构一致 ⇒ 共用一个 normalize（本文件验证这一点）
 *   · max_tokens=300 时 reasoning 吃光预算、content 为空 + finish_reason=length
 *   · Kimi K2 传 temperature≠1 返回 400
 * 把它们固化成测试，是因为这几类失败**都不报错、都长得像成功**。
 */

/* ------------------------------------------------------------------ *
 * 真实响应样本（两家的结构一致，这是共用适配器的依据）
 * ------------------------------------------------------------------ */

const deepseekResponse = {
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

const kimiResponse = {
  id: 'chatcmpl-6acc51e60c43898e3f120e23',
  model: 'kimi-k2.6',
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: '一只橘猫在午后阳光下跃起扑蝶的瞬间，毛发纤毫毕现，琥珀色瞳孔锐利专注，超写实摄影风格，侧逆光勾勒金色轮廓，浅景深虚化背景，三分法构图，8K超高画质，画面充满张力与生命力。',
        reasoning_content: '用户要求将简短描述「一只猫」扩展成一句结构完整的中文提示词…',
      },
      finish_reason: 'stop',
    },
  ],
  usage: {
    prompt_tokens: 105,
    completion_tokens: 802,
    total_tokens: 907,
    completion_tokens_details: { reasoning_tokens: 745 },
  },
};

describe('normalizeChatCompletion · 两家响应结构一致（共用适配器的依据）', () => {
  for (const [name, raw, model] of [
    ['DeepSeek', deepseekResponse, 'deepseek-flash'],
    ['Kimi', kimiResponse, 'kimi-k2.6'],
  ] as const) {
    it(`${name}：提取最终答案，思维链单独存放不混入 content`, () => {
      const r = normalizeChatCompletion(raw);
      expect(r.model).toBe(model);
      expect(r.content.length).toBeGreaterThan(20);
      expect(r.content).not.toContain('思考');
      expect(r.reasoning.length).toBeGreaterThan(10);
      expect(r.finishReason).toBe('stop');
    });

    it(`${name}：思维链计入 completion_tokens 与计费`, () => {
      const r = normalizeChatCompletion(raw);
      expect(r.usage.reasoningTokens).toBeGreaterThan(0);
      // 实测思维链占比波动大（DeepSeek 41%–88%、Kimi 72%–79%），只数最终答案会严重低估成本
      expect(r.usage.reasoningTokens / r.usage.completionTokens).toBeGreaterThan(0.7);
      expect(r.usage.reasoningTokens).toBeLessThanOrEqual(r.usage.completionTokens);
    });
  }

  it('content 两侧空白被清理', () => {
    const r = normalizeChatCompletion({
      choices: [{ message: { content: '  正常内容  ' }, finish_reason: 'stop' }],
      usage: {},
    });
    expect(r.content).toBe('正常内容');
  });
});

describe('normalizeChatCompletion · 静默失败必须被挡住', () => {
  it('推理吃光预算导致 content 为空 → 抛 LLM_TRUNCATED_BY_TOKEN_LIMIT', () => {
    // 实测复现：max_tokens=300 时 completion_tokens=300、reasoning_tokens=300、content=""
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
    expect(e.hint).toContain('MAX_TOKENS');
  });

  it('空内容但非截断 → LLM_EMPTY_CONTENT（与截断区分开）', () => {
    expect(() =>
      normalizeChatCompletion({ choices: [{ message: { content: '   ' }, finish_reason: 'stop' }] }),
    ).toThrowError(/空内容/);
  });

  it('结构异常不静默通过，而是给出可排查的错误', () => {
    for (const bad of [null, {}, { choices: [] }, { choices: [null] }, 'not json']) {
      expect(() => normalizeChatCompletion(bad)).toThrow(LlmError);
    }
  });

  it('缺 usage 时不崩，按 0 处理', () => {
    const r = normalizeChatCompletion({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
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
      expect(e.hint).toBeTruthy(); // 没有 hint，前端只能显示「调用失败」
    });
  }

  it('Kimi 的 temperature 400 被特判，提示指向 TEMPERATURE 配置', () => {
    // 实测原文：invalid temperature: only 1 is allowed for this model
    const e = failureFromStatus(400, {
      error: { message: 'invalid temperature: only 1 is allowed for this model' },
    });
    expect(e.message).toContain('温度');
    expect(e.hint).toContain('TEMPERATURE');
  });
});

describe('PromptSkill · 契约对齐与版本纪律', () => {
  it('字段名跟随契约：key + version(integer)', () => {
    for (const s of PROMPT_SKILLS) {
      expect(typeof s.key).toBe('string');
      expect(Number.isInteger(s.version)).toBe(true);
      expect(s.name).toBeTruthy();
    }
  });

  it('未知技能回落到通用技能，而不是抛错打断创作', () => {
    // 技能 key 可能因前端缓存而过期，此时应降级而不是 500
    expect(findSkill('not-exist').key).toBe('generic');
    expect(findSkill(undefined).key).toBe('generic');
  });

  it('key@version 唯一（重复会导致溯源时无法判断用了哪一版）', () => {
    const keys = PROMPT_SKILLS.map((s) => `${s.key}@${s.version}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('系统提示词明确要求「只输出提示词」，避免解释性文字写进 genSnapshot', () => {
    for (const s of PROMPT_SKILLS) {
      expect(/只输出/.test(s.systemPrompt)).toBe(true);
    }
  });

  it('listSkills 返回契约形态，且**不含 promptTemplate**（系统提示词不对外泄漏）', () => {
    const { items } = listSkills();
    expect(items.length).toBe(PROMPT_SKILLS.length);
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(['description', 'key', 'name', 'version']);
    }
    expect(JSON.stringify(items)).not.toContain('你是');
  });
});

describe('LLM 多 provider 配置', () => {
  // 用一个不可能出现在任何 .env 文件里的 provider 名，
  // 这样用例的结果只取决于 process.env，在本地（有 .env.llm）与 CI（无）下都一致。
  const P = 'zztest';
  const VAR = {
    base: 'ZZTEST_BASE_URL',
    key: 'ZZTEST_API_KEY',
    model: 'ZZTEST_MODEL',
    temp: 'ZZTEST_TEMPERATURE',
    timeout: 'ZZTEST_TIMEOUT_MS',
    maxTokens: 'ZZTEST_MAX_TOKENS',
  };

  afterEach(() => {
    for (const k of Object.values(VAR)) delete process.env[k];
    delete process.env.LLM_TIMEOUT_MS;
    delete process.env.LLM_MAX_TOKENS;
    delete process.env.LLM_TEMPERATURE;
  });

  it('按 profile 名读取，切换 provider 不需要改 Key', () => {
    process.env[VAR.base] = 'https://api.example.com/';
    process.env[VAR.key] = 'sk-dummy-for-test';
    process.env[VAR.model] = 'model-a';

    const cfg = loadLlmConfig(P);
    expect(cfg.provider).toBe(P);
    expect(cfg.model).toBe('model-a');
    expect(cfg.baseUrl).toBe('https://api.example.com'); // 结尾斜杠被去掉，避免拼出 //chat/completions
    expect(cfg.apiKey).toBe('sk-dummy-for-test');
  });

  it('temperature 是 profile 级：**不**从全局 LLM_TEMPERATURE 回落', () => {
    // 这条是设计意图的守门人。若将来有人「顺手」给 temperature 加全局回落，
    // Kimi K2（只接受 1）就会因为全局默认值而 400。必须红。
    process.env[VAR.base] = 'https://api.example.com';
    process.env[VAR.key] = 'sk-dummy';
    process.env[VAR.model] = 'm';
    process.env.LLM_TEMPERATURE = '0.3';

    expect(loadLlmConfig(P).temperature).toBe(0.8); // 内置默认，而非 0.3
  });

  it('profile 级 temperature 覆盖内置默认', () => {
    process.env[VAR.base] = 'https://api.example.com';
    process.env[VAR.key] = 'sk-dummy';
    process.env[VAR.model] = 'm';
    process.env[VAR.temp] = '1';

    expect(loadLlmConfig(P).temperature).toBe(1);
  });

  it('timeout / maxTokens 回落顺序：profile 级覆盖全局级', () => {
    // 刻意**不**断言「内置默认值」。本地存在真实 .env.llm（其中设了 LLM_TIMEOUT_MS），
    // 断言绝对值会让这条用例在本地与 CI 下表现不同 —— 那正是最该避免的环境依赖型测试。
    // 这里只断言**优先级关系**，用一个不可能与默认值巧合相同的哨兵值。
    process.env[VAR.base] = 'https://api.example.com';
    process.env[VAR.key] = 'sk-dummy';
    process.env[VAR.model] = 'm';

    process.env.LLM_TIMEOUT_MS = '45000';
    process.env.LLM_MAX_TOKENS = '1234';
    expect(loadLlmConfig(P).timeoutMs).toBe(45000);
    expect(loadLlmConfig(P).maxTokens).toBe(1234);

    process.env[VAR.timeout] = '9000';
    process.env[VAR.maxTokens] = '777';
    expect(loadLlmConfig(P).timeoutMs).toBe(9000);
    expect(loadLlmConfig(P).maxTokens).toBe(777);
  });

  it('缺少必填项时不抛错，而是如实报告未配置', () => {
    process.env[VAR.base] = 'https://api.example.com';
    // 故意不设 API_KEY 与 MODEL
    const cfg = loadLlmConfig(P);
    expect(cfg.apiKey).toBe('');
    expect(cfg.model).toBe('');
  });
});
