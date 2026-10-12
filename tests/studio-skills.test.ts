import { describe, expect, it } from 'vitest';
import {
  NO_SKILL,
  applyEnhance,
  buildEnhanceBody,
  canEnhance,
  emptySnapshot,
  markEdited,
  revertToRaw,
  toJobCreateRequest,
} from '@/features/studio/skills';
import type { PromptEnhanceResult } from '@/shared/types/api';

/**
 * 技能体系的纯逻辑测试。
 *
 * 项目既有的测试约定是 node 环境，只跑 `tests/` 下的单测文件（无 jsdom / 无 RTL），
 * 所以「点击 chips 会怎样」这层交互无法在这里测 —— 那部分交给浏览器实测。
 * 这里锁的是**发请求的规则**与**落快照的规则**，因为它们决定成本与可还原性。
 */

const enhanceResult: PromptEnhanceResult = {
  enhanced: '一只橘猫在午后阳光下跃起扑蝶的瞬间，毛发纤毫毕现，超写实摄影风格，8K 画质。',
  raw: '一只猫',
  skillKey: 'generic',
  skillVersion: 1,
  provider: 'deepseek',
  model: 'deepseek-flash',
  elapsedMs: 2210,
  usage: { promptTokens: 129, completionTokens: 334, reasoningTokens: 263, totalTokens: 463 },
};

describe('canEnhance · 发请求前的本地闸门', () => {
  it('输入为空时拒绝 —— 空输入也会真实消耗 token', () => {
    const r = canEnhance({ prompt: '   ', skillValue: 'generic', busy: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('输入');
  });

  it('未选技能时拒绝', () => {
    const r = canEnhance({ prompt: '一只猫', skillValue: null, busy: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('技能');
  });

  it('请求进行中时拒绝重复提交（防连点把成本翻倍）', () => {
    const r = canEnhance({ prompt: '一只猫', skillValue: 'generic', busy: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('进行中');
  });

  it('条件齐备时放行', () => {
    expect(canEnhance({ prompt: '一只猫', skillValue: 'generic', busy: false }).ok).toBe(true);
  });
});

describe('buildEnhanceBody · 请求体', () => {
  it('选「不使用技能」时不传 skillKey，交给后端回落 generic', () => {
    const body = buildEnhanceBody('一只猫', NO_SKILL);
    expect(body.skillKey).toBeUndefined();
    expect('skillKey' in body).toBe(false);
  });

  it('选了技能时原样传递 key', () => {
    expect(buildEnhanceBody('一只猫', 'marketing').skillKey).toBe('marketing');
  });

  it('提示词两侧空白被去掉', () => {
    expect(buildEnhanceBody('  一只猫  ', 'generic').rawPrompt).toBe('一只猫');
  });
});

describe('applyEnhance · 落到待提交快照', () => {
  it('提示词被替换，且技能版本被记录', () => {
    const next = applyEnhance(enhanceResult);
    expect(next.prompt).toBe(enhanceResult.enhanced);
    expect(next.skill).toEqual({ key: 'generic', version: 1 });
  });

  it('刚增强完标记为「未被手改」—— 此刻提示词正是技能的产物', () => {
    expect(applyEnhance(enhanceResult).editedAfterEnhance).toBe(false);
  });
});

describe('markEdited · 手改后的归因诚实性', () => {
  it('手改后保留技能引用（归因仍成立），但把「已改动」翻起来', () => {
    // 这条是归因指标的诚实性所在：把「原样使用」与「增强后大改」混为一谈，
    // 「哪个技能真正带来产出」这个指标就没有意义了。
    const after = markEdited(applyEnhance(enhanceResult), '我自己改的提示词');
    expect(after.prompt).toBe('我自己改的提示词');
    expect(after.skill).toEqual({ key: 'generic', version: 1 });
    expect(after.editedAfterEnhance).toBe(true);
  });

  it('从未使用技能时，手改不会凭空产生技能来源', () => {
    const after = markEdited(emptySnapshot(), '手写的提示词');
    expect(after.skill).toBeNull();
    expect(after.editedAfterEnhance).toBe(false);
  });
});

describe('revertToRaw · 还原必须同时作废技能来源', () => {
  it('先增强再还原：技能引用被清空，而不是留下来谎报来源', () => {
    const enhanced = applyEnhance(enhanceResult);
    expect(enhanced.skill).not.toBeNull(); // 先确认此时确实有技能来源

    // 还原用的是「增强前的原文」，它由响应体携带、由页面单独持有，
    // 而不是存在快照里（快照只关心当前提示词与它的来源）
    const reverted = revertToRaw(enhanceResult.raw);
    expect(reverted.prompt).toBe('一只猫');
    expect(reverted.skill).toBeNull(); // 关键：来源必须一起作废
    expect(reverted.editedAfterEnhance).toBe(false);
  });
});

describe('toJobCreateRequest · 提交体必须带上技能版本', () => {
  it('有技能时 skillKey 与 skillVersion 同时出现（同款还原的前提）', () => {
    const body = toJobCreateRequest({
      snapshot: applyEnhance(enhanceResult),
      model: 'txt2img-p0',
      seed: 42,
      aspect: '16:9',
    });
    expect(body.skillKey).toBe('generic');
    expect(body.skillVersion).toBe(1);
    expect(body.params.prompt).toBe(enhanceResult.enhanced);
    expect(body.model).toBe('txt2img-p0');
  });

  it('无技能时两个字段都不出现（而不是出现空值）', () => {
    const body = toJobCreateRequest({
      snapshot: { prompt: '手写的', skill: null, editedAfterEnhance: false },
      model: 'txt2img-p0',
      seed: 1,
    });
    expect('skillKey' in body).toBe(false);
    expect('skillVersion' in body).toBe(false);
  });

  it('技能引用不完整时（只有 key 没有 version）不提交半个技能', () => {
    // 半个技能比没有更糟：后端会以为有溯源，实际版本缺失
    const body = toJobCreateRequest({
      snapshot: { prompt: 'x', skill: { key: 'generic' }, editedAfterEnhance: false },
      model: 'txt2img-p0',
      seed: 1,
    });
    expect('skillKey' in body).toBe(false);
  });

  it('空提示词直接抛错，不产生一个必然失败的任务', () => {
    expect(() =>
      toJobCreateRequest({ snapshot: emptySnapshot(), model: 'txt2img-p0', seed: 1 }),
    ).toThrowError(/不能为空/);
  });

  it('可见性默认 private —— 公开是要用户显式动作的', () => {
    const body = toJobCreateRequest({ snapshot: { prompt: 'x', skill: null, editedAfterEnhance: false }, model: 'm', seed: 1 });
    expect(body.visibility).toBe('private');
  });

  it('未指定比例时不写入 aspect，避免用默认值覆盖用户选择', () => {
    const body = toJobCreateRequest({ snapshot: { prompt: 'x', skill: null, editedAfterEnhance: false }, model: 'm', seed: 1 });
    expect('aspect' in body.params).toBe(false);
  });
});
