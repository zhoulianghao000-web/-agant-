import { describe, expect, it } from 'vitest';
import { createIdempotencySlot, newIdempotencyKey } from '@/shared/lib/idempotency';

/**
 * 幂等键语义测试。
 *
 * 为什么值得写测试：重试若换了键，在积分模型下等于**重复扣费并重复生成**，
 * 而这个缺陷在 UI 上完全不可见 —— 只能靠这条语义被固定下来。
 */
describe('newIdempotencyKey', () => {
  it('格式可辨识且互不相同', () => {
    const keys = new Set(Array.from({ length: 200 }, () => newIdempotencyKey()));
    expect(keys.size).toBe(200);
    for (const k of keys) expect(k).toMatch(/^idem_/);
  });

  it('长度不超过契约限制（64 字符）', () => {
    expect(newIdempotencyKey().length).toBeLessThanOrEqual(64);
  });
});

describe('createIdempotencySlot', () => {
  it('重复 get() 返回同一个键 —— 重试不会变成两次生成', () => {
    const slot = createIdempotencySlot();
    expect(slot.get()).toBe(slot.get());
  });

  it('reset() 后换新键 —— 用户改参数后是新意图', () => {
    const slot = createIdempotencySlot();
    const before = slot.get();
    slot.reset();
    const after = slot.get();
    expect(after).not.toBe(before);
    expect(slot.get()).toBe(after);
  });
});
