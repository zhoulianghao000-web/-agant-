/**
 * 任务 0.3「审核口径实测」的用例表（数据定义）
 *
 * 来源：`阶段0-Provider接入执行包-v1.md` §5 —— 本文件是该表的**可执行形式**。
 * 把它们从文档搬进代码，是为了让「10 条用例」变成一条命令，
 * 而不是每次都手工提交、手工抄返回体 —— 手工抄的东西必然会在某次漏抄。
 *
 * ⚠️ 一条刻意的设计：**脚本不预置任何违规测试内容**。
 *    用例 2/3/4/5 涉及违规题材、真人肖像、品牌标识，这些必须由操作者按
 *    当地法律与平台条款自行提供（通过 `AUDIT_*` 环境变量）。
 *    未提供时该用例会被标记为「跳过（未提供测试素材）」，
 *    而不是让脚本去生成一段可能违法的提示词。
 *    —— 一个内容安全测试工具自己产出违规内容，是最糟的自相矛盾。
 *
 * ⚠️ 另一条：本脚本会**消耗真实额度**（10 次提交，含并发压测）。
 *    因此默认是 dry-run，必须显式 `--yes` 才真正提交。
 */

import type { PlatformErrorCode, SubmitInput } from '../providers/types';

export type SpecialKind = 'concurrency' | 'timeout';

export interface AuditCase {
  id: number;
  name: string;
  /** 输入要点（写入报告） */
  intent: string;
  /** 期望了解到什么（写入报告） */
  expect: string;
  /**
   * 期望归一出的平台错误码。
   * `null` = 期望成功；`'ANY'` = 只要拿到结构清晰的失败即可（用于摸边界，不预设结论）。
   */
  expectation: PlatformErrorCode | null | 'ANY';
  /** 是否必须由操作者提供测试素材（违规文本 / 参考图） */
  requiresOperatorInput?: boolean;
  /** 提供素材的环境变量名；未设置则跳过 */
  inputEnv?: string;
  /** 特殊执行方式 */
  special?: SpecialKind;
  /** 构造提交参数 */
  build: (env: (key: string) => string | undefined) => SubmitInput;
}

const base = (env: (k: string) => string | undefined) => ({
  capability: 'txt2img' as const,
  modelKey: env('AUDIT_MODEL') ?? 'txt2img-p0',
  seed: 20261012,
});

/** 用例 1：正常通过 —— 这是整张表的基线，它失败则其余结论都没意义 */
const CASE_1_NEUTRAL = '海岸线日出，电影级长镜头，低角度，海浪细节，暖色侧逆光，超高清';

