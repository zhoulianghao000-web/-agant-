import { describe, expect, it } from 'vitest';
import { canReuseArtifact, canonical, diffSnapshot, snapshotHash } from '@/shared/lib/snapshot';

/**
 * 快照工具的单元测试。
 *
 * 这组用例直接对应调试台（p0-debug-console.html）的断言 A1「一键同款参数零丢失」，
 * 是 Sprint1 e2e 的单元级前置。
 */
describe('canonical / snapshotHash', () => {
  it('键序无关：对象键顺序不同但内容相同 → 哈希相同', () => {
    const a = { prompt: 'x', seed: 42, model: 'm' };
    const b = { model: 'm', seed: 42, prompt: 'x' };
    expect(canonical(a)).toBe(canonical(b));
    expect(snapshotHash(a)).toBe(snapshotHash(b));
  });

  it('嵌套对象与数组同样键序无关', () => {
    const a = { s: { z: 1, a: [3, 2, 1] }, k: 'v' };
    const b = { k: 'v', s: { a: [3, 2, 1], z: 1 } };
    expect(snapshotHash(a)).toBe(snapshotHash(b));
  });

  it('数组顺序有意义：顺序变化必须改变哈希', () => {
    expect(snapshotHash({ a: [1, 2] })).not.toBe(snapshotHash({ a: [2, 1] }));
  });

  it('任一字段变化都会改变哈希（含种子）', () => {
    const base = { prompt: 'x', seed: 42 };
    expect(snapshotHash(base)).not.toBe(snapshotHash({ ...base, seed: 43 }));
    expect(snapshotHash(base)).not.toBe(snapshotHash({ ...base, prompt: 'y' }));
  });

  it('哈希格式稳定，可用于跨端比对', () => {
    expect(snapshotHash({ a: 1 })).toMatch(/^fnv1a_[0-9a-f]{8}$/);
  });

  it('类型区分：字符串 "42" 与数字 42 不等价', () => {
    expect(snapshotHash({ seed: '42' })).not.toBe(snapshotHash({ seed: 42 }));
  });
});

describe('diffSnapshot / canReuseArtifact', () => {
  it('未改动时 diff 为空且可复用原产物', () => {
    const base = { prompt: 'x', seed: 42, aspect: '16:9' };
    const next = { aspect: '16:9', seed: 42, prompt: 'x' };
    expect(diffSnapshot(base, next)).toEqual([]);
    expect(canReuseArtifact(base, next)).toBe(true);
  });

  it('改动种子时能精确指出是哪一项', () => {
    const base = { prompt: 'x', seed: 42 };
    const next = { prompt: 'x', seed: 43 };
    expect(diffSnapshot(base, next)).toEqual([{ key: 'seed', from: 42, to: 43 }]);
    expect(canReuseArtifact(base, next)).toBe(false);
  });

  it('新增与删除字段都算改动', () => {
    expect(diffSnapshot({ a: 1 }, { a: 1, b: 2 }).map((d) => d.key)).toEqual(['b']);
    expect(diffSnapshot({ a: 1, b: 2 }, { a: 1 }).map((d) => d.key)).toEqual(['b']);
  });
});
