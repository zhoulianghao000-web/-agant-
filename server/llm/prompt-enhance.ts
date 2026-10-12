/**
 * 提示词增强（技能体系）
 *
 * 这是 LLM 在本项目里**真正的用途**，而不是用来生成图片。
 *
 * 架构依据：三站逆向的结论是「即梦的『技能 chips 一键注入提示词』是当前门槛最低的创作入口」；
 * DR-002 又把营销能力下沉为 M1 的「场景模板包」。两者实现方式相同 ——
 * 一个**预置的系统提示词**，把用户的短句扩展成可生成的结构化提示词。
 *
 * 命名对齐（重要）：字段名一律跟随 `contracts/openapi.yaml` 的 `Skill` 实体 ——
 * `key: string` + `version: integer`。契约是唯一真源，**改 BFF 去对齐契约，
 * 而不是改契约去迁就 BFF**（契约背后还连着数据模型与 DDL）。
 *
 * 与 genSnapshot 的关系（关键，别搞错）：
 *   增强后的提示词进入 `Asset.genSnapshot.prompt`，而技能溯源记在
 *   `Job.skill` / `Asset.skill`（`SkillRef = { key, version }`），**不塞进 genSnapshot**
 *   —— genSnapshot 是不可变快照，技能引用是归因信息，两者职责不同。
 *   两者必须同时写入：只存增强后的提示词而不存 key+version 的话，
 *   技能改版后历史作品的「一键同款」会还原出与原作不同的提示词 —— 而且是静默的。
 *
 * 版本纪律：**技能只能新增版本，不能就地修改**。
 *   改文案就新建 `marketing@2`，把 `marketing@1` 冻在那儿。
 */

import type { LlmChatResult, LlmMessage, LlmUsage } from './types';
import { resolveLlm } from './openai-compatible';

export interface PromptSkill {
  /** 契约 `Skill.key` */
  key: string;
  /** 契约 `Skill.version`：整数、只增不改、历史作品引用固定版本 */
  version: number;
  name: string;
  /** 前端 chips 上的说明文案 */
  description: string;
  /** 注入的系统提示词。契约里对应 `Skill.promptTemplate`，但**不通过接口返回**（见 listSkills） */
  systemPrompt: string;
  /** 覆盖全局 maxTokens。推理模型下要留足思维链预算 */
  maxTokens?: number;
}

/** P0 只开两个：通用增强 + 营销物料（对应 DR-002 的场景包雏形） */
export const PROMPT_SKILLS: readonly PromptSkill[] = [
  {
    key: 'generic',
    version: 1,
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
    key: 'marketing',
    version: 1,
    name: '营销物料',
    description: '电商/投放用图：商品居中，四周预留文案版式',
    systemPrompt:
      '你是电商与投放物料的视觉提示词工程师。把用户的商品描述扩展成一句中文提示词，' +
      '必须覆盖：商品主体细节与材质、干净的背景或场景、商业布光、产品处于视觉中心、' +
      '画面四周预留文案排版空间、高清商业摄影质感。' +
      '硬性要求：只输出提示词本身；不要解释、不要分点、不要引号、不要换行、不要出现价格或促销文案本身。' +
      '长度控制在 60–120 字。',
    maxTokens: 2000,
  },
];

export function findSkill(skillKey?: string): PromptSkill {
  const found = PROMPT_SKILLS.find((s) => s.key === skillKey);
  // 未知技能回落到通用增强，而不是抛错打断创作 —— 技能 key 可能因前端缓存而过期
  return found ?? (PROMPT_SKILLS[0] as PromptSkill);
}

/**
 * 契约 `Skill` 的响应形态。**刻意不含 `promptTemplate`**：
 * 系统提示词是技能的价值所在，通过公开接口返回等于把技能包送人；
 * 契约里 `promptTemplate` 是可选字段，省略它是合法的。
 */
export interface SkillListItem {
  key: string;
  version: number;
  name: string;
  description: string;
}

export function listSkills(): { items: SkillListItem[] } {
  return {
    items: PROMPT_SKILLS.map((s) => ({
      key: s.key,
      version: s.version,
      name: s.name,
      description: s.description,
    })),
  };
}

export type EnhanceCapability = 'txt2img' | 'img2video';

export interface EnhanceInput {
  rawPrompt: string;
  skillKey?: string;
  capability?: EnhanceCapability;
}

export interface EnhanceResult {
  /** 增强后的提示词 —— 会写进 genSnapshot.prompt */
  enhanced: string;
  /** 原始输入，便于前端做「还原」与前后对比 */
  raw: string;
  /** 与 skillVersion 一起写入 Job.skill / Asset.skill，同款还原的前提 */
  skillKey: string;
  skillVersion: number;
  provider: string;
  model: string;
  usage: LlmUsage;
  elapsedMs: number;
  /** 思维链默认不返回：它可能含系统提示词原文，透传等于泄漏技能包内容 */
  reasoning?: string;
}

/** 增强输入过长时截断（防止用户把整篇文章贴进来把成本打飞） */
const MAX_INPUT_CHARS = 1500;

export async function enhancePrompt(
  input: EnhanceInput,
  options: { includeReasoning?: boolean } = {},
): Promise<EnhanceResult> {
  const raw = (input.rawPrompt ?? '').trim();
  if (!raw) {
    throw new Error('提示词不能为空');
  }

  const skill = findSkill(input.skillKey);
  const capabilityHint =
    input.capability === 'img2video'
      ? '目标产物是**视频**，提示词需体现运镜与动态（如缓慢推近、镜头环绕）。'
      : '目标产物是**图片**，提示词需体现瞬间定格与画面构图。';

  const llm = resolveLlm();
  const messages: LlmMessage[] = [
    { role: 'system', content: `${skill.systemPrompt}\n${capabilityHint}` },
    { role: 'user', content: raw.slice(0, MAX_INPUT_CHARS) },
  ];

  const result: LlmChatResult = await llm.chat(messages, { maxTokens: skill.maxTokens });

  return {
    enhanced: result.content,
    raw,
    skillKey: skill.key,
    skillVersion: skill.version,
    provider: llm.id,
    model: result.model,
    usage: result.usage,
    elapsedMs: result.elapsedMs,
    ...(options.includeReasoning ? { reasoning: result.reasoning } : {}),
  };
}
