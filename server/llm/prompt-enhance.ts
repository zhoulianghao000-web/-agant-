/**
 * 提示词增强（Skill 体系）
 *
 * 这是 LLM Key 在本项目里**真正的用途**，而不是用来生成图片。
 *
 * 架构依据：三站逆向的结论是「即梦的『技能 chips 一键注入提示词』是当前门槛最低的创作入口」；
 * 而 DR-002 把营销能力下沉为 M1 的「场景模板包」。这两件事的实现方式相同 ——
 * 一个**预置的系统提示词 + 参数结构**，把用户的短句扩展成可生成的结构化提示词。
 *
 * 与 genSnapshot 的关系（关键，别搞错）：
 *   增强后的提示词会进入 `Asset.genSnapshot.prompt`，因此必须同时记录
 *   `skillId + skillVersion`（架构 §3.1 的要求）。否则技能改版后，
 *   历史作品的「一键同款」会还原出一个与原作不同的提示词 —— 而且是静默的。
 *
 * 版本纪律：**技能只能新增版本，不能就地修改**。
 *   改文案就新建 `marketing@2`，把 `marketing@1` 冻在那儿。就地改会让上述溯源失效。
 */

import type { LlmChatResult, LlmMessage, LlmUsage } from './types';
import { resolveLlm } from './deepseek';

export interface PromptSkill {
  id: string;
  /** 只增不改；改内容必须新版本 */
  version: string;
  name: string;
  description: string;
  systemPrompt: string;
  /** 覆盖全局 maxTokens。推理模型下要留足思维链预算 */
  maxTokens?: number;
}

/** P0 只开两个：通用增强 + 营销物料（对应 DR-002 的场景包雏形） */
export const PROMPT_SKILLS: readonly PromptSkill[] = [
  {
    id: 'generic',
    version: '1',
    name: '通用增强',
    description: '把简短描述扩展成结构完整的生成提示词',
    systemPrompt:
      '你是文生图/图生视频的提示词工程师。把用户的简短描述扩展成一句结构完整的中文提示词，' +
      '必须覆盖：主体细节、风格、光线、构图、画质。' +
      '硬性要求：只输出提示词本身；不要解释、不要分点、不要引号、不要换行、不要任何前缀。' +
      '长度控制在 60–120 字。',
    maxTokens: 2000,
  },
  {
    id: 'marketing',
    version: '1',
    name: '营销物料',
    description: '电商/投放用图的提示词结构（商品为视觉中心，预留文案版式）',
    systemPrompt:
      '你是电商与投放物料的视觉提示词工程师。把用户的商品描述扩展成一句中文提示词，' +
      '必须覆盖：商品主体细节与材质、干净的背景或场景、商业布光、产品处于视觉中心、' +
      '画面四周预留文案排版空间、高清商业摄影质感。' +
      '硬性要求：只输出提示词本身；不要解释、不要分点、不要引号、不要换行、不要出现价格或促销文案本身。' +
      '长度控制在 60–120 字。',
    maxTokens: 2000,
  },
];

export function findSkill(skillId: string): PromptSkill {
  const found = PROMPT_SKILLS.find((s) => s.id === skillId);
  return found ?? (PROMPT_SKILLS[0] as PromptSkill);
}

export type EnhanceCapability = 'txt2img' | 'img2video';

export interface EnhanceInput {
  rawPrompt: string;
  skillId?: string;
  capability?: EnhanceCapability;
  language?: 'zh' | 'en';
}

export interface EnhanceResult {
  /** 增强后的提示词 —— 会写进 genSnapshot.prompt */
  enhanced: string;
  /** 原始输入，便于前端做「还原」与前后对比 */
  raw: string;
  skillId: string;
  skillVersion: string;
  usage: LlmUsage;
  model: string;
  elapsedMs: number;
  /** 思维链默认不返回，仅在调试时置 true */
  reasoning?: string;
}

/** 增强提示词过长时截断（防止用户把整篇文章贴进来把成本打飞） */
const MAX_INPUT_CHARS = 1500;

export async function enhancePrompt(
  input: EnhanceInput,
  options: { includeReasoning?: boolean } = {},
): Promise<EnhanceResult> {
  const raw = (input.rawPrompt ?? '').trim();
  if (!raw) {
    throw new Error('提示词不能为空');
  }

  const skill = findSkill(input.skillId ?? 'generic');
  const capabilityHint =
    input.capability === 'img2video'
      ? '目标产物是**视频**，提示词需体现运镜与动态（如缓慢推近、镜头环绕）。'
      : '目标产物是**图片**，提示词需体现瞬间定格与画面构图。';

  const messages: LlmMessage[] = [
    { role: 'system', content: `${skill.systemPrompt}\n${capabilityHint}` },
    { role: 'user', content: raw.slice(0, MAX_INPUT_CHARS) },
  ];

  const result: LlmChatResult = await resolveLlm().chat(messages, { maxTokens: skill.maxTokens });

  return {
    enhanced: result.content,
    raw,
    skillId: skill.id,
    skillVersion: skill.version,
    usage: result.usage,
    model: result.model,
    elapsedMs: result.elapsedMs,
    ...(options.includeReasoning ? { reasoning: result.reasoning } : {}),
  };
}
