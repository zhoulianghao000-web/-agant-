import type {
  JobCreateRequest,
  PromptEnhanceRequest,
  PromptEnhanceResult,
  SkillRef,
  Visibility,
} from '@/shared/types/api';

/**
 * M1 技能体系的纯逻辑（与渲染无关，因此可以在 node 环境下被完整单测）。
 *
 * 为什么把这些从组件里抽出来：项目既有的测试约定是
 * `environment: 'node'`，只跑 `tests/` 下的单测文件（无 RTL / 无组件测试）。
 * 把「该不该发请求、请求体长什么样、响应如何落到快照」变成纯函数，
 * 就能在不引入 jsdom 的前提下锁住这几条最容易出错的规则。
 *
 * 这里承载的核心不变量：
 *   增强产生的提示词**必须与产出它的技能版本一同记录**。
 *   只存提示词而不存 `skillKey`/`skillVersion` 的话，技能改版后历史作品的
 *   「一键同款」会还原出与原作不同的提示词 —— 而且是静默的、最难排查的那类缺陷。
 */

/** chips 上「不使用技能」的哨兵值。用显式哨兵而不是 null，是为了让选中态可表达 */
export const NO_SKILL = 'none';

/** 待提交快照中与技能相关的部分 */
export interface PendingSnapshot {
  prompt: string;
  /** 产出当前提示词的技能；用户没选技能时为 null */
  skill: SkillRef | null;
  /**
   * 增强之后用户是否又手改过提示词。
   *
   * 这个标记是**归因数据的诚实性**所在：若把「增强后原样使用」与
   * 「增强后大改」混为一谈，「哪个技能真正带来产出」这个指标就没有意义了。
   */
  editedAfterEnhance: boolean;
}

export function emptySnapshot(): PendingSnapshot {
  return { prompt: '', skill: null, editedAfterEnhance: false };
}

export type EnhanceGuard = { ok: true } | { ok: false; reason: string };

/**
 * 提交前的本地校验。
 * 放在这里而不是只靠禁用按钮：按钮禁用状态在重构中很容易被漏掉，
 * 而这条校验是成本的最后一道闸（空输入也会真实消耗 LLM token）。
 */
export function canEnhance(input: {
  prompt: string;
  skillValue: string | null;
  busy: boolean;
}): EnhanceGuard {
  if (input.busy) return { ok: false, reason: '增强进行中，请等待当前请求返回' };
  if (!input.prompt.trim()) return { ok: false, reason: '请先输入想法，再使用技能增强' };
  if (input.skillValue === null) return { ok: false, reason: '请先选择一个技能' };
  return { ok: true };
}

/**
 * 构造增强请求体。
 * 选了「不使用技能」时**不传 skillKey**（而不是传哨兵值），
 * 让后端的「未知技能回落 generic」分支来处理 —— 契约里 skillKey 是可选的。
 */
export function buildEnhanceBody(
  prompt: string,
  skillValue: string | null,
  capability: 'txt2img' | 'img2video' = 'txt2img',
): PromptEnhanceRequest {
  const body: PromptEnhanceRequest = { rawPrompt: prompt.trim(), capability };
  if (skillValue && skillValue !== NO_SKILL) body.skillKey = skillValue;
  return body;
}

/**
 * 把增强结果落到待提交快照。
 *
 * `editedAfterEnhance` 在这里被**重置为 false** —— 因为这一刻提示词正是技能的产物。
 * 之后用户任何一次手改都会通过 `markEdited` 把它翻成 true。
 */
export function applyEnhance(result: PromptEnhanceResult): PendingSnapshot {
  return {
    prompt: result.enhanced,
    skill: { key: result.skillKey, version: result.skillVersion },
    editedAfterEnhance: false,
  };
}

/** 用户手改提示词。技能引用**保留**（归因仍成立），只把「已改动」标记翻起来 */
export function markEdited(snapshot: PendingSnapshot, nextPrompt: string): PendingSnapshot {
  return {
    prompt: nextPrompt,
    skill: snapshot.skill,
    editedAfterEnhance: snapshot.skill !== null,
  };
}

/**
 * 用户主动「还原」到增强前的原文：**技能引用必须同时作废**。
 *
 * 否则会出现「提示词是原文、来源却写着某技能」的谎报 ——
 * 这比没有溯源更糟：归因数据一旦有假的，整张能力贡献表都不可信。
 */
export function revertToRaw(raw: string): PendingSnapshot {
  return { prompt: raw, skill: null, editedAfterEnhance: false };
}

export interface SubmitContext {
  snapshot: PendingSnapshot;
  model: string;
  seed: number;
  aspect?: JobCreateRequest['params']['aspect'];
  visibility?: Visibility;
}

/**
 * 组装提交体（对应契约 `JobCreateRequest`）。
 *
 * ⚠️ 这里是与「一键同款可还原」直接相关的一步：
 * `skillKey` / `skillVersion` 必须随 `prompt` 一起提交，缺了它们，
 * 后端无从写入 `Job.skill`，历史作品就失去了能力归因与版本溯源。
 */
export function toJobCreateRequest(ctx: SubmitContext): JobCreateRequest {
  const prompt = ctx.snapshot.prompt.trim();
  if (!prompt) throw new Error('提示词不能为空');

  const request: JobCreateRequest = {
    model: ctx.model,
    params: {
      prompt,
      seed: ctx.seed,
      ...(ctx.aspect ? { aspect: ctx.aspect } : {}),
    },
    visibility: ctx.visibility ?? 'private',
  };

  const skill = ctx.snapshot.skill;
  if (skill?.key && typeof skill.version === 'number') {
    request.skillKey = skill.key;
    request.skillVersion = skill.version;
  }

  return request;
}
