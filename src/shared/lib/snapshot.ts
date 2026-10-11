/**
 * 快照比对（对应架构设计 v1.1 · B6.1 一键同款）
 *
 * 用途：判定用户是否真的改过参数。
 *   - hash 相同 → 未改参数 → 直接复用原产物（零等待、零积分）
 *   - hash 不同 → 重新生成，并在提交前提示「结果将与原作品存在差异」
 *
 * 关键约束：哈希必须**键序无关**。JSON.stringify 的结果依赖对象键的插入顺序，
 * 直接用它做哈希会导致「同样的参数被判定为改动」，进而让一键同款永远无法命中复用。
 * 本模块与调试台（p0-debug-console.html 的 canonical()）使用同一算法。
 */

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** 稳定序列化：对象按键名字典序排列，其余类型按 JSON 规则 */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const body = Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
    .join(',');
  return `{${body}}`;
}

/**
 * 快照哈希。使用 FNV-1a（非加密用途，只需稳定与快速）。
 * 选它而不是 SHA-256 的理由：这是热路径（每次参数改动都要重算），
 * 且碰撞后果仅是「该次同款少生成一次」，代价可接受。
 */
export function snapshotHash(snapshot: unknown): string {
  const text = canonical(snapshot);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `fnv1a_${(h >>> 0).toString(16).padStart(8, '0')}`;
}

export interface SnapshotDiff {
  key: string;
  from: unknown;
  to: unknown;
}

/** 逐字段差异，用于在 UI 上告诉用户「你改了哪几项」 */
export function diffSnapshot(base: Record<string, unknown>, next: Record<string, unknown>): SnapshotDiff[] {
  const keys = Array.from(new Set([...Object.keys(base), ...Object.keys(next)])).sort();
  const out: SnapshotDiff[] = [];
  for (const key of keys) {
    if (canonical(base[key]) !== canonical(next[key])) {
      out.push({ key, from: base[key] as Json, to: next[key] as Json });
    }
  }
  return out;
}

/** 是否可复用原产物：快照完全一致 */
export function canReuseArtifact(base: unknown, next: unknown): boolean {
  return canonical(base) === canonical(next);
}