export const AUDIT_CASES: readonly AuditCase[] = [
  {
    id: 1,
    name: '正常通过',
    intent: '中性描述（海岸线日出）',
    expect: '成功返回结构与耗时',
    expectation: null,
    build: (env) => ({ ...base(env), prompt: CASE_1_NEUTRAL }),
  },
  {
    id: 2,
    name: '明确违规',
    intent: '由操作者提供的明确违规题材（AUDIT_CASE2_PROMPT）',
    expect: '拦截时机（同步 4xx / 异步 error code）与原因码',
    expectation: 'CONTENT_BLOCKED_BY_PROVIDER',
    requiresOperatorInput: true,
    inputEnv: 'AUDIT_CASE2_PROMPT',
    build: (env) => ({ ...base(env), prompt: env('AUDIT_CASE2_PROMPT') ?? '' }),
  },
  {
    id: 3,
    name: '擦边内容',
    intent: '由操作者提供的暧昧但非显式违规内容（AUDIT_CASE3_PROMPT）',
    expect: '判定边界与误拦率',
    expectation: 'ANY',
    requiresOperatorInput: true,
    inputEnv: 'AUDIT_CASE3_PROMPT',
    build: (env) => ({ ...base(env), prompt: env('AUDIT_CASE3_PROMPT') ?? '' }),
  },
  {
    id: 4,
    name: '真人肖像',
    intent: '由操作者提供的含可识别人物的参考图（AUDIT_CASE4_REF_URL）',
    expect: '是否额外拦截、是否要求授权',
    expectation: 'ANY',
    requiresOperatorInput: true,
    inputEnv: 'AUDIT_CASE4_REF_URL',
    build: (env) => ({
      ...base(env),
      capability: 'img2video',
      prompt: '人物自然转头，缓慢推近，电影感',
      referenceUrls: env('AUDIT_CASE4_REF_URL') ? [env('AUDIT_CASE4_REF_URL') as string] : [],
    }),
  },
  {
    id: 5,
    name: '品牌标识',
    intent: '由操作者提供的含知名商标的描述（AUDIT_CASE5_PROMPT）',
    expect: '是否拦截',
    expectation: 'ANY',
    requiresOperatorInput: true,
    inputEnv: 'AUDIT_CASE5_PROMPT',
    build: (env) => ({ ...base(env), prompt: env('AUDIT_CASE5_PROMPT') ?? '' }),
  },
  {
    id: 6,
    name: '空 / 极短提示词',
    intent: '`""`',
    expect: '参数校验错误的返回格式',
    expectation: 'INVALID_ARGUMENT',
    build: (env) => ({ ...base(env), prompt: '' }),
  },
  {
    id: 7,
    name: '超长提示词',
    intent: '超出上限（8000 字符）',
    expect: '截断还是报错',
    expectation: 'ANY',
    build: (env) => ({ ...base(env), prompt: '海岸线日出。'.repeat(1400) }),
  },
  {
    id: 8,
    name: '敏感负面词',
    intent: 'negativePrompt 字段填由操作者提供的敏感词（AUDIT_CASE8_NEGATIVE）',
    expect: '字段级拦截行为',
    expectation: 'ANY',
    requiresOperatorInput: true,
    inputEnv: 'AUDIT_CASE8_NEGATIVE',
    build: (env) => ({
      ...base(env),
      prompt: CASE_1_NEUTRAL,
      negativePrompt: env('AUDIT_CASE8_NEGATIVE') ?? '',
    }),
  },
  {
    id: 9,
    name: '并发压测',
    intent: '超过记录的并发上限（默认 8 路同时提交）',
    expect: '超限返回码与恢复时间',
    expectation: 'RATE_LIMITED',
    special: 'concurrency',
    build: (env) => ({ ...base(env), prompt: `${CASE_1_NEUTRAL}·并发探针` }),
  },
  {
    id: 10,
    name: '超时',
    intent: '诱导长耗时任务（时长拉满 + 高复杂度描述）',
    expect: '超时阈值与超时返回码',
    expectation: 'PROVIDER_TIMEOUT',
    special: 'timeout',
    build: (env) => ({
      ...base(env),
      capability: 'img2video',
      prompt:
        '超长复杂运镜：镜头从地面缓慢上升，穿过雨幕与人群，环绕主体三周后急速拉远，' +
        '再到特写，光影连续变化，极高动态范围，力求最长生成时间。',
      durationSeconds: 30,
    }),
  },
];

export function findCase(id: number): AuditCase | undefined {
  return AUDIT_CASES.find((c) => c.id === id);
}

/** 该用例是否具备执行条件（缺素材的会被跳过而不是伪造输入） */
export function readinessOf(
  auditCase: AuditCase,
  env: (k: string) => string | undefined,
): { ready: true } | { ready: false; reason: string } {
  if (!auditCase.requiresOperatorInput) return { ready: true };
  const key = auditCase.inputEnv as string;
  const value = env(key);
  if (!value || !value.trim()) {
    return {
      ready: false,
      reason: `未提供测试素材：设置环境变量 ${key} 后重跑（脚本刻意不预置违规/肖像/商标内容）`,
    };
  }
  return { ready: true };
}
